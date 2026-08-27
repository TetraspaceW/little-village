/* logbook.js — sends game events to a log file for later inspection
   (the console only shows them live).

   Posts to `tools/logserver.js`, which also serves the page itself, so
   there's no CORS to configure and nothing to enable manually. If that
   server isn't running (e.g. the page was opened from a plain file
   server), the first POST fails, logging turns itself off, and the game
   continues normally.

   Entries are batched rather than sent one at a time: a busy village can
   fire several LLM calls a second, and each entry carries a full prompt. */
window.LG = window.LG || {};

LG.logbook = (function () {
  const ENDPOINT = '/log';
  const FLUSH_MS = 1500;
  const MAX_BATCH = 24;

  let queue = [];
  let on = true;                 // flips false permanently after a failed POST
  let timer = null;
  let sent = 0, dropped = 0;

  function usable() {
    return on && typeof fetch === 'function' &&
           typeof location !== 'undefined' && /^https?:/.test(location.protocol);
  }

  function add(entry) {
    if (!usable()) return;
    entry.at = entry.at || new Date().toISOString();
    queue.push(entry);
    if (queue.length >= MAX_BATCH) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length || !usable()) return;
    const batch = queue;
    queue = [];
    fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(batch) })
      .then(res => {
        if (res.ok || res.status === 204) { sent += batch.length; return; }
        // server responded but rejected the batch — stop retrying
        on = false; dropped += batch.length;
      })
      .catch(() => { on = false; dropped += batch.length; });
  }

  /* Logs one full LLM API call: prompt, raw reply, and reasoning trace. */
  function call(e) {
    add({ type: 'call', n: e.n, kind: e.kind, who: e.who, model: e.model,
          provider: e.provider, ms: e.ms, usage: e.usage, stop: e.stop,
          truncated: e.truncated, error: e.error,
          system: e.system, messages: e.messages,
          reasoning: e.reasoning, raw: e.raw });
  }

  /* Logs a miscellaneous game event for later review. */
  function note(type, who, what, extra) {
    const e = { type: type, who: who, what: what };
    if (extra) for (const k in extra) e[k] = extra[k];
    add(e);
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', flush);
  }

  return { call, note, flush,
           get on() { return on; }, set on(v) { on = !!v; },
           get pending() { return queue.length; },
           get sent() { return sent; }, get dropped() { return dropped; } };
})();
