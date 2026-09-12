#!/usr/bin/env node
/* latency-report.js — how long each kind of call takes, and on which model.

   Every call the game makes already carries its own round-trip time: js/llm.js's
   `audited` times from just before the provider call to just after it returns
   or throws, and `record` writes that as `ms` onto the log entry (see
   DESIGN.md's "Every call is on the record"). This script never talks to a
   model itself; it only sums and sorts what logs/*.jsonl already has.

       node tools/latency-report.js                  # every logs/*.jsonl
       node tools/latency-report.js logs/foo.jsonl    # just this one (or several)

   A call that errored still has an `ms` — audited() times the attempt whether
   it resolves or throws — so a slow, failing model shows up here as slow, not
   as absent. Nothing here decides anything about the game; it only reads. */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------ log reading

   Same shape as tools/format-stats.js's own logFiles/readCalls — a copy, not
   a require, for the same reason format-stats gives for its own copies: two
   short functions are cheaper to keep in step by eye than to wire a shared
   module for. */

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

   The `kind` field already on each entry is matched off a fixed system-prompt
   prefix list in js/llm.js's own KINDS, which (as format-stats.js notes) has
   no row for the noticeboard call, belief-revision, or the after-conversation
   takeaway — those three land in its catch-all "call" bucket. A latency
   breakdown wants every call to land somewhere legible, so this is the same
   fuller COST_KINDS table format-stats.js uses for its own cost breakdown,
   copied rather than shared for the same by-eye-in-step reason as above. */
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

/* The one distinction DESIGN.md itself measures cost by (see "And the log is
   where the cost shows up"): the in-character model that plays the
   player-facing villager — `cfg.model`, the "villager" kind — against the
   helper model (`helperModel(cfg)`) doing every other kind of bookkeeping
   call. `chatter` (villager-to-villager) is dispatched with helperModel too
   (js/llm.js's own villager-to-villager call site sets `model: helperModel
   (cfg)`), so it belongs on the helper side of the split despite reading
   like dialogue — the split follows which model answered, not what the
   prompt sounds like. Latency reads the same way cost did there: what looks
   like a rounding error next to the dialogue is a different question once it
   is actually measured apart from it, so this split is the top of the
   report, not an afterthought. */
const VILLAGER_KINDS = new Set(['villager']);
function grandOf(kind) { return VILLAGER_KINDS.has(kind) ? 'villager' : 'helper'; }

/* -------------------------------------------------------------- stats

   Sum and count are enough for a total, but a mean alone hides a bimodal
   model — fast unless it decides to reason, say — so each bucket also keeps
   every ms and reports min/median/max. */
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
