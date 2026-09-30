/* needle-worker.js — loads Cactus Needle 3 off the main thread. A decode
   takes the better part of a second; running it inline in the main thread
   would freeze rendering and input for that long every time a villager
   decides where to walk. Engine, weights and all, this fetches straight
   from Hugging Face the first time it's used -- the browser's own HTTP
   cache is what keeps every call after that from re-downloading anything.

   The model is one process-global, non-thread-safe instance (see
   Cactus-Compute/needle3's needle.h), so requests are answered strictly
   one at a time even if several come in before the first finishes. */

const HF_BASE = "https://huggingface.co/Cactus-Compute/needle3/resolve/main/";
const ENGINE_URL = HF_BASE + "wasm/needle.js";
const WASM_URL = HF_BASE + "wasm/needle.wasm";
const WEIGHTS_URL = HF_BASE + "needle3.cact";

let modulePromise = null;
let lastToolsJson = null;

async function fetchOrThrow(url, as) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch " + url + " failed: " + res.status);
  return as === "text" ? res.text() : res.arrayBuffer();
}

async function loadModule() {
  const [engineSrc, wasmBuf, weightsBuf] = await Promise.all([
    fetchOrThrow(ENGINE_URL, "text"),
    fetchOrThrow(WASM_URL),
    fetchOrThrow(WEIGHTS_URL),
  ]);

  // needle.js is an Emscripten UMD build with no browser-global fallback --
  // it only assigns itself to module.exports or an AMD define(), neither of
  // which exists here. Shimming both as plain objects and running the
  // source through them is the only way to reach `createNeedle`.
  const mod = { exports: {} };
  new Function("module", "exports", engineSrc)(mod, mod.exports);
  const createNeedle = mod.exports;

  // wasmBinary bypasses the module's own fetch-relative-to-script-url
  // logic entirely, which matters here since this code never runs as an
  // actual <script src>, so it has nothing to locate a sibling .wasm from.
  const Module = await createNeedle({ wasmBinary: new Uint8Array(wasmBuf) });

  const weights = new Uint8Array(weightsBuf);
  const ptr = Module._malloc(weights.length);
  Module.HEAPU8.set(weights, ptr);
  // n is a C `unsigned long long`; ccall only accepts that as a BigInt.
  const rc = Module.ccall(
    "needle_load",
    "number",
    ["number", "bigint"],
    [ptr, BigInt(weights.length)],
  );
  Module._free(ptr);
  if (rc < 0) throw new Error("needle_load failed: " + rc);
  return Module;
}

function moduleReady() {
  if (!modulePromise) modulePromise = loadModule();
  return modulePromise;
}

function complete(Module, input) {
  const outCap = 8192;
  const outPtr = Module._malloc(outCap);
  try {
    const rc = Module.ccall(
      "needle_complete",
      "number",
      ["string", "number", "number", "number"],
      [input, 96, outPtr, outCap],
    );
    if (rc < 0) throw new Error("needle_complete failed: " + rc);
    return Module.UTF8ToString(outPtr);
  } finally {
    Module._free(outPtr);
  }
}

async function handle({ id, system, toolsJson, input }) {
  try {
    const Module = await moduleReady();
    // Rebuilding the tool index (needle_init) is the expensive-ish part of
    // switching villagers/place lists -- skip it when nothing changed
    // since the last decision, which is the common case call to call.
    if (toolsJson !== lastToolsJson) {
      const initRc = Module.ccall(
        "needle_init",
        "number",
        ["string", "string", "string"],
        [system, toolsJson, null],
      );
      if (initRc < 0) throw new Error("needle_init failed: " + initRc);
      lastToolsJson = toolsJson;
    }
    // Every decision is independent -- without a reset, needle_complete
    // treats this as a continuing conversation and can decide the earlier
    // destination was already reached, answering with no tool call at all.
    Module.ccall("needle_reset", null, [], []);
    const raw = complete(Module, input);
    const data = JSON.parse(raw);
    const call = data.function_calls && data.function_calls[0];
    const destination =
      call && call.arguments && typeof call.arguments.destination === "string"
        ? call.arguments.destination
        : null;
    self.postMessage({ id, destination });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
}

// Chains every request onto the last so two decisions in flight at once
// can't interleave their needle_init/needle_reset/needle_complete calls
// against the single shared model instance.
let queue = Promise.resolve();
self.onmessage = (ev) => {
  queue = queue.then(
    () => handle(ev.data),
    () => handle(ev.data),
  );
};
