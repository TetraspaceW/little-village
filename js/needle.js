/* needle.js — bridge to Cactus Needle 3 (see needle-worker.js), a small
   tool-calling model that runs locally in the browser instead of over the
   network. Kept separate from llm.js the same way tts.js is: this file
   only knows how to talk to the worker; building the villager's state text
   and its `go` tool is decideByCactusNeedle's job (llm.js), same as the
   split between decisionPost and decideByJev for the Jev path. */
window.LG = window.LG || {};

LG.needle = (function () {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function getWorker() {
    if (worker) return worker;
    worker = new Worker("js/needle-worker.js");
    worker.onmessage = (ev) => {
      const { id, destination, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(destination);
    };
    worker.onerror = () => {
      // Otherwise a worker-level failure (wasm blocked, no Worker support,
      // the Hugging Face fetch failing) leaves every request still waiting
      // hanging forever instead of failing closed like the rest of intent().
      pending.forEach((p) => p.reject(new Error("needle worker failed")));
      pending.clear();
    };
    return worker;
  }

  /* system: short static instructions. toolsJson: a JSON string holding a
     one-element array with an OpenAI-shaped tool definition. input: the
     free-text state to decide from. Resolves to the chosen enum string
     from that tool's call, or null if the model didn't call it. */
  function ask(system, toolsJson, input) {
    if (typeof Worker === "undefined") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, system, toolsJson, input });
    });
  }

  return { ask };
})();
