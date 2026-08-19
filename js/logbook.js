/* logbook.js — ships everything the village does to a log file.

   The console shows you what happened while you are watching; this keeps it. It
   posts to `tools/logserver.js`, which is also what serves the page, so there is
   no CORS to arrange and nothing to switch on. If that server is not running —
   the page opened from a plain file server, say — the first post fails, logging
   switches itself off, and the game carries on exactly as before.

   Entries are batched rather than posted one at a time, because a busy village
   makes several calls a second and each one carries a whole prompt. */
window.LG = window.LG || {};

LG.logbook = (function () {
  const ENDPOINT = '/log';
  const FLUSH_MS = 1500;
  const MAX_BATCH = 24;

  let queue = [];
  let on = true;                 // until the server tells us otherwise
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
        // a server that is there but will not take logs is not worth pestering
        on = false; dropped += batch.length;
      })
      .catch(() => { on = false; dropped += batch.length; });
  }

  /* One API call, whole: the prompt, the raw reply, the model's own reasoning. */
  function call(e) {
    add({ type: 'call', n: e.n, kind: e.kind, who: e.who, model: e.model,
          provider: e.provider, ms: e.ms, usage: e.usage, stop: e.stop,
          truncated: e.truncated, error: e.error,
          system: e.system, messages: e.messages,
          reasoning: e.reasoning, raw: e.raw });
  }

  /* Anything a villager did that is worth reading back later. */
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
