/* llm.js — LLM provider abstraction for OpenRouter and Logfare, called
   directly from the browser. */
window.LG = window.LG || {};

LG.llm = (function () {
  /* Logfare exposes only one selectable model: "logfare/auto" routes to
     whichever underlying model it currently rates best, falling back
     through its chain on failure. Since there's nothing else to choose,
     it's the only entry in the model lists below, and the send path
     hardcodes it rather than trusting cfg.model. */
  const LOGFARE_MODEL = "logfare/auto";

  /* OpenRouter's "auto" router picks the underlying model per-request
     rather than a fixed model being named; how much that underlying
     model reasons is set separately via `reasoning.effort` in
     send (high for the main model, medium for the helper).
     No longer offered in the lists below, but still honoured if typed
     in as a custom model id. */
  const AUTO_MODEL = "openrouter/auto";

  /* Jev (TypeSafe AI) is a "System One" model: given free-text `state`
     and a set of typed `questions`, it returns a typed choice with a
     probability attached -- no generated prose, no JSON-in-a-chat-reply
     to parse. That's a different shape from every other call in this
     file (system + messages in, text out), so it isn't offered in
     MODELS/HELPERS below and can't be typed into the "Other" box --
     picking it as a chat or helper model would leave dialogue with a
     model that cannot write dialogue. It gets its own request path
     (decisionPost/askJev, below), reachable only over OpenRouter --
     there's no Logfare equivalent -- and used automatically whenever it
     is: movement decisions, and the bookkeeping checks (a trade
     completing, a fact actually stated) the helper model otherwise makes
     (see DESIGN.md). The local Needle setting overrides it for movement only. */
  const JEV_MODEL = "typesafe/jev-1.13";
  const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

  /* Cactus Needle 3 does the same job as Jev -- a typed top-1 choice, no
     generated prose -- but runs locally as WebAssembly instead of over the
     network (decideByCactusNeedle/needle.js, near intent() below), so
     unlike Jev its inference needs no provider or API key. The Needle
     movement setting overrides automatic Jev movement (see DESIGN.md). */
  const NEEDLE_MODEL = "cactus-needle-3";

  /* One offered model per role on OpenRouter; anything else goes in the
     settings panel's "Other" box. */
  const MODELS = {
    openrouter: [
      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
    ],
    logfare: [{ id: LOGFARE_MODEL, label: "Auto" }],
  };

  /* Small/cheap helper model list, used for bookkeeping tasks the
     in-character model handles poorly: notebook fact-checking, furigana
     repair, confirming a trade completed. Any cheap, literal model works. */
  const HELPERS = {
    openrouter: [{ id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash" }],
    logfare: [{ id: LOGFARE_MODEL, label: "Auto" }],
  };
  /* Resolves the helper model: explicit user choice, else the first of
     the provider's HELPERS, else falls back to the main villager model. */
  function helperModel(cfg) {
    const list = HELPERS[cfg && cfg.provider];
    return (cfg && cfg.helper) || (list && list[0].id) || (cfg && cfg.model);
  }

  /* What every bookkeeping call runs under: the same provider and key,
     the helper model, and `fast` for send's cheaper reasoning settings. */
  function helperConfig(cfg) {
    return {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: helperModel(cfg),
      fast: true,
    };
  }

  /* Wraps transport/HTTP failures into player-readable error messages. The
     most common failure is opening the page via file://, which sends
     `Origin: null` and fails the provider's CORS check. */
  async function post(url, headers, body) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        "Could not reach the API. If you opened this page as a file, " +
          "serve it over http instead (see the README) — browsers block API calls from file:// pages.",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "That key was rejected (" +
          res.status +
          "). Check it is correct and still active.",
      );
    }
    if (res.status === 404) {
      throw new Error(
        'The model "' +
          (body.model || "?") +
          '" was not found on this provider, ' +
          "or your key has no access to it.",
      );
    }
    if (res.status === 429)
      throw new Error("Rate limited. Wait a moment and try again.");
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 240);
      } catch (e) {}
      throw new Error(
        "API error " + res.status + (detail ? ": " + detail : ""),
      );
    }
    return res.json();
  }

  /* The system prompt as text blocks, cut where each of `prefixes` ends,
     with a cache breakpoint at every cut. Caching matches exact leading
     bytes, and a read can only land where an earlier request put a
     breakpoint -- so a cut after each stretch that stays the same turn
     to turn (see buildReply in dialogue.js) lets a later turn read back
     as much as is still unchanged, instead of all or nothing. Prefixes
     that don't lead `system` are skipped. The blocks concatenate to the
     original string, so a backend that flattens them sees the same text.
     Returns null when there's nothing to cut, and callers send the plain
     string as before. Below a model's minimum cacheable length a
     breakpoint is simply ignored -- no error, no extra cost. */
  function systemParts(system, prefixes) {
    if (typeof system !== "string") return null;
    const cuts = [].concat(prefixes || [])
      .filter((p) => p && system.indexOf(p) === 0)
      .map((p) => p.length)
      .sort((x, y) => x - y);
    const parts = [];
    let at = 0;
    cuts.forEach((end) => {
      if (end <= at) return; // the same cut twice
      parts.push({
        type: "text",
        text: system.slice(at, end),
        cache_control: { type: "ephemeral" },
      });
      at = end;
    });
    if (!parts.length) return null;
    if (at < system.length) parts.push({ type: "text", text: system.slice(at) });
    return parts;
  }

  /* OpenRouter attributes calls to an "app" keyed by this URL (viewable
     at openrouter.ai/apps?url=<this>). Previously this was derived from
     `location.origin`, which is the literal string "null" when opened via
     file://, so calls showed up as unattributed. Hardcoded instead, so
     every call is attributed to the same app regardless of what port or
     protocol the page is served from.

     Changing APP_URL later creates a new, separate app with its own
     history; APP_TITLE can be edited freely without that effect. */
  const APP_URL = "https://github.com/TetraspaceW/little-village";
  const APP_TITLE = "Little Village (Beta)";

  /* Both providers speak OpenAI-shaped chat completions, so a request
     differs only in where it goes, OpenRouter's attribution headers, and
     the OpenRouter-only extras send adds. Logfare has exactly one model
     and always gets it, regardless of any leftover custom model value in
     cfg. */
  function modelFor(cfg) {
    return cfg.provider === "logfare" ? LOGFARE_MODEL : cfg.model;
  }

  async function chatPost(cfg, body) {
    const logfare = cfg.provider === "logfare";
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + cfg.apiKey,
    };
    if (!logfare) {
      headers["HTTP-Referer"] = APP_URL;
      headers["X-Title"] = APP_TITLE;
    }
    const data = await post(
      logfare
        ? "https://logfare.ai/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions",
      headers,
      body,
    );
    if (data.error)
      throw new Error(
        data.error.message || (logfare ? "Logfare" : "OpenRouter") + " error",
      );
    return data;
  }

  /* Jev's decisions endpoint, not chat completions -- see JEV_MODEL
     above. OpenRouter-only: there's no Logfare equivalent, and
     decideByJev checks the provider before ever calling this. */
  async function decisionPost(cfg, body) {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + cfg.apiKey,
      "HTTP-Referer": APP_URL,
      "X-Title": APP_TITLE,
    };
    const data = await post(DECISIONS_URL, headers, body);
    if (data.error) throw new Error(data.error.message || "OpenRouter error");
    return data;
  }

  /* ------------------------------------------------------- can it take a schema

     Previously every call just asked for JSON in the prompt and hoped;
     logging showed roughly a third of player-facing replies came back
     missing fields (English translation, romanization). OpenRouter
     supports telling the model the exact expected shape via OpenAI-style
     `response_format` (which it translates to whatever its backend
     actually speaks) — so this only needs one branch, not one per model.

     Support isn't universal, though, and it's per-endpoint rather than
     per-model: OpenRouter rejects the whole request if the target model
     doesn't support structured outputs, rather than ignoring the field.
     Some models support `response_format` for plain JSON mode without
     supporting the stricter structured-outputs schema, so this can't just
     be assumed available.

     So support is probed once per model, right after the key is
     accepted, and failure is treated as "no" — a failed/unknown lookup
     falls back to prompt-only JSON with repair, same as before this
     existed. */
  const SCHEMA_OK = {}; // 'provider:model' -> true | false, cached after first check
  let orModels = null; // OpenRouter's model list, fetched once and shared with the price lookup below

  async function getJSON(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  function schemaKey(cfg, model) {
    return cfg.provider + ":" + model;
  }

  /* Synchronous check so the send path never blocks on it. Unresolved/unknown reads as false. */
  function schemaOK(cfg, model) {
    return SCHEMA_OK[schemaKey(cfg, model || cfg.model)] === true;
  }

  async function probeOne(cfg, model) {
    const key = schemaKey(cfg, model);
    if (key in SCHEMA_OK) return SCHEMA_OK[key];
    SCHEMA_OK[key] = false; // cached as false unless the lookup below proves otherwise
    // Logfare picks its own backing model, so there's no catalogue to
    // query -- fails closed the same as any other unresolvable lookup.
    if (cfg.provider !== "openrouter") return false;
    try {
      if (!orModels) orModels = getJSON("https://openrouter.ai/api/v1/models");
      const d = await orModels;
      const m = (d.data || []).find((x) => x.id === model);
      SCHEMA_OK[key] =
        !!m &&
        (m.supported_parameters || []).indexOf("structured_outputs") !== -1;
    } catch (e) {
      orModels = null; // don't cache a failed fetch -- allow retrying later
    }
    return SCHEMA_OK[key];
  }

  /* Probes both the main and helper model once, up front. Never throws —
     an unresolved probe is a valid, handled state (see schemaOK). */
  async function probe(cfg) {
    if (!cfg || !cfg.provider) return;
    try {
      await Promise.all([
        probeOne(cfg, cfg.model),
        probeOne(cfg, helperModel(cfg)),
      ]);
    } catch (e) {
      /* fails closed on its own */
    }
  }

  /* ---------------------------------------------------------- nitro, capped

     OpenRouter's `sort: "throughput"` (the ":nitro" shortcut) routes to
     whichever backend provider is fastest, with no price consideration
     at all -- a provider that's marginally faster wins the routing even
     if it costs 100x more per token, since throughput is the only sort
     key. `max_price` fixes this: a hard price ceiling that filters out
     providers before throughput sorting runs, rather than being a
     second sort key
     (https://openrouter.ai/docs/guides/routing/provider-selection).

     The price ceiling is read from Anthropic's current OpenRouter
     listing rather than hardcoded (which would drift out of date) —
     Sonnet's price for the main villager-facing model, Haiku's for cheap
     bookkeeping calls, whichever OpenRouter model the player actually
     selected for either role. Deliberately not the default models' own
     prices: a ceiling equal to a model's cheapest listing would filter
     out most of its providers. Resolved once and cached, same pattern as
     SCHEMA_OK. */
  const PRICE_REF = {
    big: "anthropic/claude-sonnet-5",
    fast: "anthropic/claude-haiku-4.5",
  };
  const maxPriceCache = {}; // 'big' | 'fast' -> {prompt, completion} in $/M tokens, or null

  async function maxPriceFor(kind) {
    if (kind in maxPriceCache) return maxPriceCache[kind];
    maxPriceCache[kind] = null; // cached as null until resolved; never blocks a call either way
    try {
      if (!orModels)
        orModels = getJSON("https://openrouter.ai/api/v1/models");
      const d = await orModels;
      const m = (d.data || []).find((x) => x.id === PRICE_REF[kind]);
      const p = m && m.pricing;
      // OpenRouter lists pricing per token; max_price wants dollars per
      // million, the unit it displays prices in everywhere else.
      if (p && p.prompt != null && p.completion != null) {
        maxPriceCache[kind] = {
          prompt: Number(p.prompt) * 1e6,
          completion: Number(p.completion) * 1e6,
        };
      }
    } catch (e) {
      orModels = null; // don't cache a failed fetch -- allow retrying later
    }
    return maxPriceCache[kind];
  }

  /* ---------------------------------------------------------------- audit

     Every API call goes through providerCall
     below, which is why this is centralized here rather than at each
     call site. Each call is recorded in full — system prompt, messages,
     the *raw* reply before any parsing/repair, timing, and usage — and
     printed as a collapsed console group.

     Recording the raw (pre-repair) reply matters: most bugs in this game
     have come from mismatches between what the model actually returned
     and what the game did with it, which a cleaned-up log would hide.

       LG.llm.audit = false     stop printing (still recorded)
       LG.llm.transcript        the records, newest last
       LG.llm.dump()            the lot as plain text, for copying out */
  /* Identifies which kind of call a log entry is by matching the opening
     of its system prompt. A villager's own system prompt opens with their
     name (not matchable), so those are instead identified by a section
     heading unique to that prompt ('# Your character'). Keep these
     strings in sync with the actual prompt text below, or entries fall
     through to the generic 'call' label. */
  const KINDS = [
    ["You decide what a villager does next", "intent"],
    ["You play one villager", "chatter"],
    ["You verify claims", "notebook"],
    ["You add furigana", "furigana"],
    ["You translate and romanise", "gloss"],
    ["You answer yes or no", "trade"],
  ];
  const transcript = [];
  let audit = true,
    seq = 0;
  const KEEP = 200;

  function kindOf(system) {
    const t = String(system || "");
    for (const [head, name] of KINDS) if (t.indexOf(head) === 0) return name;
    if (t.indexOf("# Your character") !== -1) return "villager";
    return "call";
  }

  /* Extracts the villager's name from the prompt when present, so log
     entries can be labeled by who they're about instead of all showing
     as generic "villager" calls. */
  function subjectOf(system, messages) {
    const t =
      String(system || "") +
      "\n" +
      (messages || []).map((m) => m.content).join("\n");
    const named =
      /^Name:\s*([^—\n.]+)/m.exec(t) || /^You are ([A-Z][\w'-]*)/m.exec(t);
    return named ? named[1].trim() : "";
  }

  function record(cfg, system, messages, out, err, ms, res) {
    const entry = {
      n: ++seq,
      kind: kindOf(system),
      who: subjectOf(system, messages),
      // What actually answered, not what was asked for -- for the "auto"
      // routers (OpenRouter, Logfare) those differ every call, and
      // cfg.model would otherwise just log "openrouter/auto" forever.
      // Falls back to cfg.model when there's no response to read it from
      // (a thrown error) or the provider didn't say (shouldn't happen).
      model: (res && res.model) || cfg.model,
      requestedModel: cfg.model,
      provider: cfg.provider,
      ms: Math.round(ms),
      system: system,
      messages: messages,
      raw: out === undefined ? null : out,
      reasoning: (res && res.reasoning) || null,
      usage: (res && res.usage) || null,
      stop: (res && res.stop) || null,
      // whether the provider enforced the response shape (structured outputs) or it was just requested in-prompt
      schema: !!(res && res.schema),
      // A reasoning model can exhaust its token budget on thinking and never
      // emit the JSON -- that comes back as a 200 with an empty body, so flag it explicitly.
      truncated: !!(
        res &&
        (res.stop === "max_tokens" || res.stop === "length")
      ),
      error: err ? err.message || String(err) : null,
      at: new Date().toISOString(),
    };
    transcript.push(entry);
    if (transcript.length > KEEP) transcript.shift();
    if (LG.logbook) LG.logbook.call(entry); // also persist to disk, if logging is active
    if (audit && typeof console !== "undefined" && console.log) {
      const u = entry.usage || {};
      const tok = u.prompt_tokens
        ? "  " + u.prompt_tokens + "\u2192" + (u.completion_tokens || 0) + " tok"
        : "";
      // Cache reads and writes, where the backend reports them, shown
      // alongside the token count.
      const pd = u.prompt_tokens_details || {};
      const hit = pd.cached_tokens || 0;
      const wrote = pd.cache_write_tokens || 0;
      const cache =
        hit || wrote ? "  cache " + hit + " read, " + wrote + " written" : "";
      const head =
        "%c " +
        entry.kind +
        " %c" +
        (entry.who ? " " + entry.who : "") +
        "  " +
        entry.model +
        "  " +
        entry.ms +
        "ms" +
        tok +
        cache +
        (entry.truncated ? "  CUT OFF (max_tokens)" : "") +
        (err ? "  FAILED" : "");
      const tag =
        "background:" +
        (err ? "#a33" : "#356") +
        ";color:#fff;border-radius:3px;font-weight:600";
      const group = console.groupCollapsed || console.log;
      group.call(console, head, tag, "color:#888");
      console.log("system:\n" + system);
      (messages || []).forEach((m) => console.log(m.role + ":\n" + m.content));
      if (entry.reasoning) console.log("reasoning:\n" + entry.reasoning);
      if (err) console.log("error: " + entry.error);
      else {
        console.log("raw reply:\n" + out);
        if (entry.truncated)
          console.log(
            "*** cut off at max_tokens — the reply is incomplete ***",
          );
        if (entry.usage)
          console.log(
            "usage: " +
              JSON.stringify(entry.usage) +
              (entry.stop ? "  stop: " + entry.stop : ""),
          );
      }
      if (console.groupEnd) console.groupEnd();
    }
    return entry;
  }

  /* Wraps a provider call so a log entry is recorded whether it succeeds or throws. */
  async function audited(cfg, system, messages, run) {
    const t0 =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const since = () =>
      (typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now()) - t0;
    try {
      const res = await run();
      record(cfg, system, messages, res.text, null, since(), res);
      return res.text;
    } catch (e) {
      record(cfg, system, messages, undefined, e, since());
      throw e;
    }
  }

  /* Every API call goes through here. Callers pass the schema they want
     without needing to know whether the target model actually supports
     structured outputs — that check (schemaOK) happens centrally. */
  function providerCall(cfg, system, messages, schema, opts) {
    const s = schema && schemaOK(cfg, cfg.model) ? schema : null;
    return audited(cfg, system, messages, () =>
      send(cfg, system, messages, s, opts),
    );
  }

  function dump() {
    return transcript
      .map(
        (e) =>
          "=== #" +
          e.n +
          "  " +
          e.kind +
          (e.who ? "  " + e.who : "") +
          "  " +
          e.model +
          "  " +
          e.ms +
          "ms  " +
          e.at +
          (e.usage ? "  " + JSON.stringify(e.usage) : "") +
          "\n--- system\n" +
          e.system +
          (e.messages || [])
            .map((m) => "\n--- " + m.role + "\n" + m.content)
            .join("") +
          (e.reasoning ? "\n--- reasoning\n" + e.reasoning : "") +
          (e.truncated ? "\n--- CUT OFF at max_tokens" : "") +
          (e.error ? "\n--- error\n" + e.error : "\n--- raw\n" + e.raw),
      )
      .join("\n\n");
  }

  /* Cap on reasoning tokens for helper-model calls (intent decisions,
     claim checks, trade confirmations) — small, simple judgments that
     don't need extended thinking, but a reasoning model given no cap will
     burn tokens on them anyway. These prompts run ~480-490 tokens
     (session log median/mean), so this cap is roughly a third of that.
     Models without a reasoning budget just ignore this field — OpenRouter
     drops unsupported parameters rather than rejecting the request —
     except Anthropic models via OpenRouter, which clamp any value below
     OpenRouter's own 1024-token floor up to 1024. */
  const FAST_REASONING_TOKENS = 160;

  async function send(cfg, system, messages, schema, opts) {
    const o = opts || {};
    const body = {
      model: modelFor(cfg),
      messages: [{ role: "system", content: system }].concat(messages),
    };
    /* Everything in this block is OpenRouter's alone. Logfare's API
       documents none of it, so Logfare gets the bare request. */
    if (cfg.provider !== "logfare") {
      /* Split at the cache breakpoints (see systemParts). OpenRouter
         passes the breakpoint on to backends that need one (Claude),
         translates it for those that take a different marker, and the
         ones that cache any repeated prefix on their own just see text. */
      body.messages[0].content = systemParts(system, o.cachePrefixes) || system;
      /* OpenRouter can serve one model from several providers, each with
         its own cache, so a turn routed somewhere new starts cold. A
         session id asks it to keep this conversation on one provider --
         best effort, and it lapses after 10 minutes idle. */
      if (o.session) body.session_id = o.session;
      /* The "auto" router has no fixed reasoning budget to cap via
         max_tokens -- `effort` is the parameter it actually respects -- so
         it gets "high" for the main villager-facing model and "medium" for
         helper/bookkeeping calls (still identified via cfg.fast), instead
         of the max_tokens cap used below for non-auto models. */
      if (cfg.model === AUTO_MODEL) body.reasoning = { effort: cfg.fast ? "medium" : "high" };
      else if (cfg.fast) body.reasoning = { max_tokens: FAST_REASONING_TOKENS };
      /* Nitro routing with a price cap -- see the comment on maxPriceFor
         above. If no cap could be resolved (lookup failed, or the
         reference model isn't in OpenRouter's list), no `sort` is sent
         either -- falls back to OpenRouter's normal price-aware default
         rather than optimizing for throughput with no price ceiling. */
      const price = await maxPriceFor(cfg.fast ? "fast" : "big");
      if (price) body.provider = { sort: "throughput", max_price: price };
    }
    if (schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "reply", strict: true, schema: schema },
      };
    }
    const data = await chatPost(cfg, body);
    const choice = (data.choices || [])[0] || {};
    const m = choice.message || {};
    /* Reasoning models return their trace in a separate field, previously
       discarded here (it's useful for debugging odd model decisions).
       Different backends name the field differently, so check both. */
    const think =
      m.reasoning ||
      (Array.isArray(m.reasoning_details)
        ? m.reasoning_details
            .map((d) => d.text || d.summary || "")
            .filter(Boolean)
            .join("\n")
        : null);
    return {
      text: m.content || "",
      reasoning: think || null,
      usage: data.usage || null,
      stop: choice.finish_reason || null,
      schema: !!schema,
      // What actually served the request -- the "auto" routers pick this
      // per call, so it's the only way to tell which model answered.
      model: data.model || null,
    };
  }

  /* Minimal test request, so a bad key or blocked origin is caught up
     front rather than mid-conversation. */
  async function validate(cfg) {
    if (!cfg.apiKey) throw new Error("Please paste an API key.");
    await chatPost(cfg, {
      model: modelFor(cfg),
      max_tokens: 8,
      messages: [
        { role: "system", content: "Reply with one word." },
        { role: "user", content: "Say OK." },
      ],
    });
    return true;
  }

  /* Checks whether the villager's line actually stated each candidate
     fact. The in-character model's own self-reported "revealed" list is
     unreliable — it flags facts it merely mentioned or alluded to, not
     just ones it stated outright. This asks a separate model with no
     character to play and nothing else to track. Fails closed: nothing
     unconfirmed gets recorded. */
  async function judge(cfg, said, translation, candidates, opts) {
    if (!candidates.length) return [];
    /* Jev whenever it's reachable, same as intent() and confirmTrade()
       below -- see DESIGN.md. */
    if (cfg.provider === "openrouter" && cfg.apiKey) {
      return judgeByJev(cfg, said, translation, candidates);
    }
    const lang = (opts && opts.langName) || "the speaker\u2019s language";
    const lines = [
      "You are checking one line of dialogue against a list of statements.",
      "",
      "The speaker said: " + JSON.stringify(said),
      translation ? "In English, that is: " + JSON.stringify(translation) : "",
      "",
      "For each statement below, decide whether that line ACTUALLY TOLD the listener that thing,",
      "plainly enough that the listener could act on it.",
      "",
      "It does NOT count if the speaker merely used the word, explained what the word means,",
      "mentioned the object in passing, asked about it, or hinted at it. The statement has to",
      "have been asserted. When in doubt, leave it out.",
      "",
      "Statements:",
    ].concat(candidates.map((c) => "[" + c.id + "] " + c.text));
    lines.push("");
    lines.push(
      "Reply with only a JSON array. For each statement that WAS genuinely told, add an object:",
    );
    lines.push('  "tag"  - the statement tag');
    lines.push(
      '  "note" - how the listener would jot that down in ' +
        lang +
        ", in one short line.",
    );
    lines.push(
      "           Use the words the speaker actually used. Write it in " +
        lang +
        ", not in English.",
    );
    if (opts && opts.furigana) {
      lines.push('  "ruby" - the same note, annotated:');
      lines.push(LG.FURIGANA);
    }
    if (opts && opts.diacritics) {
      lines.push("           Write it fully vocalised, tashkeel and all:");
      lines.push(LG.TASHKEEL);
    }
    lines.push("");
    lines.push(
      "Leave out anything that was not told. Reply [] if none of them were.",
    );

    const vcfg = helperConfig(cfg);
    let raw;
    try {
      raw = await providerCall(
        vcfg,
        "You verify claims against a transcript. Answer with JSON only.",
        [{ role: "user", content: lines.join("\n") }],
      );
    } catch (e) {
      return []; // never guess on failure
    }
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr;
    try {
      arr = JSON.parse(m[0]);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    const valid = {};
    candidates.forEach((c) => (valid[c.id] = true));
    const out = [];
    arr.forEach((x) => {
      // accept either a bare tag string or the {tag, note, ruby} object form
      const id = String(typeof x === "string" ? x : (x && x.tag) || "").replace(
        /[^\w]/g,
        "",
      );
      if (!valid[id] || out.some((o) => o.id === id)) return;
      out.push({
        id,
        note: (x && typeof x.note === "string" && x.note.trim()) || null,
        ruby: (x && typeof x.ruby === "string" && x.ruby.trim()) || null,
      });
    });
    return out;
  }

  /* Checks whether a line of dialogue actually completed a trade. Only
     called when the player physically offered the correct item but the
     in-character reply didn't flag a completed trade — this second check
     catches cases the villager missed, without letting a wordless
     player action complete a trade on its own. */
  async function confirmTrade(cfg, said, translation, deal) {
    if (cfg.provider === "openrouter" && cfg.apiKey) {
      return confirmTradeByJev(cfg, said, translation, deal);
    }
    const ask = [
      "One line of dialogue, and a question about it.",
      "",
      deal.npcName + " said: " + JSON.stringify(said),
      translation ? "In English, that is: " + JSON.stringify(translation) : "",
      "",
      "The traveller is holding out " + deal.wants + ".",
      "",
      "Question: in that line, did " +
        deal.npcName +
        " accept it and hand over " +
        deal.gives +
        "?",
      "",
      "Being interested, asking a question about it, saying they want it, or agreeing to",
      "trade later is NOT acceptance. They have to be completing the exchange now.",
      "",
      "Answer with one word: yes or no.",
    ].join("\n");
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(
        vcfg,
        "You answer yes or no about what a line of dialogue did.",
        [{ role: "user", content: ask }],
      );
      return /^\W*yes\b/i.test(String(raw).trim());
    } catch (e) {
      return false;
    } // treat a failed check as no deal
  }

  /* Checks whether newly-learned info supersedes something the villager
     already believed, and if so, returns that one belief rewritten to be
     current.

     Doesn't delete old beliefs outright — a villager who learns the shoes
     turned up shouldn't lose "Yuri is looking for shoes", it should
     become "Yuri was looking for shoes, and has them now". So this asks
     which (if any) single existing belief the new info supersedes, and
     for a rewritten version of just that one line.

     Returns at most one revision; "nothing to revise" is a valid and
     common answer when the new info is unrelated to anything held.
     Fails closed: no answer means no change. */
  async function revise(cfg, opts) {
    const o = opts || {};
    const ask = [
      o.who + " already believes these, oldest first:",
      o.held.map((h, i) => i + 1 + ". " + h).join("\n"),
      "",
      "They have just learned: " + JSON.stringify(o.fresh),
      "",
      "Has that overtaken any ONE of the numbered lines — made it out of date, answered",
      "it, or settled it? Something that merely mentions the same people or things has",
      "not overtaken anything.",
      "",
      "If it has, give that number and the line rewritten so that it is true now — same",
      "voice, no longer, and it should still say what it used to say happened, in the past.",
      "",
      "Reply with only a JSON object:",
      '{"n": <the number, or 0 if nothing is out of date>, "line": "<the rewritten line, or an empty string>"}',
    ].join("\n");
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(
        vcfg,
        "You keep one person's beliefs up to date. Answer with JSON only.",
        [{ role: "user", content: ask }],
      );
      const obj = parseJSON(raw);
      const n = obj && Number(obj.n);
      if (!obj || !n || !(n > 0) || n > o.held.length) return null;
      const line = String(obj.line || "").trim();
      if (line.length < 4) return null;
      return { n: n, line: line };
    } catch (e) {
      return null;
    }
  }

  /* Fills in a missing translation or romanization when the in-character
     model's reply omitted one, rather than showing the player a bare
     sentence with no gloss. */
  async function gloss(cfg, say, opts) {
    const o = opts || {};
    const want = ['  "translation": "a plain English translation of the line"'];
    if (o.romanLabel)
      want.push(
        '  "roman": "the ' +
          o.romanLabel +
          " of the line" +
          (o.romanNote ? ", " + o.romanNote : "") +
          '"',
      );
    const ask = [
      "Here is one line of " + (o.langName || "text") + ":",
      "",
      JSON.stringify(say),
      "",
      "Reply with only a JSON object:",
      "{",
      want.join(",\n"),
      "}",
    ].join("\n");
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(
        vcfg,
        "You translate and romanise single lines. Answer with JSON only.",
        [{ role: "user", content: ask }],
      );
      const o2 = parseJSON(raw);
      return o2 || null;
    } catch (e) {
      return null;
    }
  }

  /* Determines what each of two villagers took away from a conversation
     they just had.

     There's no separate "gossip" mechanic that decides in advance what
     gets shared — this just asks, after the fact, what each villager
     would remember from the conversation that actually happened,
     whatever it was about (a fact, small talk, an opinion).

     The `said` field in the response matters specifically because the
     errand chain tracks facts by id, and the notebook depends on knowing
     exactly when a chain fact was actually spoken aloud — a fact that
     wasn't mentioned doesn't get marked as having spread, no matter how
     convenient that would be for the errand. */
  async function recall(cfg, opts) {
    const o = opts || {};
    const side = (who, other) =>
      [
        who.name +
          " knows these things. Which of them did " +
          who.name +
          " actually say out loud?",
        who.facts.length
          ? who.facts.map((f) => "  [" + f.id + "] " + f.text).join("\n")
          : "  (they know nothing in particular, so this list is empty)",
      ].join("\n");
    const lines = [
      "Two villagers have just been talking. Here is what was said:",
      "",
      o.transcript.map((t) => t.who + ": " + t.say).join("\n"),
      "",
      side(o.a, o.b),
      "",
      side(o.b, o.a),
      "",
      "The [f0]-style labels above are just ids for those statements; use them as they are.",
      "",
      "For each of them, write down what they would come away remembering.",
      "Anything from the conversation worth keeping — what the other one told them,",
      "what they are like, what is going on with them. Not everything said is worth",
      "remembering; leave out small talk that told them nothing.",
      "Write each memory as a short plain-English sentence from that villager’s side,",
      'naming who it is about: "Ilya has a dog called Musya", "Mira’s back is bad again".',
      "",
      "Reply with only a JSON object:",
      "{",
      '  "' +
        o.a.name +
        '": {"remembers": ["..."], "said": ["ids ' +
        o.a.name +
        ' actually said, [] if none"]},',
      '  "' +
        o.b.name +
        '": {"remembers": ["..."], "said": ["ids ' +
        o.b.name +
        ' actually said, [] if none"]}',
      "}",
    ].join("\n");
    const vcfg = helperConfig(cfg);
    const sys =
      "You note what people took away from a conversation. Answer with JSON only.";
    try {
      const raw = await providerCall(vcfg, sys, [
        { role: "user", content: lines },
      ]);
      const obj = parseJSON(raw);
      if (!obj) return null;
      const pick = (n) => {
        const v = obj[n] || {};
        return {
          remembers: Array.isArray(v.remembers)
            ? v.remembers.filter((x) => typeof x === "string")
            : [],
          said: Array.isArray(v.said) ? v.said.map(String) : [],
        };
      };
      return { a: pick(o.a.name), b: pick(o.b.name) };
    } catch (e) {
      return null;
    }
  }

  /* Shared plumbing for every Jev decisions-endpoint call: sends
     `{state, questions}`, logs it to the console the same way as any
     other call, and hands back `data.answers` (or null on failure).
     Every caller builds its own state text and typed questions and
     reads back whichever `answers[key].choice` it asked for -- this
     only owns the request/response/logging shape they all share. */
  async function askJev(cfg, sys, state, questions) {
    const body = { model: JEV_MODEL, state, questions };
    // A trimmed-down cfg just for logging -- the real request always
    // targets JEV_MODEL regardless of what cfg.model/helper name.
    const lcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: JEV_MODEL };
    const msg = [
      {
        role: "user",
        content:
          "state:\n" + state + "\n\nquestions:\n" + JSON.stringify(questions, null, 2),
      },
    ];
    try {
      const raw = await audited(lcfg, sys, msg, async () => {
        const data = await decisionPost(lcfg, body);
        const u = data.usage;
        return {
          text: JSON.stringify(data),
          reasoning: null,
          // Jev's usage names its fields input_tokens/output_tokens;
          // aliased here too so the console log's token count (which
          // reads the OpenAI-shaped names) still shows one.
          usage: u
            ? Object.assign({}, u, {
                prompt_tokens: u.input_tokens,
                completion_tokens: u.output_tokens,
              })
            : null,
          stop: null,
          schema: true,
          model: data.model || JEV_MODEL,
        };
      });
      const data = JSON.parse(raw);
      return data.answers || null;
    } catch (e) {
      return null;
    }
  }

  /* Shared by decideByJev and decideByCactusNeedle below: both hand a
     typed-choice model the same view data the chat prompt uses, minus the
     places list and closing instructions -- those become each model's own
     tool/question shape instead. */
  function movementState(o) {
    return [
      "You are " + o.me.name + " — " + o.me.job + ". " + o.me.persona,
      o.goal ? "What you are about: " + o.goal : null,
      "",
      o.when || null,
      "You are " + o.here + ".",
      "",
      o.held && o.held.length
        ? "What you know, and how you came by it:\n" +
          o.held.map((k) => "- " + k).join("\n")
        : null,
      "",
      o.folk && o.folk.length
        ? "Who you have seen about the village:\n" +
          o.folk.map((f) => "- " + f.name + ", " + f.where).join("\n")
        : null,
    ]
      .filter((x) => x !== null && x !== undefined)
      .join("\n");
  }

  /* Asks Jev to pick a destination, in place of the free-text call
     below. Jev only takes typed questions over a fixed set of options,
     and it returns only `{go}`, never `{go, why}`: a System One model
     returns a probability-weighted choice, not a reason for it, and
     decideWhereToGo (game.js) already treats a missing `why` as
     "nothing to report". Fails closed, same as intent() below. */
  async function decideByJev(cfg, o) {
    const state = movementState(o);

    const criteria = {};
    (o.places || []).forEach((p) => {
      criteria[p.name] = p.note || "";
    });

    const questions = {
      go: {
        type: "choice",
        instructions:
          "Decide where " + o.me.name + " should be for the next while.",
        criteria,
      },
    };
    const answers = await askJev(
      cfg,
      "You decide what a villager does next. Answer with a typed choice, not text.",
      state,
      questions,
    );
    const ans = answers && answers.go;
    const choice = ans && typeof ans.choice === "string" ? ans.choice : null;
    return choice ? { go: choice } : null;
  }

  /* Asks Jev whether a line of dialogue actually completed a trade, in
     place of the free-text yes/no call confirmTrade makes below -- same
     fixed-choice shape as decideByJev, just two named options instead
     of a place list. confirmTrade reaches this whenever Jev is reachable
     at all (see DESIGN.md); it checks that itself before ever calling
     here. */
  async function confirmTradeByJev(cfg, said, translation, deal) {
    const state = [
      deal.npcName + " said: " + JSON.stringify(said),
      translation ? "In English, that is: " + JSON.stringify(translation) : null,
      "",
      "The traveller is holding out " + deal.wants + ".",
    ]
      .filter((x) => x !== null)
      .join("\n");
    const questions = {
      deal: {
        type: "choice",
        instructions:
          "Did " + deal.npcName + " accept it and hand over " + deal.gives +
          ", in that line?",
        criteria: {
          yes: "completing the exchange now",
          no: "interested, asking about it, agreeing to trade later, or declining -- not completing it now",
        },
      },
    };
    const answers = await askJev(
      cfg,
      "You decide whether a line of dialogue completed a trade. Answer with a typed choice, not text.",
      state,
      questions,
    );
    return !!(answers && answers.deal && answers.deal.choice === "yes");
  }

  /* Asks Jev which of several candidate facts a line of dialogue
     actually stated outright, one choice question per candidate settled
     in a single call -- cheaper than the helper-model call judge() makes
     below, since Jev is priced by input tokens alone. It cannot write
     the note in the player's language the way the helper model does --
     no generated prose, see JEV_MODEL above -- so a confirmed fact comes
     back with no note, the same shape judge() itself returns when the
     model left one out; verifyRevealed already falls back to the line
     as spoken in that case. */
  async function judgeByJev(cfg, said, translation, candidates) {
    const state = [
      "The speaker said: " + JSON.stringify(said),
      translation ? "In English, that is: " + JSON.stringify(translation) : null,
    ]
      .filter((x) => x !== null)
      .join("\n");
    const questions = {};
    candidates.forEach((c) => {
      questions[c.id] = {
        type: "choice",
        instructions:
          "Did that line state outright, plainly enough to act on, that: " + c.text,
        criteria: {
          yes: "asserted, not merely mentioned, hinted at, or asked about",
          no: "not stated outright",
        },
      };
    });
    const answers = await askJev(
      cfg,
      "You check whether a line of dialogue stated each fact outright. Answer with typed choices, not text.",
      state,
      questions,
    );
    if (!answers) return [];
    return candidates
      .filter((c) => answers[c.id] && answers[c.id].choice === "yes")
      .map((c) => ({ id: c.id, note: null, ruby: null }));
  }

  /* Same job as decideByJev -- a typed top-1 choice over the villager's
     visible places, no generated prose -- but asks Cactus Needle 3, a
     small tool-calling model running locally in the browser (see
     needle.js/needle-worker.js) instead of a network endpoint. It gets a
     single `go` tool whose `destination` parameter is an enum of place
     names. The Worker uses the first call if there are several, returning
     null for a missing call. This inference needs no provider key;
     intent() selects it with cfg.needleMovement alone. */
  async function decideByCactusNeedle(o) {
    const state = movementState(o);
    const places = o.places || [];
    const toolsJson = JSON.stringify([
      {
        type: "function",
        function: {
          name: "go",
          description:
            "Decide where " + o.me.name + " should be for the next while.",
          parameters: {
            type: "object",
            properties: {
              destination: {
                type: "string",
                enum: places.map((p) => p.name),
                description: places
                  .map((p) => p.name + (p.note ? ": " + p.note : ""))
                  .join(". "),
              },
            },
            required: ["destination"],
          },
        },
      },
    ]);
    const sys =
      "You decide what a villager does next. Answer with a typed choice, not text.";
    const lcfg = { provider: "needle", apiKey: "", model: NEEDLE_MODEL };
    const msg = [{ role: "user", content: state }];
    try {
      const raw = await audited(lcfg, sys, msg, async () => {
        const destination = await LG.needle.ask(sys, toolsJson, state);
        return {
          text: JSON.stringify({ go: destination }),
          reasoning: null,
          usage: null,
          stop: null,
          schema: true,
          model: NEEDLE_MODEL,
        };
      });
      const data = JSON.parse(raw);
      return data.go ? { go: data.go } : null;
    } catch (e) {
      return null;
    }
  }

  /* Decides where a villager goes next and why.

     Previously this was purely a probability table (e.g. 60% chance of
     going to work in the morning), independent of what the villager
     actually knew or wanted — a villager looking for a saw would never
     actually go looking for one, and one just told the bakery has bread
     wouldn't walk there. Since villagers already have a goal, memory, and
     a helper model available, this uses that instead of a dice roll.

     Only called when something relevant has changed (arrival, hour
     change, weather change, new fact learned) — an already-settled
     villager isn't re-asked. */
  async function intent(cfg, opts) {
    const o = opts || {};
    // Needle overrides Jev for movement only. Jev still checks trades and facts.
    if (cfg.needleMovement) return decideByCactusNeedle(o);
    if (cfg.provider === "openrouter" && cfg.apiKey) return decideByJev(cfg, o);
    const lines = [
      "You are " + o.me.name + " — " + o.me.job + ". " + o.me.persona,
      o.goal ? "What you are about: " + o.goal : null,
      "",
      o.when || null,
      "You are " + o.here + ".",
      "",
      // dated, attributed list of facts — same content the player-facing prompt shows
      o.held && o.held.length
        ? "What you know, and how you came by it:\n" +
          o.held.map((k) => "- " + k).join("\n")
        : null,
      "",
      /* Locations of nearby villagers, so a fact like "Sanna has the
         cards" can actually be acted on — otherwise a villager could know
         exactly who has something with no way to express going to them. */
      o.folk && o.folk.length
        ? "Who you have seen about the village:\n" +
          o.folk.map((f) => "- " + f.name + ", " + f.where).join("\n")
        : null,
      "",
      /* Places are given as a literal JSON array of accepted strings,
         not a bulleted list — a bulleted list gets answered in loose
         prose (e.g. "village green" for "the village green"), which then
         fails to match any option and silently leaves the villager
         stuck. */
      'Places you could go. "go" must be one of these strings exactly:',
      JSON.stringify(o.places.map((p) => p.name)),
      o.places.some((p) => p.note)
        ? o.places
            .filter((p) => p.note)
            .map((p) => "  " + p.name + " \u2014 " + p.note)
            .join("\n")
        : null,
      "",
      /* Bug history: an earlier version of this prompt ended "even if the
         reason is only that it is your own bed and it is late," meant as
         permission to give a mundane answer. A model instead treated it
         as a literal precondition — one villager's reasoning concluded
         the "bed" clause didn't apply because it wasn't actually late. */
      "Decide where to be for the next while, and why.",
      "",
      "Reply with only a JSON object:",
      '{"go": "exactly one of the strings listed above", "why": "a few words, in English"}',
    ]
      .filter((x) => x !== null && x !== undefined)
      .join("\n");
    const vcfg = helperConfig(cfg);
    const sys = "You decide what a villager does next. Answer with JSON only.";
    try {
      const raw = await providerCall(vcfg, sys, [
        { role: "user", content: lines },
      ]);
      const obj = parseJSON(raw);
      if (!obj || !obj.go) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* Decides whether a villager at the noticeboard has anything worth
     posting, and writes it if so.

     Nothing is pre-selected as postable content, same as recall() doesn't
     pre-select what gets remembered from a conversation — this can be
     about their own errand, or unrelated (a complaint, a warning, news,
     an offer). Declining to post is a valid, expected answer; nothing
     forces a post to happen. */
  async function notice(cfg, opts) {
    const o = opts || {};
    const lines = [
      "You are " + o.me.name + " — " + o.me.job + ". " + o.me.persona,
      o.goal ? "What you are about: " + o.goal : null,
      "",
      o.when || null,
      "You are at the village noticeboard, where anyone may pin up a note for the whole village to read.",
      "",
      o.held && o.held.length
        ? "What you know, and how you came by it:\n" +
          o.held.map((k) => "- " + k).join("\n")
        : null,
      "",
      o.board && o.board.length
        ? "Already pinned up there:\n" + o.board.map((t) => "- " + t).join("\n")
        : "Nothing is pinned up there right now.",
      "",
      "Decide whether you have anything worth pinning up right now. It does not have to be your own business — a complaint, a warning, an offer, news, anything a person standing here might actually post. Having nothing to say is a perfectly good answer; do not invent something just to have posted.",
      "",
      "If you do post, write it the way it would actually be written up — short, public, in your own words.",
      "",
      ("In " + o.langName + ". " + (o.register || "")).trim(),
      "",
      "Reply with only a JSON object:",
      '{"post": true or false,',
      ' "text": "what you pin up, in ' +
        o.langName +
        ' — empty string if post is false",',
      ' "translation": "plain English, or empty string if post is false"' +
        (o.romanLabel
          ? ',\n "roman": "' +
            o.romanLabel +
            (o.romanNote ? ", " + o.romanNote : "") +
            ', or empty string if post is false"'
          : "") +
        ",",
      ' "revealed": ["ids from what you know that this notice states outright, [] if none or if post is false"]}',
    ]
      .filter((x) => x !== null && x !== undefined)
      .join("\n");
    const vcfg = helperConfig(cfg);
    const sys =
      "You decide whether a villager posts a notice, and write it if so. Answer with JSON only.";
    try {
      const raw = await providerCall(vcfg, sys, [
        { role: "user", content: lines },
      ]);
      const obj = parseJSON(raw);
      if (!obj) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* Generates one villager's next line in a conversation with another
     villager — one call per turn, deliberately, rather than one call
     writing the whole exchange. Two models improvising independently
     produce a real back-and-forth; one model writing both sides tends to
     produce something that reads as scripted (both sides agree too
     neatly, nobody misunderstands, nothing is said that wasn't already
     set up). Using the cheap helper model per-turn keeps a multi-turn
     conversation affordable. */
  async function converse(cfg, opts) {
    const o = opts || {};
    const said = (o.transcript || []).map((t) => t.who + ": " + t.say);
    const lines = [
      "You are " + o.me.name + " — " + o.me.job + ". " + o.me.persona,
      /* Bug history: this used to unconditionally say "you have run into
         X" and that both parties were on their way elsewhere — even for
         two villagers who had each deliberately walked somewhere and
         arrived. Every conversation read as an interruption, and
         villagers kept telling each other to go home. Now states where
         they actually are and why, based on their real decision. */
      o.here ? "You are " + o.here + "." : null,
      /* `o.them`'s persona is included here (not just name/job) since
         two villagers who've lived here for years already know what
         each other is like — see the roster note below for the same
         reasoning applied to the rest of the village. Only `o.errand`
         (what brought them here today) is actually new information. */
      o.sought
        ? "You came looking for " +
          o.them.name +
          ", " +
          o.them.job +
          (o.them.persona ? ". " + o.them.persona : "") +
          "." +
          (o.errand ? " What brought you: " + o.errand + "." : "")
        : o.errand
          ? "What brought you here: " + o.errand + "."
          : null,
      o.sought
        ? null
        : o.them.name + ", " + o.them.job + ", is here too." +
          (o.them.persona ? " " + o.them.persona : ""),
      o.when || null,
      "",
      /* Roster of everyone else in the village by name/job/persona —
         same background info a villager gets when talking to the player.
         Lets a third party get mentioned naturally ("Tomas has one of
         those, he never lends it out") instead of the name seeming to
         come from nowhere. */
      o.me.roster && o.me.roster.length
        ? "Everyone else in the village:\n" +
          o.me.roster.map((r) => "- " + r.name + " — " + r.job + ". " + r.persona).join("\n")
        : null,
      "",
      // same dated fact list the other prompts (intent, notice) get
      o.held && o.held.length
        ? "What you know, and how you came by it — say any of it if it comes up:\n" +
          o.held.map((k) => "- " + k).join("\n")
        : null,
      "",
      /* Removed: this prompt used to include a purse, stock, and wants
         list so two villagers could trade with each other. Nothing
         downstream actually executes villager-to-villager trades — the
         game has no code path for one villager handing an item to
         another — so describing tradeable goods just led to villagers
         "agreeing" to deals that never actually happened. This will come
         back if/when that mechanic is implemented. */
      said.length
        ? "So far:\n" + said.join("\n")
        : "Neither of you has said anything yet.",
      "",
      o.closing
        ? "This is the last thing you will say in this conversation."
        : null,
      "Say your next line. A line or two.",
      "",
      ("In " + o.langName + ". " + (o.register || "")).trim(),
      /* The player reads these lines too, so they need to actually be
         sentences. This rule exists in the player-facing prompt but was
         previously missing here, which let a terse character produce
         telegraphese like "\u9ec4\u660f\u51b7\uff1f" — not something
         anyone would actually say.

         Deliberately says nothing about length. An earlier version ended
         "terse is fine, ungrammatical is not" — and models fixated on
         "terse" as the instruction, over-shortening replies. How long a
         villager's lines are is a character trait; whether they're
         grammatical sentences is not negotiable. */
      "Say it the way a real " +
        o.langName +
        " speaker would actually say it out loud.",
      /* Villager-to-villager dialogue is logged verbatim, and that log
         is supposed to contain no English at all — overhearing it is a
         comprehension exercise, and English narration would leak the
         answer. The actual leak observed wasn't translated dialogue but
         English stage directions (e.g. *shuffles feet*) embedded inside
         otherwise-toki-pona lines, in 18% of sampled lines. Suppressing
         stage directions entirely was the alternative fix, but a
         character description action mid-sentence is worth keeping, so
         this instructs writing the gesture in-language instead of
         removing it.

         Phrased positively (what to do, not what to avoid) per
         DESIGN.md's general guidance against naming failure modes in a
         prompt — naming "English stage directions" as the thing to avoid
         would put that English text in the model's own context. Measured
         on 298 toki pona chatter prompts (Haiku, two runs vs. two
         baselines): English words inside asterisks dropped from 349/313
         to 128/98, while total asterisk usage (i.e. gestures overall)
         rose by about half.

         Since this fix was only measured for toki pona, `stageInLang`
         (data.js) gates it to that language only — the other supported
         languages get no instruction about this, since there's no
         measured evidence they have the same leak. Every prompt line
         costs context and can bias output, so adding this rule
         everywhere without evidence it's needed elsewhere would be a
         guess; add the flag for another language once it's been measured
         there too. */
      o.stageInLang
        ? "Whatever you are doing while you speak — a glance, a shrug, flour wiped off your hands — belongs in " +
          o.langName +
          " like everything else you say."
        : null,
      o.grammarNote ? "In " + o.langName + ", " + o.grammarNote : null,
      o.furigana ? 'Put the furigana in "say".\n' + LG.FURIGANA : null,
      o.diacritics
        ? 'Write "say" fully vocalised, tashkeel and all.\n' + LG.TASHKEEL
        : null,
      "",
      "Reply with only a JSON object:",
      '{"say": "your line", "translation": "plain English"' +
        (o.romanLabel
          ? ', "roman": "' +
            o.romanLabel +
            (o.romanNote ? ", " + o.romanNote : "") +
            '"'
          : "") +
        "}",
    ]
      .filter((x) => x !== null && x !== undefined)
      .join("\n");
    const vcfg = helperConfig(cfg);
    const sys =
      "You play one villager in a two-person conversation. Answer with JSON only.";
    try {
      const raw = await providerCall(vcfg, sys, [
        { role: "user", content: lines },
      ]);
      const obj = parseJSON(raw);
      if (!obj || !obj.say) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* Adds furigana to a Japanese line when the in-character model's reply
     omitted the ruby field or left it unmarked. Returns null on anything
     unexpected. */
  async function furigana(cfg, say, attempt) {
    const ask = [
      "Add furigana to this Japanese sentence.",
      "",
      "Sentence: " + JSON.stringify(say),
      "",
      "Return the sentence exactly as it is, with the readings added.",
      LG.FURIGANA,
      "Even a single kanji gets one.",
      "Change nothing else: same words, same kana, same punctuation, same order.",
      "",
      "Reply with only the rewritten sentence, no quotes and no explanation.",
    ]
      .concat(
        attempt
          ? [
              "",
              "A previous attempt came back different from the sentence above. Copy the sentence",
              "character for character and add ruby tags around the kanji — do not reword it, do not",
              "add or remove punctuation, and do not wrap it in quotes.",
            ]
          : [],
      )
      .join("\n");
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(
        vcfg,
        "You add furigana to Japanese text. Output the sentence only.",
        [{ role: "user", content: ask }],
      );
      return String(raw).trim();
    } catch (e) {
      return null;
    }
  }

  const FIELDS =
    "say|translation|roman|ruby|understood|remember|action|revealed";

  /* Fixes common small JSON malformations from model output (missing/
     curly quotes, trailing commas). Purely structural fixes — none of
     these invent or alter content. */
  function repairJSON(t) {
    return (
      t
        // Handle curly quotes first -- otherwise the missing-quote rule
        // below fires on them, leaving the curly quote stranded inside the value.
        .replace(
          new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)[\u201c\u201d]', "g"),
          '$1"',
        )
        .replace(/[\u201c\u201d](\s*[,}])/g, '"$1')
        // Handles a value's opening quote being missing entirely (e.g. "say":值...").
        .replace(
          new RegExp(
            '("(?:' + FIELDS + ')"\\s*:\\s*)(?=[^"\\[{\\s\\dtfn-])',
            "g",
          ),
          '$1"',
        )
        // Removes a trailing comma before a closing brace/bracket.
        .replace(/,(\s*[}\]])/g, "$1")
    );
  }

  /* Last-resort fallback: extracts fields by regex when the reply isn't
     valid JSON at all. Used to avoid ever showing the player a raw brace
     or malformed JSON. */
  function salvage(text) {
    const out = {};
    ["say", "translation", "roman", "ruby", "understood", "action"].forEach(
      (k) => {
        const re = new RegExp(
          '"' +
            k +
            '"\\s*:\\s*"?([\\s\\S]*?)"?\\s*(?=,\\s*"(?:' +
            FIELDS +
            ')"\\s*:|\\}|$)',
        );
        const m = text.match(re);
        if (m && m[1]) out[k] = m[1].replace(/^"|"$/g, "").trim();
      },
    );
    return out.say ? out : null;
  }

  /* Extracts the first balanced {...} substring, tracking string state to
     avoid matching braces inside string values. Run after repairJSON, not
     before — an unrepaired missing quote would throw off the in-string
     tracking here. */
  function extractObject(t) {
    const start = t.indexOf("{");
    if (start === -1) return null;
    let depth = 0,
      inStr = false,
      esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
    return null;
  }

  /* Extracts the reply object, tolerating ```json code fences, surrounding
     prose, and the small malformations models tend to produce. */
  function parseJSON(text) {
    if (!text) return null;
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();

    const repaired = repairJSON(t);
    for (const cand of [t, repaired]) {
      const chunk = extractObject(cand);
      if (!chunk) continue;
      try {
        return JSON.parse(chunk);
      } catch (e) {}
      try {
        return JSON.parse(repairJSON(chunk));
      } catch (e) {}
    }
    return salvage(repaired) || salvage(t);
  }

  /* Returns the parsed JSON object the character replied with. `opts`
     may carry `cachePrefixes`, leading parts of `system` that stay the
     same turn to turn (each cached -- see systemParts), and `session`, an id
     for the conversation (OpenRouter's sticky routing). Logfare's API
     isn't known to take either, so it's sent neither. */
  async function speak(cfg, system, messages, schema, opts) {
    const raw = await providerCall(cfg, system, messages, schema, opts);
    const obj = parseJSON(raw);
    if (!obj || !obj.say) {
      // Never show the player raw/malformed JSON -- let the caller report a failure instead.
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "[dialogue] could not read this reply:\n" + String(raw).slice(0, 600),
        );
      }
      return null;
    }
    return obj;
  }

  return {
    MODELS,
    HELPERS,
    helperModel,
    speak,
    judge,
    furigana,
    gloss,
    converse,
    intent,
    notice,
    recall,
    get transcript() {
      return transcript;
    },
    dump,
    get audit() {
      return audit;
    },
    set audit(v) {
      audit = !!v;
    },
    confirmTrade,
    validate,
    probe,
    schemaOK,
    revise,
    parseJSON,
    repairJSON,
    salvage,
  };
})();
