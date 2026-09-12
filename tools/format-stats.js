#!/usr/bin/env node
/* format-stats.js — reports how often each model's replies need
   correction ("miss the happy path").

   Every API call the game makes is logged to logs/*.jsonl (see
   js/llm.js's `record`), including the system prompt, messages, and the
   raw reply before any parsing/repair. This script doesn't call any
   model itself; it re-runs the same checks the game applies at runtime
   against that logged raw text — `parseJSON`'s repair ladder,
   `looksEnglish`, `needsFurigana`, the fuzzy place-name matching in
   `decideWhereToGo` — and counts how often each one actually had to
   correct something.

   "Happy path" means: the JSON parsed correctly on the first plain
   attempt, with every field the prompt requested present and
   correctly formatted. Anything else (a repaired quote, an empty roman
   field, unglossed kanji, a "go" naming no real place) is a case the
   game had to work around — the same cases that would otherwise
   require a second helper-model call, or show the player a broken reply.

       node tools/format-stats.js                  # every logs/*.jsonl
       node tools/format-stats.js logs/foo.jsonl    # just this one (or several)

   This script is read-only -- it doesn't affect game behavior. */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------- ported checks

   These functions are copied here, not imported — the game's own
   source files assume a browser environment (window.LG, DOM globals),
   and setting up a `vm` context under Node just to reuse a few regexes
   isn't worth the overhead tests/smoke.js already pays for elsewhere.
   Keep these manually in sync with js/llm.js and js/dialogue.js — if
   they drift, this report becomes inaccurate, but the game itself is
   unaffected either way. */

const FIELDS = 'say|translation|roman|ruby|understood|remember|action|revealed';

function repairJSON(t) {
  return t
    .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)[“”]', 'g'), '$1"')
    .replace(/[“”](\s*[,}])/g, '"$1')
    .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)(?=[^"\\[{\\s\\dtfn-])', 'g'), '$1"')
    .replace(/,(\s*[}\]])/g, '$1');
}

function extractObject(t) {
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}

function salvage(text) {
  const out = {};
  ['say', 'translation', 'roman', 'ruby', 'understood', 'action'].forEach(k => {
    const re = new RegExp('"' + k + '"\\s*:\\s*"?([\\s\\S]*?)"?\\s*(?=,\\s*"(?:' + FIELDS +
      ')"\\s*:|\\}|$)');
    const m = text.match(re);
    if (m && m[1]) out[k] = m[1].replace(/^"|"$/g, '').trim();
  });
  return out.say ? out : null;
}

/* Unlike LG.llm.parseJSON, this reports *which* repair step succeeded
   — that's the whole point of this script. `happy` corresponds to what
   parseJSON returns on its first, unrepaired attempt. */
function classifyReply(rawText) {
  if (!rawText) return { level: 'empty', obj: null };
  let t = String(rawText).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const repaired = repairJSON(t);
  const candidates = [[t, 'happy'], [repaired, 'repaired']];
  for (const [cand, levelIfPlain] of candidates) {
    const chunk = extractObject(cand);
    if (!chunk) continue;
    try { return { level: levelIfPlain, obj: JSON.parse(chunk) }; } catch (e) {}
    try { return { level: 'repaired', obj: JSON.parse(repairJSON(chunk)) }; } catch (e) {}
  }
  const salvaged = salvage(repaired) || salvage(t);
  return salvaged ? { level: 'salvaged', obj: salvaged } : { level: 'failed', obj: null };
}

// js/dialogue.js's furigana machinery
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function stripRuby(html) {
  return String(html)
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
    .replace(/<rtc\b[^>]*>[\s\S]*?<\/rtc>/gi, '')
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
    .replace(/<\/?(?:ruby|rb|rt|rtc|rp)\b[^>]*>/gi, '');
}
function normText(str) {
  let t = String(str);
  try { t = t.normalize('NFKC'); } catch (e) {}
  return t.replace(/\s/g, '');
}
function rubyMatches(ruby, say) {
  if (!ruby) return false;
  return normText(stripRuby(ruby)) === normText(say);
}
const KANJI_RUN = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3005\\u3007\\u30f6]';
const KANA_RUN = '[\\u3040-\\u309f\\u30a0-\\u30ff\\u30fc]';
const BRACKETED = new RegExp(
  '(' + KANJI_RUN + '+)' + '([\\u3040-\\u309f]{0,3})' +
  '\\s*[\\[\\uff3b(\\uff08\\u3010]' + '(' + KANA_RUN + '+)' + '[\\]\\uff3d)\\uff09\\u3011]', 'g');
