#!/usr/bin/env node
/* tools/build-books.js — fetches each language's full book (tools/books.js)
   and writes books/<lang>.json into the repo.

   This is a developer-run build step, not something the game or its
   server does. Run it by hand whenever tools/books.js changes:

     node tools/build-books.js          # every configured language
     node tools/build-books.js zh ru    # just these

   Why a build step rather than fetching live: the sources here (Project
   Gutenberg, Wikisource, Aozora Bunko) mostly don't send CORS headers a
   browser page would need, so the game can't fetch them itself -- some
   proxy has to. An earlier version of this feature made that proxy
   *live*, fetching (and caching) on a player's first request via a
   route in tools/logserver.js. That only works when the game is served
   by that Node process, so it quietly did nothing on a plain static
   host -- see the project's actual deploy,
   https://tetraspacew.github.io/little-village, which has no server at
   all. Doing the fetch once here instead, and checking in the result,
   means the feature works identically there, under logserver.js, or
   under `python3 -m http.server`: books/<lang>.json is just a static
   file at that point, fetched by js/game.js's openFullBook() the same
   way it'd fetch anything else in the repo, lazily, only for the
   language actually being played.

   No npm dependencies (this project has none) -- only what Node ships
   with, including a full-ICU TextDecoder that already understands
   Shift_JIS (see fetchAozora below) without pulling in iconv-lite. */
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
const { URL } = require('url');
const SOURCES = require('./books.js');

const OUT_DIR = path.join(__dirname, '..', 'books');

/* Fetches a url's raw bytes, following redirects (Gutenberg and
   Wikisource both commonly issue one). Returns a Buffer, not a string --
   callers decide the encoding, which matters for fetchAozora below. */
