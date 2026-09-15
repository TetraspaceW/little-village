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
   file at that point, fetched by js/game.js's openLibrary() the same
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

/* Finds the first element matching openTagRegex (which must match just
   an opening tag, e.g. /<div[^>]*\bclass="main_text"[^>]*>/) and returns
   its full extent by *balanced* nested-tag counting, not a plain regex.
   A naive non-greedy match to "the next </div>" is wrong for a div
   almost by definition (divs nest) -- it can close on some unrelated
   div partway into the real content and silently discard the rest,
   which an earlier version of this file did to most of a book before
   this fix. Returns null if the open tag isn't found or never balances. */
function findBalanced(html, openTagRegex, tagName) {
  const m = openTagRegex.exec(html);
  if (!m) return null;
  const scan = new RegExp('<' + tagName + '\\b[^>]*>|</' + tagName + '\\s*>', 'gi');
  scan.lastIndex = m.index + m[0].length;
  let depth = 1, mm;
  while ((mm = scan.exec(html))) {
    if (mm[0][1] === '/') {
      depth--;
      if (depth === 0) {
        return { outerStart: m.index, outerEnd: mm.index + mm[0].length,
                 innerStart: m.index + m[0].length, innerEnd: mm.index };
      }
    } else depth++;
  }
  return null;
}

/* Keeps only the inside of the matched element, discarding everything
   else in the document -- for a source where the real text lives in one
   reliably-named container and everything outside it is chrome (see
   prp-pages-output and main_text below). Returns null (not the original
   html) when the container isn't found, so callers can fall back
   explicitly rather than silently keeping unwanted chrome. */
function extractOnly(html, openTagRegex, tagName) {
  const r = findBalanced(html, openTagRegex, tagName);
  return r ? html.slice(r.innerStart, r.innerEnd) : null;
}

/* The opposite: cuts the matched element out, keeping the rest -- for a
   source with no single "just the content" container, where a specific
   chrome element (the header nav box) has to be identified and removed
   instead. Returns html unchanged if not found. */
function removeBalanced(html, openTagRegex, tagName) {
  const r = findBalanced(html, openTagRegex, tagName);
  return r ? html.slice(0, r.outerStart) + html.slice(r.outerEnd) : html;
}

/* Same, but removes every match rather than just the first -- for chrome
   that can appear more than once per page (a "[edit]" link sits next to
   every heading, not just one). */
