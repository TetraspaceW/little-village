#!/usr/bin/env node
/* latency-report.js — reports round-trip time per call kind and model.

   Every logged call already has its round-trip time recorded: js/llm.js's
   `audited` measures from just before the provider request to just
   after it resolves or throws, and `record` stores that as `ms` on the
   log entry. This script makes no API calls itself; it only aggregates
   and sorts data already present in logs/*.jsonl.

       node tools/latency-report.js                  # every logs/*.jsonl
       node tools/latency-report.js logs/foo.jsonl    # just this one (or several)

   A failed call still has a valid `ms` value, since `audited()` times
   the attempt regardless of whether it resolves or throws — so a slow,
   failing model shows up here as slow, not missing. This script is
   read-only -- it doesn't affect game behavior. */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------ log reading

   Duplicates tools/format-stats.js's logFiles/readCalls rather than
   importing them — for two short functions, keeping copies in sync
   manually is simpler than introducing a shared module. */

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
      if (e.type === 'call' && typeof e.ms === 'number') out.push(e);
    }
  }
  return out;
}

/* -------------------------------------------------------------- grouping

   The `kind` field already on each log entry is matched from a fixed
   system-prompt prefix list in js/llm.js's `KINDS`, which (as noted in
   format-stats.js) has no entry for the noticeboard call, belief-
   revision, or the after-conversation takeaway — those three land in
   its catch-all "call" bucket. A latency breakdown needs every call
   categorized legibly, so this reuses the same fuller table
   format-stats.js defines as `COST_KINDS`, duplicated here for the same
   reason as the log-reading functions above. */
const KINDS = [
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
function kindOf(e) {
  const sys = String(e.system || '');
  for (const [head, name] of KINDS) if (sys.indexOf(head) === 0) return name;
  const t = sys + '\n' + (e.messages || []).map(m => m.content || '').join('\n');
  if (t.indexOf('# Your character') !== -1) return 'villager';
  return 'other';
}

/* The same primary split DESIGN.md tracks cost by: the in-character
   model playing the player-facing villager (`cfg.model`, the
   "villager" kind) versus the helper model (`helperModel(cfg)`)
   handling every other kind of bookkeeping call. `chatter`
   (villager-to-villager dialogue) is dispatched via helperModel too
   (see js/llm.js's villager-to-villager call site, which sets `model:
   helperModel(cfg)`), so it counts as helper-side latency despite
   being dialogue — the split is by which model answered, not what the
   prompt looks like. Helper-side latency, aggregated across its higher
   call volume, can be a meaningfully larger share of total wait time
   than it appears next to any single dialogue exchange, which is why
   this split leads the report rather than being buried in the detail. */
const VILLAGER_KINDS = new Set(['villager']);
function grandOf(kind) { return VILLAGER_KINDS.has(kind) ? 'villager' : 'helper'; }

/* -------------------------------------------------------------- stats

   Sum and count alone are enough for a total, but a mean alone can
   hide a bimodal distribution (e.g. a model that's fast unless it
   decides to reason at length) -- so each bucket keeps every individual
   value and reports min/median/p90/max too. */
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = p => sorted[Math.min(n - 1, Math.floor(p * n))];
  return {
    n, sum,
    avg: sum / n,
    min: sorted[0],
    median: at(0.5),
    p90: at(0.9),
    max: sorted[n - 1]
  };
}

function ms(n) { return Math.round(n).toLocaleString() + 'ms'; }

function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length,
    ...rows.map(r => String(c.get(r)).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log(line(widths.map(w => '-'.repeat(w))));
  rows.forEach(r => console.log(line(cols.map(c => c.get(r)))));
}

/* --------------------------------------------------------------- report */