function fetchRaw(url, redirectsLeft) {
  redirectsLeft = redirectsLeft === undefined ? 5 : redirectsLeft;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(url, {
      headers: { 'user-agent': 'little-village-book-build/1.0 (one-time offline build step; +https://github.com/TetraspaceW/little-village)' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects: ' + url)); return; }
        fetchRaw(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timed out: ' + url)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Strips MediaWiki's own rendered HTML (from the `parse` API -- see
   fetchWikisourcePage) down to plain paragraphs. Not a general HTML
   renderer: just enough to turn one Wikisource page into readable
   prose, dropping the chrome every page carries (the prev/next header
   table, edit-section links, footnotes, categories -- none of it is the
   book) rather than leaving it as visible junk text. <style>/<script>
   are cut wholesale first because their content isn't inside a tag a
   plain tag-strip would remove. */
function htmlToText(html) {
  // <table>...</table> and <sup>...</sup> don't nest in MediaWiki's own
  // output, so a non-greedy match to the *next* closing tag is safe for
  // those. A <div>, on the other hand, almost always contains other
  // <div>s -- matching "up to the next </div>" for the header/footer
  // chrome divs below would (and, before this comment, did) close on
  // some unrelated nested </div> partway through the actual chapter,
  // silently eating most of the book. So this only strips div-based
  // chrome by dropping the *opening* tag (turning it into ordinary
  // untagged content) rather than trying to match its extent -- a
  // little chrome text (nav arrows, a license notice) ends up mixed
  // into the output, which is a minor cosmetic cost next to the
  // alternative of a regex that can silently truncate the book.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<table[^>]*\bclass="[^"]*\bwsbox[^"]*"[^>]*>[\s\S]*?<\/table>/gi, '')
    .replace(/<span[^>]*\bclass="mw-editsection"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<sup[^>]*\bclass="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<(?:p|br|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n\n');
}

/* One Wikisource page, rendered and cleaned. Uses the `parse` API (not
   raw wikitext, and not the `extracts` API) because this is the only
   one of the three that actually expands a ProofreadPage transclusion
   -- a scanned book's real text lives on Page: subpages and only shows
   up on the page you'd read once something has transcluded it in. */
async function fetchWikisourcePage(site, title) {
  const api = 'https://' + site + '.wikisource.org/w/api.php?action=parse&format=json&prop=text&page=' +
              encodeURIComponent(title);
  const buf = await fetchRaw(api);
  const data = JSON.parse(buf.toString('utf8'));
  if (data.error) throw new Error(site + '.wikisource.org "' + title + '": ' + data.error.info);
  return htmlToText(data.parse.text['*']);
}

async function fetchWikisourceBook(site, pages) {
  const parts = [];
  for (const title of pages) {
    parts.push(await fetchWikisourcePage(site, title));
    await sleep(250); // a free service; don't hammer it just because we can
  }
  return parts.join('\n\n');
}

/* Aozora Bunko's HTML files are Shift_JIS with no charset anywhere in
   the response -- fetchRaw hands back bytes for exactly this reason, so
   this can decode them correctly (Node's TextDecoder already knows
   Shift_JIS; no dependency needed) before stripping tags the same way
   as a Wikisource page. */
async function fetchAozora(url) {
  const buf = await fetchRaw(url);
  const html = new TextDecoder('shift_jis').decode(buf);
  return htmlToText(html);
}

/* Every Gutenberg text is wrapped in the same boilerplate: a standard
   licensing preamble before "*** START OF THE PROJECT GUTENBERG EBOOK
   ... ***" and a much longer standard license after the matching END
   marker. Neither is part of the book -- trimmed the same way a person
   copying the text by hand would, rather than shipping several
   kilobytes of legalese a player has to scroll past to reach page one. */
async function fetchGutenberg(url) {
  const buf = await fetchRaw(url);
  let text = buf.toString('utf8');
  // End trimmed first, then start, so each search runs against the
  // current text rather than an offset computed before the other slice.
  // Two eras of Gutenberg header/footer exist: the modern "*** END OF
  // THE PROJECT GUTENBERG EBOOK ***" banner, and an older, plainer
  // "End of Project Gutenberg's <title>, by <author>" closing line with
  // no banner at all (Pan Tadeusz and Lettres de mon moulin both still
  // carry this older style even though they were re-transcribed since).
  const end = text.search(/\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK|^End of (?:the |)Project Gutenberg('|’)s? /im);
  if (end !== -1) text = text.slice(0, text.lastIndexOf('\n', end));
  const start = text.search(/\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  if (start !== -1) text = text.slice(text.indexOf('\n', start) + 1);
  // The older header style also has no start banner at all -- just a
  // transcribers' credit line ("Produced by ...") running straight into
  // the title page. Cut it up to the first run of blank lines, same as
  // a reader skipping past it by eye.
  text = text.replace(/^\s*Produced by[\s\S]*?\n(?:[ \t]*\r?\n)+/i, '');
  return text.trim();
}

async function buildOne(lang, src) {
  process.stdout.write('  ' + lang + '  fetching ' + src.title + '... ');
  let text;
  if (src.kind === 'gutenberg') text = await fetchGutenberg(src.url);
  else if (src.kind === 'wikisource') text = await fetchWikisourceBook(src.site, src.pages);
  else if (src.kind === 'aozora') text = await fetchAozora(src.url);
  else throw new Error('unknown kind: ' + src.kind);
  if (!text || text.length < 200) throw new Error('suspiciously short (' + (text || '').length + ' chars) -- probably not the real text');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, lang + '.json');
  fs.writeFileSync(outFile, JSON.stringify({ title: src.title, titleEn: src.titleEn, author: src.author, text }, null, 1));
  console.log(text.length + ' chars → ' + path.relative(process.cwd(), outFile));
}

async function main() {
  const only = process.argv.slice(2);
  const langs = only.length ? only : Object.keys(SOURCES);
  console.log('Building ' + langs.length + ' book(s)...');
  let failed = 0;
  for (const lang of langs) {
    const src = SOURCES[lang];
    if (!src) { console.log('  ' + lang + '  no source configured, skipping'); continue; }
    try { await buildOne(lang, src); }
    catch (e) { console.log('FAILED: ' + e.message); failed++; }
  }
  if (failed) { console.log(failed + ' book(s) failed.'); process.exitCode = 1; }
}

main();