function normaliseFurigana(str) {
  if (!str) return str;
  return String(str).replace(BRACKETED, (m, kanji, okuri, reading) => {
    if (okuri && reading.length > okuri.length && reading.slice(-okuri.length) === okuri) {
      return '<ruby>' + kanji + '<rt>' + reading.slice(0, -okuri.length) + '</rt></ruby>' + okuri;
    }
    return '<ruby>' + kanji + okuri + '<rt>' + reading + '</rt></ruby>';
  });
}
function usableRuby(raw, say) {
  if (!raw) return null;
  const t = String(raw).trim();
  const tries = [t];
  const unfenced = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  tries.push(unfenced);
  tries.push(unfenced.replace(/^["'`\u300c\u300e]+/, '').replace(/["'`\u300d\u300f]+$/, '').trim());
  tries.slice().forEach(c => tries.push(normaliseFurigana(c)));
  for (const cand of tries) if (rubyMatches(cand, say)) return cand;
  return null;
}
function needsFurigana(say) { return KANJI.test(String(say)); }

const NOT_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;
function looksEnglish(str) {
  const t = String(str || '').trim();
  if (!t) return false;
  if (NOT_LATIN.test(t)) return false;
  return /[a-z]{2}/i.test(t);
}

// js/game.js's decideWhereToGo
function normPlace(x) {
  return String(x).toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]/g, '').trim();
}
function placeMatches(places, said) {
  const s = normPlace(said);
  return places.some(name => {
    const n = normPlace(name);
    return n === s || (s && (n.indexOf(s) !== -1 || s.indexOf(n) !== -1));
  });
}

/* ------------------------------------------------------------ log reading */

function logFiles(argv) {
  if (argv.length) return argv;
  const dir = path.join(ROOT, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
    .map(f => path.join(dir, f));
}

function readCalls(files) {
  const out = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { console.error('skipping ' + file + ': ' + e.message); continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      if (e.type === 'call') out.push(e);
    }
  }
  return out;
}

/* Prompt text can be in either `system` or the messages, depending on
   the call — the player-facing prompt puts everything in `system`,
   while villager-to-villager and helper calls put the substance in the
   first message and keep `system` to one line. Searches both, joined
   together, matching how js/llm.js's own `subjectOf` does it. */
function fullText(e) {
  return String(e.system || '') + '\n' + (e.messages || []).map(m => m.content || '').join('\n');
}

/* -------------------------------------------------------------- grouping

   `roleOf` is deliberately independent of the log's own `kind` field.
   That field is matched from a fixed system-prompt prefix list in
   js/llm.js's `KINDS`, which doesn't (yet) have an entry for the
   noticeboard call, so those fall into its catch-all "call" bucket.
   Since this script needs the actual role to know which checks to
   apply, it re-implements the same prefix matching with one extra row,
   rather than relying on a categorization known to miss a caller. */
function roleOf(e) {
  const sys = String(e.system || '');
  if (sys.indexOf('You decide what a villager does next') === 0) return 'intent';
  if (sys.indexOf('You play one villager') === 0) return 'chatter';
  if (sys.indexOf('You decide whether a villager posts a notice') === 0) return 'notice';
  if (fullText(e).indexOf('# Your character') !== -1) return 'villager';
  return null;                          // notebook / gloss / trade / recall / revise -- out of scope here
}

/* Every logged call carries a `kind` field (from js/llm.js's own
   `kindOf`), matched against the same fixed prefix list `roleOf` above
   works around — it has no row for the noticeboard call, belief-
   revision (`revise`), or the after-conversation takeaway (`recall`),
   so all three land in its catch-all "call" bucket. A cost breakdown
   needs every call categorized legibly, so this is a fuller version of
   the same prefix-matching idea (not a reuse of `roleOf`, which
   deliberately skips anything that isn't reply-shaped). Keep in sync
   with js/llm.js manually, same as the other ported checks above. */
const COST_KINDS = [
  ['You decide what a villager does next', 'intent'],
  ['You play one villager', 'chatter'],
  ['You verify claims', 'notebook'],
  ['You add furigana', 'furigana'],
  ['You translate and romanise', 'gloss'],
  ['You answer yes or no', 'trade'],
  ['You decide whether a villager posts a notice', 'notice'],
  ["You keep one person's beliefs up to date", 'revise'],
  ['You note what people took away from a conversation', 'recall'],
];
function costKindOf(e) {
  const t = String(e.system || '');
  for (const [head, name] of COST_KINDS) if (t.indexOf(head) === 0) return name;
  if (fullText(e).indexOf('# Your character') !== -1) return 'villager';
  return 'other';
}

/* The primary cost split, as also tracked in DESIGN.md: the in-character
   model playing the player-facing villager (`cfg.model`, the "villager"
   kind) versus the helper model (`helperModel(cfg)`) handling every
   other kind of bookkeeping call. `chatter` (villager-to-villager
   dialogue) is dispatched via helperModel too (see js/llm.js's
   villager-to-villager call site, which sets `model: helperModel(cfg)`),
   so it counts as helper-side cost despite being dialogue — the split
   is by which model actually answered, not by what the prompt content
   looks like. This split matters because the helper side can carry a
   much larger share of total call volume and cost than a kind-by-kind
   table alone would suggest, so it gets its own summary line above the
   detailed breakdown. */
const VILLAGER_KINDS = new Set(['villager']);
function grandKindOf(kind) { return VILLAGER_KINDS.has(kind) ? 'villager' : 'helper'; }

/* Token field names differ per provider's API shape — Anthropic's
   `usage` uses input_tokens/output_tokens, while the OpenAI-shaped APIs
   (OpenRouter, Logfare) use prompt_tokens/completion_tokens. `cost` is
   OpenRouter-specific: it's the only provider that reports per-reply
   pricing directly. A bucket with no OpenRouter calls therefore has *no
   cost data*, not a cost of zero -- these two states are tracked
   separately (see `costSeen`) rather than conflated. */
function tokensOf(usage) {
  if (!usage) return { in: 0, out: 0 };
  const inTok = usage.input_tokens != null ? usage.input_tokens : usage.prompt_tokens;
  const outTok = usage.output_tokens != null ? usage.output_tokens : usage.completion_tokens;
  return { in: inTok || 0, out: outTok || 0 };
}
function money(n) { return '$' + n.toFixed(4); }

/* -------------------------------------------------------------- checking

   Checks one log entry for anything the game had to correct. Flags are
   independent, so a single reply can trigger several at once (e.g. a
   repaired JSON object that's also missing its roman field). */
function check(e, role) {
  const flags = [];
  if (e.error) { flags.push('call-failed'); return { flags, obj: null }; }
  if (e.truncated) flags.push('truncated');

  const { level, obj } = classifyReply(e.raw);
  if (level === 'repaired') flags.push('json-repaired');
  else if (level === 'salvaged') flags.push('json-salvaged');
  else if (level === 'failed' || level === 'empty') { flags.push('json-unreadable'); return { flags, obj: null }; }

  const text = fullText(e);

  if (role === 'intent') {
    const m = text.match(/must be one of these strings exactly:\s*\n(\[[^\n]*\])/);
    let places = null;
    if (m) { try { places = JSON.parse(m[1]); } catch (err) {} }
    if (places && !placeMatches(places, obj.go)) flags.push('bad-location');
    return { flags, obj };
  }

  // villager/chatter/notice all reply in the target language, with a
  // translation (and, for languages that romanize, a roman field) alongside it.
  const posting = role !== 'notice' || obj.post === true;
  if (posting) {
    if (!looksEnglish(obj.translation)) flags.push('translation-missing');
    if (/"roman":/.test(text)) {
      const roman = String(obj.roman || '').trim();
      if (!roman || NOT_LATIN.test(roman)) flags.push('roman-missing');
    }
  }

  if ((role === 'villager' || role === 'chatter') && text.indexOf('# Furigana') !== -1 &&
      typeof obj.say === 'string') {
    const written = normaliseFurigana(obj.say);
    const bare = stripRuby(written);
    const inline = bare !== written;
    const separate = !inline && obj.ruby && !!usableRuby(obj.ruby, obj.say);
    if (needsFurigana(inline ? bare : obj.say) && !inline && !separate) flags.push('furigana-missing');
  }

  if (role === 'villager') {
    const act = String(obj.action || '').toLowerCase();
    if (act === 'buy' || act === 'sell') {
      const item = obj.item;
      const itemBad = !item || (Array.isArray(item) ? item.length === 0 : !String(item).trim());
      const priceBad = typeof obj.price !== 'number' || !(obj.price > 0);
      if (itemBad || priceBad) flags.push('buysell-malformed');
    }
  }

  return { flags, obj };
}

/* --------------------------------------------------------------- report */

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '—'; }