function main() {
  const files = logFiles(process.argv.slice(2));
  if (!files.length) {
    console.error('No log files found. Point me at some: node tools/latency-report.js logs/*.jsonl');
    process.exit(1);
  }
  const calls = readCalls(files);
  if (!calls.length) {
    console.error('No timed calls in ' + files.length + ' log file(s).');
    process.exit(1);
  }

  // one bucket per (kind, model)
  const buckets = new Map();
  function bucket(kind, model) {
    const key = kind + ' ' + model;
    if (!buckets.has(key)) buckets.set(key, { kind, model, values: [] });
    return buckets.get(key);
  }
  for (const e of calls) bucket(kindOf(e), e.model || '(unknown)').values.push(e.ms);

  console.log(files.length + ' log file(s), ' + calls.length + ' timed call(s) read.\n');

  console.log('# Villager vs helper');
  console.log('the one split DESIGN.md itself measures cost by: the in-character model for');
  console.log('the player-facing villager reply against the helper model doing every other');
  console.log('kind of bookkeeping call, chatter included. Everything below is broken out');
  console.log('inside this split first.\n');
  const byGrand = new Map([['villager', []], ['helper', []]]);
  for (const e of calls) byGrand.get(grandOf(kindOf(e))).push(e.ms);
  const grandOrder = [...byGrand.entries()]
    .map(([grand, values]) => ({ grand, ...stats(values) }))
    .sort((a, b) => b.avg - a.avg);
  table(grandOrder, [
    { label: 'grand', get: r => r.grand },
    { label: 'n', get: r => r.n },
    { label: 'avg', get: r => ms(r.avg) },
    { label: 'median', get: r => ms(r.median) },
    { label: 'p90', get: r => ms(r.p90) }
  ]);

  for (const g of grandOrder) {
    console.log('\n## ' + g.grand + '  (n=' + g.n + ', avg ' + ms(g.avg) + ' pooled)');
    console.log('ms measured in js/llm.js\'s `audited` — from just before the provider call');
    console.log('to just after it returns or throws. Kind (the main aggregation — what the');
    console.log('call was asking) is ordered slowest-average first; within each kind, model');
    console.log('(the sub-aggregation — who answered) is ordered the same way.\n');

    const byKind = new Map();
    for (const e of calls) {
      const k = kindOf(e);
      if (grandOf(k) !== g.grand) continue;
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(e.ms);
    }
    const kindOrder = [...byKind.entries()]
      .map(([kind, values]) => ({ kind, ...stats(values) }))
      .sort((a, b) => b.avg - a.avg);

    for (const k of kindOrder) {
      const modelRows = [...buckets.values()]
        .filter(b => b.kind === k.kind)
        .map(b => ({ model: b.model, ...stats(b.values) }))
        .sort((a, b) => b.avg - a.avg);
      console.log(k.kind + '  (n=' + k.n + ', avg ' + ms(k.avg) + ' pooled across models)');
      table(modelRows, [
        { label: 'model', get: r => r.model },
        { label: 'n', get: r => r.n },
        { label: 'avg', get: r => ms(r.avg) },
        { label: 'median', get: r => ms(r.median) },
        { label: 'p90', get: r => ms(r.p90) },
        { label: 'min', get: r => ms(r.min) },
        { label: 'max', get: r => ms(r.max) }
      ]);
      console.log('');
    }

    console.log('# Average by model, within ' + g.grand + ' (every kind pooled)\n');
    const byModel = new Map();
    for (const e of calls) {
      if (grandOf(kindOf(e)) !== g.grand) continue;
      const m = e.model || '(unknown)';
      if (!byModel.has(m)) byModel.set(m, []);
      byModel.get(m).push(e.ms);
    }
    const modelRows = [...byModel.entries()]
      .map(([model, values]) => ({ model, ...stats(values) }))
      .sort((a, b) => b.avg - a.avg);
    table(modelRows, [
      { label: 'model', get: r => r.model },
      { label: 'n', get: r => r.n },
      { label: 'avg', get: r => ms(r.avg) },
      { label: 'median', get: r => ms(r.median) }
    ]);
  }

  const grand = stats(calls.map(e => e.ms));
  console.log('\n' + ms(grand.avg) + ' average round-trip time over ' + grand.n + ' call(s), villager and helper combined.');
}

main();