function removeAllBalanced(html, openTagRegex, tagName) {
  let out = html;
  for (let guard = 0; guard < 1000; guard++) {
    const next = removeBalanced(out, openTagRegex, tagName);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/* Turns a cleaned-up HTML fragment into plain paragraphs. Not a general
   HTML renderer: just enough to turn a Wikisource or Aozora fragment
   into readable prose. Assumes the caller has already dealt with
   anything that needs balanced-tag awareness (see findBalanced above);
   what's left here -- <table>, <sup>, <span> -- doesn't nest in this
   content, so a plain non-greedy match is safe. <style>/<script> are
   cut wholesale first because their content isn't inside a tag a plain
   tag-strip would remove. */
function htmlToText(html) {
  html = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  // <span class="mw-editsection">, the "[edit]" link next to every
  // heading, turns out to nest further spans inside itself
  // (mw-editsection-bracket around each bracket, another span around
  // the link text) -- a plain non-greedy match closed on that first
  // inner </span> and left "edit]" sitting in the output as text. Both
  // this and the wsbox edition-list table are removed with balanced
  // matching now rather than trusting that they don't nest.
  html = removeAllBalanced(html, /<span[^>]*\bclass="[^"]*\bmw-editsection\b[^"]*"[^>]*>/i, 'span');
  html = removeAllBalanced(html, /<table[^>]*\bclass="[^"]*\bwsbox\b[^"]*"[^>]*>/i, 'table');
  html = removeAllBalanced(html, /<sup[^>]*\bclass="[^"]*\breference\b[^"]*"[^>]*>/i, 'sup');
  return html
    .replace(/<(?:p|br|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/[​‎‏]/g, '') // zero-width space/LTR/RTL marks -- invisible, but not whitespace, so left short "words" glued together if not stripped
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n\n');
}

/* One Wikisource page, rendered and cleaned. Uses the `parse` API (not
   raw wikitext, and not the `extracts` API) because this is the only
   one of the three that actually expands a ProofreadPage transclusion
   -- a scanned book's real text lives on Page: subpages and only shows
   up on the page you'd read once something has transcluded it in.

   Two shapes of page turn up among our sources, and get cleaned
   differently:

   - A page transcluding a scanned book via ProofreadPage (zh's Ah Q,
     transcluded from a scanned Complete Works volume) wraps just that
     text in a div class="prp-pages-output" -- title, edition table,
     license badge and categories all sit outside it. When present,
     that div's content IS the book: keep only it and throw away
     everything else wholesale, rather than trying to identify and
     strip each piece of chrome one at a time.

   - A plain wikitext page (ru's chapters, ar's) has no such wrapper --
     someone typed the prose directly into the page, chrome and all, so
     there's no single container to extract. Remove what's identifiable
     (the title/prev-next header box) and cut the rest off at the first
     second-level heading: real narrative prose here never has one of
     its own, so the first `==Heading==` reliably marks a "Notes" /
     "References" section (Cite's <div class="mw-heading">, a MediaWiki
     class name, the same in every language) rather than more story. */
async function fetchWikisourcePage(site, title) {
  const api = 'https://' + site + '.wikisource.org/w/api.php?action=parse&format=json&prop=text&page=' +
              encodeURIComponent(title);
  const buf = await fetchRaw(api);
  const data = JSON.parse(buf.toString('utf8'));
  if (data.error) throw new Error(site + '.wikisource.org "' + title + '": ' + data.error.info);
  let html = data.parse.text['*'];
  const onlyContent = extractOnly(html, /<div[^>]*\bclass="[^"]*\bprp-pages-output\b[^"]*"[^>]*>/i, 'div');
  if (onlyContent !== null) {
    html = onlyContent;
  } else {
    // The id varies by which header template a page uses ("headertemplate"
    // for ru/ar's individual-work pages, "headerContainer" seen
    // elsewhere) -- matched loosely rather than enumerating every one.
    html = removeBalanced(html, /<div[^>]*\bid="[^"]*header[^"]*"[^>]*>/i, 'div');
    const headingIdx = html.search(/<div[^>]*\bclass="[^"]*\bmw-heading\b/i);
    if (headingIdx !== -1) html = html.slice(0, headingIdx);
  }
  return htmlToText(html);
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
   Shift_JIS; no dependency needed) before stripping tags. Aozora's own
   template wraps just the story in <div class="main_text">, with the
   title-page metadata before it and a bibliographic/proofreading
   colophon after -- same "keep only the real container" approach as
   Wikisource's prp-pages-output above, and for the same reason: without
   it, "picking up the book" would come with someone's transcription
   credits stapled to the last page. */
async function fetchAozora(url) {
  const buf = await fetchRaw(url);
  const html = new TextDecoder('shift_jis').decode(buf);
  const onlyContent = extractOnly(html, /<div[^>]*\bclass="main_text"[^>]*>/i, 'div');
  return htmlToText(onlyContent !== null ? onlyContent : html);
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

/* Gutenberg's plain-text files are hard-wrapped to a fixed column width
   (~70-72 chars), with a blank line marking a real paragraph break --
   the single newlines in between are just where the source happened to
   wrap, not paragraph structure. The reading panel uses white-space:
   pre-wrap so a Wikisource-derived book's real paragraph breaks show up
   correctly; the same CSS then also honors these purely typographic
   ones literally, rendering a wall of short, choppy lines at the
   original fixed width instead of one flowing paragraph. Reflowing here
   -- join the lines inside each paragraph, keep the blank-line breaks
   between paragraphs -- makes it read like an actual page, sized to the
   reading pane, not a dump of a fixed-width terminal.

   Not run over verse (see the pl entry's `verse: true` in tools/books.js
   -- Pan Tadeusz's line breaks are the poem's real line breaks, not
   word-wrap, and joining them would be actively wrong, not just messy). */
function reflow(text) {
  return text.split(/\n{2,}/)
    .map(para => para.split('\n').map(l => l.trim()).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function buildOne(lang, src) {
  process.stdout.write('  ' + lang + '  fetching ' + src.title + '... ');
  let text;
  if (src.kind === 'gutenberg') {
    text = await fetchGutenberg(src.url);
    if (!src.verse) text = reflow(text);
  }
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