function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length,
    ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(line(widths.map(w => '-'.repeat(w))));
  rows.forEach(r => console.log(line(cols.map(c => c.get(r)))));
}

function main() {
  const files = logFiles(process.argv.slice(2));
  if (!files.length) {
    console.error('No log files found. Point me at some: node tools/format-stats.js logs/*.jsonl');
    process.exit(1);
  }
  const calls = readCalls(files);

  // One bucket per (role, model) pair. Chatter and villager calls can
  // in principle use the same model, but rarely do in practice (see
  // js/llm.js's HELPERS list) -- keeping role and model separate makes
  // clear which job each number describes.
  const buckets = new Map();
  function bucket(role, model) {
    const key = role + ' ' + model;
    if (!buckets.has(key)) buckets.set(key, {
      role, model, total: 0,
      any: 0,
      callFailed: 0, truncated: 0, jsonRepaired: 0, jsonSalvaged: 0, jsonUnreadable: 0,
      translationMissing: 0, romanMissing: 0, furiganaMissing: 0,
      buysellAttempts: 0, buysellMalformed: 0,
      badLocation: 0
    });
    return buckets.get(key);
  }

  for (const e of calls) {
    const role = roleOf(e);
    if (!role) continue;
    const b = bucket(role, e.model || '(unknown)');
    b.total++;
    const { flags, obj } = check(e, role);
    // "any" counts a call once regardless of how many flags it triggers
    // -- summing the per-reason counts instead would over-count a reply
    // that's e.g. missing both its roman and translation fields.
    const happyPathFlags = ['call-failed', 'truncated', 'json-repaired', 'json-salvaged',
      'json-unreadable', 'translation-missing', 'roman-missing', 'furigana-missing'];
    if (happyPathFlags.some(f => flags.includes(f))) b.any++;
    if (flags.includes('call-failed')) { b.callFailed++; continue; }
    if (flags.includes('truncated')) b.truncated++;
    if (flags.includes('json-repaired')) b.jsonRepaired++;
    if (flags.includes('json-salvaged')) b.jsonSalvaged++;
    if (flags.includes('json-unreadable')) { b.jsonUnreadable++; continue; }
    if (flags.includes('translation-missing')) b.translationMissing++;
    if (flags.includes('roman-missing')) b.romanMissing++;
    if (flags.includes('furigana-missing')) b.furiganaMissing++;
    if (flags.includes('bad-location')) b.badLocation++;
    if (role === 'villager') {
      const act = obj && String(obj.action || '').toLowerCase();
      if (act === 'buy' || act === 'sell') {
        b.buysellAttempts++;
        if (flags.includes('buysell-malformed')) b.buysellMalformed++;
      }
    }
  }

  const rows = [...buckets.values()].sort((a, b) =>
    a.role.localeCompare(b.role) || b.total - a.total);

  console.log(files.length + ' log file(s), ' + calls.length + ' call(s) read.\n');

  console.log('# Villager vs helper');
  console.log('the in-character model for the player-facing villager reply against the');
  console.log('helper model doing every other kind of call, chatter included. "cost" is a');
  console.log('floor, same caveat as below.\n');
  const grandBuckets = new Map([
    ['villager', { n: 0, cost: 0, costSeen: false }],
    ['helper', { n: 0, cost: 0, costSeen: false }]
  ]);
  for (const e of calls) {
    const b = grandBuckets.get(grandKindOf(costKindOf(e)));
    b.n++;
    const cost = e.usage && e.usage.cost;
    if (typeof cost === 'number') { b.cost += cost; b.costSeen = true; }
  }
  const grandRows = [...grandBuckets.entries()]
    .map(([grand, b]) => ({ grand, ...b }))
    .sort((a, b) => b.n - a.n);
  table(grandRows, [
    { label: 'grand', get: r => r.grand },
    { label: 'n', get: r => r.n },
    { label: 'cost', get: r => r.costSeen ? money(r.cost) : 'n/a' },
    { label: '$/call', get: r => r.costSeen ? money(r.cost / r.n) : '—' }
  ]);

  console.log('\n# Calls by kind, and cost');
  console.log('every call in the log, whatever shape its reply — grouped by what it was');
  console.log('asking (see COST_KINDS above) and which model answered. Sorted by cost where');
  console.log('any is known, then by call count. "cost" is OpenRouter\'s own usage.cost;');
  console.log('providers that don\'t report it show n/a, not $0 — that total is a floor,');
  console.log('not the whole bill, whenever other providers are in the mix.\n');
  const costBuckets = new Map();
  function costBucket(kind, provider, model) {
    const key = kind + ' ' + provider + ' ' + model;
    if (!costBuckets.has(key)) costBuckets.set(key, {
      kind, provider, model, n: 0, cost: 0, costSeen: false, tokIn: 0, tokOut: 0
    });
    return costBuckets.get(key);
  }
  let totalCost = 0, costedCalls = 0;
  for (const e of calls) {
    const b = costBucket(costKindOf(e), e.provider || '(unknown)', e.model || '(unknown)');
    b.n++;
    const { in: tokIn, out: tokOut } = tokensOf(e.usage);
    b.tokIn += tokIn;
    b.tokOut += tokOut;
    const cost = e.usage && e.usage.cost;
    if (typeof cost === 'number') {
      b.cost += cost;
      b.costSeen = true;
      totalCost += cost;
      costedCalls++;
    }
  }
  const costRows = [...costBuckets.values()].sort((a, c) => {
    if (a.costSeen !== c.costSeen) return a.costSeen ? -1 : 1;
    return a.costSeen ? c.cost - a.cost : c.n - a.n;
  });
  table(costRows, [
    { label: 'kind', get: r => r.kind },
    { label: 'provider', get: r => r.provider },
    { label: 'model', get: r => r.model },
    { label: 'n', get: r => r.n },
    { label: 'cost', get: r => r.costSeen ? money(r.cost) : 'n/a' },
    { label: '$/call', get: r => r.costSeen ? money(r.cost / r.n) : '—' },
    { label: 'tok in', get: r => r.tokIn },
    { label: 'tok out', get: r => r.tokOut }
  ]);
  console.log(
    '\n' + money(totalCost) + ' total over ' + costedCalls + ' costed call(s) of ' +
    calls.length + (calls.length === costedCalls ? '' :
      ' (' + (calls.length - costedCalls) + ' from a provider that reports no cost)') + '.'
  );

  console.log('\n# Not perfectly happy-path formatted');
  console.log('every reply-shaped call — villager (player-facing), chatter (villager-to-');
  console.log('villager), notice (noticeboard) — checked against what its own prompt asked');
  console.log('for. "any" is any flag below; the rest break out why.\n');
  const glossRows = rows.filter(r => r.role !== 'intent');
  table(glossRows, [
    { label: 'role', get: r => r.role },
    { label: 'model', get: r => r.model },
    { label: 'n', get: r => r.total },
    { label: 'any', get: r => pct(r.any, r.total) },
    { label: 'call-failed', get: r => pct(r.callFailed, r.total) },
    { label: 'json-repaired', get: r => pct(r.jsonRepaired, r.total) },
    { label: 'json-unreadable', get: r => pct(r.jsonUnreadable, r.total) },
    { label: 'roman-missing', get: r => pct(r.romanMissing, r.total) },
    { label: 'translation-missing', get: r => pct(r.translationMissing, r.total) },
    { label: 'furigana-missing', get: r => pct(r.furiganaMissing, r.total) }
  ]);

  console.log('\n# Buying (villager replies with action buy/sell)');
  console.log('item and/or price missing, empty, or not a positive number — the shape');
  console.log('js/game.js\'s commerce() needs to ring a sale up at all.\n');
  const buyRows = rows.filter(r => r.role === 'villager' && r.buysellAttempts > 0);
  if (buyRows.length) {
    table(buyRows, [
      { label: 'model', get: r => r.model },
      { label: 'buy/sell attempts', get: r => r.buysellAttempts },
      { label: 'malformed', get: r => pct(r.buysellMalformed, r.buysellAttempts) }
    ]);
  } else console.log('(no buy/sell actions in this log)');

  console.log('\n# Where to go (intent calls)');
  console.log('"go" that does not forgiving-match any place the villager was actually');
  console.log('offered — see js/game.js\'s decideWhereToGo, which falls back to habit here.\n');
  const goRows = rows.filter(r => r.role === 'intent');
  if (goRows.length) {
    table(goRows, [
      { label: 'model', get: r => r.model },
      { label: 'n', get: r => r.total },
      { label: 'call-failed', get: r => pct(r.callFailed, r.total) },
      { label: 'json-bad', get: r => pct(r.jsonRepaired + r.jsonSalvaged + r.jsonUnreadable, r.total) },
      { label: 'bad-location', get: r => pct(r.badLocation, r.total) }
    ]);
  } else console.log('(no intent calls in this log)');
}

main();
