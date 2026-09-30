/* llm.js — LLM provider abstraction for OpenRouter and Logfare, called
   directly from the browser. */
window.LG = window.LG || {};

LG.llm = (function () {
  /* Logfare's only model: it routes to whichever backend it rates best,
     so the send path hardcodes it rather than trusting cfg.model. */
  const LOGFARE_MODEL = 'logfare/auto';

  /* OpenRouter's router picks the backend per request. Not offered in the
     lists below, but honoured if typed in; `send` gives it a reasoning
     effort instead of a token cap. */
  const AUTO_MODEL = 'openrouter/auto';

  /* TypeSafe's Jev takes `state` plus typed questions and returns a choice
     with a probability, no prose. It has its own endpoint (decisionPost/
     askJev), OpenRouter only, and can't write dialogue, so it isn't in
     MODELS/HELPERS. Used automatically for movement, trade confirmation and
     fact-checking whenever it's reachable (see DESIGN.md). */
  const JEV_MODEL = 'typesafe/jev-1.13';
  const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

  /* One offered model per role; anything else goes in the "Other" box. */
  const MODELS = {
    openrouter: [
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' }
    ],
    logfare: [{ id: LOGFARE_MODEL, label: 'Auto' }]
  };

  /* The helper does the bookkeeping the in-character model is bad at:
     fact-checking, furigana, glosses. Cheap and literal is what it needs. */
  const HELPERS = {
    openrouter: [{ id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash' }],
    logfare: [{ id: LOGFARE_MODEL, label: 'Auto' }]
  };
  // The player's choice, else the provider's default helper, else the main model.
  function helperModel(cfg) {
    const list = HELPERS[cfg && cfg.provider];
    return (cfg && cfg.helper) || (list && list[0].id) || (cfg && cfg.model);
  }

  /* What every bookkeeping call runs under: same provider and key, the
     helper model, and `fast` for send's cheaper reasoning settings. */
  function helperConfig(cfg) {
    return {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: helperModel(cfg),
      fast: true
    };
  }

  /* Turns transport and HTTP failures into messages a player can act on.
     The usual one is a file:// page, which fails the provider's CORS check. */
  async function post(url, headers, body) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Could not reach the API. If you opened this page as a file, ' +
        'serve it over http instead (see the README) — browsers block API calls from file:// pages.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('That key was rejected (' + res.status + '). Check it is correct and still active.');
    }
    if (res.status === 404) {
      throw new Error('The model "' + (body.model || '?') + '" was not found on this provider, ' +
        'or your key has no access to it.');
    }
    if (res.status === 429)
      throw new Error('Rate limited. Wait a moment and try again.');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 240); } catch (e) {}
      throw new Error('API error ' + res.status + (detail ? ': ' + detail : ''));
    }
    return res.json();
  }

  /* The system prompt as text blocks, cut where each of `prefixes` ends,
     with a cache breakpoint at every cut. A cache read can only land where
     an earlier request put a breakpoint, so cutting after each stretch that
     stays the same turn to turn (see buildReply in dialogue.js) lets a later
     turn reuse as much as is unchanged. Prefixes that don't lead `system`
     are skipped; the blocks concatenate back to the original string. Null
     when there's nothing to cut. */
  function systemParts(system, prefixes) {
    if (typeof system !== 'string') return null;
    const cuts = [].concat(prefixes || [])
      .filter(p => p && system.indexOf(p) === 0)
      .map(p => p.length)
      .sort((x, y) => x - y);
    const parts = [];
    let at = 0;
    cuts.forEach(end => {
      if (end <= at) return;                   // the same cut twice
      parts.push({ type: 'text', text: system.slice(at, end), cache_control: { type: 'ephemeral' } });
      at = end;
    });
    if (!parts.length) return null;
    if (at < system.length) parts.push({ type: 'text', text: system.slice(at) });
    return parts;
  }

  /* OpenRouter attributes calls to an app keyed by this URL. Hardcoded, since
     location.origin is "null" on file://. Changing APP_URL starts a new app
     with its own history; APP_TITLE can change freely. */
  const APP_URL = 'https://github.com/TetraspaceW/little-village';
  const APP_TITLE = 'Little Village (Beta)';

  /* Both providers speak OpenAI-shaped chat completions; Logfare always
     gets its one model, whatever custom value is left in cfg. */
  function modelFor(cfg) {
    return cfg.provider === 'logfare' ? LOGFARE_MODEL : cfg.model;
  }

  async function chatPost(cfg, body) {
    const logfare = cfg.provider === 'logfare';
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey };
    if (!logfare) {
      headers['HTTP-Referer'] = APP_URL;
      headers['X-Title'] = APP_TITLE;
    }
    const data = await post(logfare ? 'https://logfare.ai/v1/chat/completions'
                                    : 'https://openrouter.ai/api/v1/chat/completions', headers, body);
    if (data.error)
      throw new Error(data.error.message || (logfare ? 'Logfare' : 'OpenRouter') + ' error');
    return data;
  }

  /* Jev's decisions endpoint (see JEV_MODEL). OpenRouter only. */
  async function decisionPost(cfg, body) {
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + cfg.apiKey,
      'HTTP-Referer': APP_URL,
      'X-Title': APP_TITLE
    };
    const data = await post(DECISIONS_URL, headers, body);
    if (data.error) throw new Error(data.error.message || 'OpenRouter error');
    return data;
  }

  /* ------------------------------------------------------- can it take a schema
     OpenRouter rejects a request whose schema the model can't take, and
     support is per endpoint, so it's looked up once per model from the
     catalogue's `supported_parameters`. Anything unknown counts as no:
     prompt-only JSON with repair. */
  const SCHEMA_OK = {};              // 'provider:model' -> true | false
  let orModels = null;               // OpenRouter's model list, fetched once, shared with maxPriceFor

  async function getJSON(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function schemaKey(cfg, model) {
    return cfg.provider + ':' + model;
  }

  /* Synchronous, so sending never waits on it. Unresolved reads as false. */
  function schemaOK(cfg, model) {
    return SCHEMA_OK[schemaKey(cfg, model || cfg.model)] === true;
  }

  async function probeOne(cfg, model) {
    const key = schemaKey(cfg, model);
    if (key in SCHEMA_OK) return SCHEMA_OK[key];
    SCHEMA_OK[key] = false;
    // Logfare picks its own backend, so there's no catalogue to ask.
    if (cfg.provider !== 'openrouter') return false;
    try {
      if (!orModels) orModels = getJSON('https://openrouter.ai/api/v1/models');
      const d = await orModels;
      const m = (d.data || []).find(x => x.id === model);
      SCHEMA_OK[key] = !!m && (m.supported_parameters || []).indexOf('structured_outputs') !== -1;
    } catch (e) {
      orModels = null;               // a failed fetch isn't cached
    }
    return SCHEMA_OK[key];
  }

  /* Looks up the main and helper model. Never throws. */
  async function probe(cfg) {
    if (!cfg || !cfg.provider) return;
    try {
      await Promise.all([
        probeOne(cfg, cfg.model),
        probeOne(cfg, helperModel(cfg))
      ]);
    } catch (e) {
      /* fails closed on its own */
    }
  }

  /* ---------------------------------------------------------- nitro, capped
     `sort: "throughput"` alone routes to the fastest backend whatever it
     costs; `max_price` filters providers out before that sort. The ceiling
     is read from a reference model's listing (Sonnet for the main model,
     Haiku for the helper) rather than hardcoded, and deliberately isn't the
     chosen model's own price, which would filter out most of its providers. */
  const PRICE_REF = {
    big: 'anthropic/claude-sonnet-5',
    fast: 'anthropic/claude-haiku-4.5'
  };
  const maxPriceCache = {};          // 'big' | 'fast' -> {prompt, completion} in $/M tokens, or null

  async function maxPriceFor(kind) {
    if (kind in maxPriceCache) return maxPriceCache[kind];
    maxPriceCache[kind] = null;      // never blocks a call while it resolves
    try {
      if (!orModels)
        orModels = getJSON('https://openrouter.ai/api/v1/models');
      const d = await orModels;
      const m = (d.data || []).find(x => x.id === PRICE_REF[kind]);
      const p = m && m.pricing;
      // Listed per token; max_price wants dollars per million.
      if (p && p.prompt != null && p.completion != null) {
        maxPriceCache[kind] = {
          prompt: Number(p.prompt) * 1e6,
          completion: Number(p.completion) * 1e6
        };
      }
    } catch (e) {
      orModels = null;
    }
    return maxPriceCache[kind];
  }

  /* ---------------------------------------------------------------- audit
     Every call is recorded in full — system prompt, messages, the raw reply
     before any repair, timing, usage — and printed as one console line with
     the record attached. (Printing the whole prompt stalled Firefox; see
     DESIGN.md.)

       LG.llm.audit = false     stop printing (still recorded)
       LG.llm.transcript        the records, newest last
       LG.llm.dump()            the lot as plain text, for copying out

     Each caller names its call: `kind` is what the call is for (villager,
     chatter, intent, notebook, trade, gloss, furigana, revise, recall,
     notice) and `who` the villager it's about. tools/latency-report.js
     groups by `kind`. */
  const transcript = [];
  let audit = true, seq = 0;
  const KEEP = 200;

  function record(cfg, system, messages, out, err, ms, res, tag) {
    const entry = {
      n: ++seq,
      kind: (tag && tag.kind) || 'call',
      who: (tag && tag.who) || '',
      // What answered, not what was asked for: the auto routers differ per call.
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
      // whether the provider enforced the response shape, or it was only asked for in the prompt
      schema: !!(res && res.schema),
      // A reasoning model can spend its budget thinking and return an empty 200.
      truncated: !!(res && (res.stop === 'max_tokens' || res.stop === 'length')),
      error: err ? err.message || String(err) : null,
      at: new Date().toISOString()
    };
    transcript.push(entry);
    if (transcript.length > KEEP) transcript.shift();
    if (LG.logbook) LG.logbook.call(entry);     // and to disk, when the log server is running
    if (audit && typeof console !== 'undefined' && console.log) {
      const u = entry.usage || {};
      const tok = u.prompt_tokens
        ? '  ' + u.prompt_tokens + '\u2192' + (u.completion_tokens || 0) + ' tok'
        : '';
      const pd = u.prompt_tokens_details || {};
      const hit = pd.cached_tokens || 0;
      const wrote = pd.cache_write_tokens || 0;
      const cache =
        hit || wrote ? '  cache ' + hit + ' read, ' + wrote + ' written' : '';
      const head = '%c ' + entry.kind + ' %c' + (entry.who ? ' ' + entry.who : '') + '  ' +
        entry.model + '  ' + entry.ms + 'ms' + tok + cache +
        (entry.truncated ? '  CUT OFF (max_tokens)' : '') + (err ? '  FAILED' : '');
      const tag = 'background:' + (err ? '#a33' : '#356') + ';color:#fff;border-radius:3px;font-weight:600';
      console.log(head, tag, 'color:#888', entry);
    }
    return entry;
  }

  /* Runs a provider call and records it, whether it succeeds or throws.
     `tag` is {kind, who}. */
  async function audited(cfg, system, messages, run, tag) {
    const t0 = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
    const since = () =>
      (typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now()) - t0;
    try {
      const res = await run();
      record(cfg, system, messages, res.text, null, since(), res, tag);
      return res.text;
    } catch (e) {
      record(cfg, system, messages, undefined, e, since(), undefined, tag);
      throw e;
    }
  }

  /* Every chat call goes through here. Callers pass the schema they want;
     whether the model takes one is decided here (schemaOK). `opts` carries
     the call's `kind` and `who` for the log, and send's options. */
  function providerCall(cfg, system, messages, schema, opts) {
    const s = schema && schemaOK(cfg, cfg.model) ? schema : null;
    return audited(cfg, system, messages, () =>
      send(cfg, system, messages, s, opts), opts);
  }

  function dump() {
    return transcript.map(e =>
      '=== #' + e.n + '  ' + e.kind + (e.who ? '  ' + e.who : '') + '  ' + e.model + '  ' +
      e.ms + 'ms  ' + e.at + (e.usage ? '  ' + JSON.stringify(e.usage) : '') +
      (e.system ? '\n--- system\n' + e.system : '') +
      (e.messages || []).map(m => '\n--- ' + m.role + '\n' + m.content).join('') +
      (e.reasoning ? '\n--- reasoning\n' + e.reasoning : '') +
      (e.truncated ? '\n--- CUT OFF at max_tokens' : '') +
      (e.error ? '\n--- error\n' + e.error : '\n--- raw\n' + e.raw)
    ).join('\n\n');
  }

  /* Reasoning cap for helper calls: small judgments that gain nothing from
     long thinking. Models without a reasoning budget ignore it; Anthropic
     models via OpenRouter clamp it up to 1024. */
  const FAST_REASONING_TOKENS = 160;

  async function send(cfg, system, messages, schema, opts) {
    const o = opts || {};
    const body = {
      model: modelFor(cfg),
      messages: [{ role: 'system', content: system }].concat(messages)
    };
    // Everything in this block is OpenRouter's; Logfare gets the bare request.
    if (cfg.provider !== 'logfare') {
      // Cache breakpoints (see systemParts); backends that cache any repeated prefix just see text.
      body.messages[0].content = systemParts(system, o.cachePrefixes) || system;
      /* Keeps one conversation on one backend provider, so its cache stays
         warm. Best effort; lapses after 10 minutes idle. */
      if (o.session) body.session_id = o.session;
      // The auto router respects `effort`, not a token cap.
      if (cfg.model === AUTO_MODEL) body.reasoning = { effort: cfg.fast ? 'medium' : 'high' };
      else if (cfg.fast) body.reasoning = { max_tokens: FAST_REASONING_TOKENS };
      // No resolvable price cap means no throughput sort either (see maxPriceFor).
      const price = await maxPriceFor(cfg.fast ? 'fast' : 'big');
      if (price) body.provider = { sort: 'throughput', max_price: price };
    }
    if (schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'reply', strict: true, schema: schema }
      };
    }
    const data = await chatPost(cfg, body);
    const choice = (data.choices || [])[0] || {};
    const m = choice.message || {};
    // Backends name the reasoning trace differently.
    const think =
      m.reasoning ||
      (Array.isArray(m.reasoning_details)
        ? m.reasoning_details.map(d => d.text || d.summary || '').filter(Boolean).join('\n')
        : null);
    return {
      text: m.content || '',
      reasoning: think || null,
      usage: data.usage || null,
      stop: choice.finish_reason || null,
      schema: !!schema,
      model: data.model || null      // which model the auto routers actually picked
    };
  }

  /* A minimal request, so a bad key or blocked origin shows up at the
     settings panel rather than mid-conversation. */
  async function validate(cfg) {
    if (!cfg.apiKey) throw new Error('Please paste an API key.');
    await chatPost(cfg, {
      model: modelFor(cfg),
      max_tokens: 8,
      messages: [
        { role: 'system', content: 'Reply with one word.' },
        { role: 'user', content: 'Say OK.' }
      ]
    });
    return true;
  }

  /* Checks which candidate facts a line actually stated. The in-character
     model flags facts it merely mentioned, so a model with nothing else to
     track decides. Fails closed: nothing unconfirmed is recorded. */
  async function judge(cfg, said, translation, candidates, opts) {
    if (!candidates.length) return [];
    if (cfg.provider === 'openrouter' && cfg.apiKey) {
      return judgeByJev(cfg, said, translation, candidates, opts && opts.who);
    }
    const lang = (opts && opts.langName) || 'the speaker\u2019s language';
    const lines = [
      'You are checking one line of dialogue against a list of statements.',
      '',
      'The speaker said: ' + JSON.stringify(said),
      translation ? 'In English, that is: ' + JSON.stringify(translation) : '',
      '',
      'For each statement below, decide whether that line ACTUALLY TOLD the listener that thing,',
      'plainly enough that the listener could act on it.',
      '',
      'It does NOT count if the speaker merely used the word, explained what the word means,',
      'mentioned the object in passing, asked about it, or hinted at it. The statement has to',
      'have been asserted. When in doubt, leave it out.',
      '',
      'Statements:'
    ].concat(candidates.map(c => '[' + c.id + '] ' + c.text));
    lines.push('');
    lines.push('Reply with only a JSON array. For each statement that WAS genuinely told, add an object:');
    lines.push('  "tag"  - the statement tag');
    lines.push('  "note" - how the listener would jot that down in ' + lang + ', in one short line.');
    lines.push('           Use the words the speaker actually used. Write it in ' + lang + ', not in English.');
    if (opts && opts.furigana) {
      lines.push('  "ruby" - the same note, annotated:');
      lines.push(LG.FURIGANA);
    }
    if (opts && opts.diacritics) {
      lines.push('           Write it fully vocalised, tashkeel and all:');
      lines.push(LG.TASHKEEL);
    }
    lines.push('');
    lines.push('Leave out anything that was not told. Reply [] if none of them were.');

    const vcfg = helperConfig(cfg);
    let raw;
    try {
      raw = await providerCall(vcfg, 'You verify claims against a transcript. Answer with JSON only.',
        [{ role: 'user', content: lines.join('\n') }], null, { kind: 'notebook', who: opts && opts.who });
    } catch (e) {
      return [];                     // never guess on failure
    }
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const valid = {};
    candidates.forEach(c => (valid[c.id] = true));
    const out = [];
    arr.forEach(x => {
      // a bare tag string, or the {tag, note, ruby} object
      const id = String(typeof x === 'string' ? x : (x && x.tag) || '').replace(/[^\w]/g, '');
      if (!valid[id] || out.some(o => o.id === id)) return;
      out.push({
        id,
        note: (x && typeof x.note === 'string' && x.note.trim()) || null,
        ruby: (x && typeof x.ruby === 'string' && x.ruby.trim()) || null
      });
    });
    return out;
  }

  /* Whether a line completed a trade. Called only when the player held out
     the right item and the reply didn't flag the trade, so a wordless
     gesture can't complete one on its own. */
  async function confirmTrade(cfg, said, translation, deal) {
    if (cfg.provider === 'openrouter' && cfg.apiKey) {
      return confirmTradeByJev(cfg, said, translation, deal);
    }
    const ask = [
      'One line of dialogue, and a question about it.',
      '',
      deal.npcName + ' said: ' + JSON.stringify(said),
      translation ? 'In English, that is: ' + JSON.stringify(translation) : '',
      '',
      'The traveller is holding out ' + deal.wants + '.',
      '',
      'Question: in that line, did ' + deal.npcName + ' accept it and hand over ' + deal.gives + '?',
      '',
      'Being interested, asking a question about it, saying they want it, or agreeing to',
      'trade later is NOT acceptance. They have to be completing the exchange now.',
      '',
      'Answer with one word: yes or no.'
    ].join('\n');
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(vcfg, 'You answer yes or no about what a line of dialogue did.',
        [{ role: 'user', content: ask }], null, { kind: 'trade', who: deal.npcName });
      return /^\W*yes\b/i.test(String(raw).trim());
    } catch (e) {
      return false;
    }                                // a failed check is no deal
  }

  /* When new information overtakes one thing a villager believed, returns
     that line rewritten to be true now ("was looking for shoes, and has them
     now") rather than deleting it. At most one revision; null for none. */
  async function revise(cfg, opts) {
    const o = opts || {};
    const ask = [
      o.who + ' already believes these, oldest first:',
      o.held.map((h, i) => i + 1 + '. ' + h).join('\n'),
      '',
      'They have just learned: ' + JSON.stringify(o.fresh),
      '',
      'Has that overtaken any ONE of the numbered lines — made it out of date, answered',
      'it, or settled it? Something that merely mentions the same people or things has',
      'not overtaken anything.',
      '',
      'If it has, give that number and the line rewritten so that it is true now — same',
      'voice, no longer, and it should still say what it used to say happened, in the past.',
      '',
      'Reply with only a JSON object:',
      '{"n": <the number, or 0 if nothing is out of date>, "line": "<the rewritten line, or an empty string>"}'
    ].join('\n');
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(vcfg, "You keep one person's beliefs up to date. Answer with JSON only.",
        [{ role: 'user', content: ask }], null, { kind: 'revise', who: o.who });
      const obj = parseJSON(raw);
      const n = obj && Number(obj.n);
      if (!obj || !n || !(n > 0) || n > o.held.length) return null;
      const line = String(obj.line || '').trim();
      if (line.length < 4) return null;
      return { n: n, line: line };
    } catch (e) {
      return null;
    }
  }

  /* Fills in a translation or romanisation the villager's reply left out. */
  async function gloss(cfg, say, opts) {
    const o = opts || {};
    const want = ['  "translation": "a plain English translation of the line"'];
    if (o.romanLabel)
      want.push('  "roman": "the ' + o.romanLabel + ' of the line' + (o.romanNote ? ', ' + o.romanNote : '') + '"');
    const ask = [
      'Here is one line of ' + (o.langName || 'text') + ':',
      '',
      JSON.stringify(say),
      '',
      'Reply with only a JSON object:',
      '{',
      want.join(',\n'),
      '}'
    ].join('\n');
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(vcfg, 'You translate and romanise single lines. Answer with JSON only.',
        [{ role: 'user', content: ask }], null, { kind: 'gloss', who: o.who });
      const o2 = parseJSON(raw);
      return o2 || null;
    } catch (e) {
      return null;
    }
  }

  /* What each of two villagers took away from a conversation, decided after
     it happened. `said` matters because a chain fact only spreads if it was
     actually spoken. */
  async function recall(cfg, opts) {
    const o = opts || {};
    const side = (who, other) =>
      [
        who.name + ' knows these things. Which of them did ' + who.name + ' actually say out loud?',
        who.facts.length
          ? who.facts.map(f => '  [' + f.id + '] ' + f.text).join('\n')
          : '  (they know nothing in particular, so this list is empty)'
      ].join('\n');
    const lines = [
      'Two villagers have just been talking. Here is what was said:',
      '',
      o.transcript.map(t => t.who + ': ' + t.say).join('\n'),
      '',
      side(o.a, o.b),
      '',
      side(o.b, o.a),
      '',
      'The [f0]-style labels above are just ids for those statements; use them as they are.',
      '',
      'For each of them, write down what they would come away remembering.',
      'Anything from the conversation worth keeping — what the other one told them,',
      'what they are like, what is going on with them. Not everything said is worth',
      'remembering; leave out small talk that told them nothing.',
      'Write each memory as a short plain-English sentence from that villager’s side,',
      'naming who it is about: "Ilya has a dog called Musya", "Mira’s back is bad again".',
      '',
      'Reply with only a JSON object:',
      '{',
      '  "' + o.a.name + '": {"remembers": ["..."], "said": ["ids ' + o.a.name + ' actually said, [] if none"]},',
      '  "' + o.b.name + '": {"remembers": ["..."], "said": ["ids ' + o.b.name + ' actually said, [] if none"]}',
      '}'
    ].join('\n');
    const vcfg = helperConfig(cfg);
    const sys = 'You note what people took away from a conversation. Answer with JSON only.';
    try {
      const raw = await providerCall(vcfg, sys, [{ role: 'user', content: lines }], null,
        { kind: 'recall', who: o.a.name + ' & ' + o.b.name });
      const obj = parseJSON(raw);
      if (!obj) return null;
      const pick = n => {
        const v = obj[n] || {};
        return {
          remembers: Array.isArray(v.remembers) ? v.remembers.filter(x => typeof x === 'string') : [],
          said: Array.isArray(v.said) ? v.said.map(String) : []
        };
      };
      return { a: pick(o.a.name), b: pick(o.b.name) };
    } catch (e) {
      return null;
    }
  }

  /* Shared plumbing for every Jev call: sends `{state, questions}`, records
     it like any other call (with no system prompt, since Jev takes none),
     and returns `data.answers` (null on failure). `tag` is {kind, who}. */
  async function askJev(cfg, tag, state, questions) {
    const body = { model: JEV_MODEL, state, questions };
    const lcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: JEV_MODEL };
    const msg = [
      { role: 'user', content: 'state:\n' + state + '\n\nquestions:\n' + JSON.stringify(questions, null, 2) }
    ];
    try {
      const raw = await audited(lcfg, null, msg, async () => {
        const data = await decisionPost(lcfg, body);
        const u = data.usage;
        return {
          text: JSON.stringify(data),
          reasoning: null,
          // Jev says input_tokens/output_tokens; aliased so the console line shows a count.
          usage: u
            ? Object.assign({}, u, { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens })
            : null,
          stop: null,
          schema: true,
          model: data.model || JEV_MODEL
        };
      }, tag);
      const data = JSON.parse(raw);
      return data.answers || null;
    } catch (e) {
      return null;
    }
  }

  /* Where a villager goes, as a Jev choice over the place list. Same state
     as intent() below; Jev gives no reason, so it returns only `{go}`. */
  async function decideByJev(cfg, o) {
    const state = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are ' + o.here + '.',
      '',
      o.held && o.held.length
        ? 'What you know, and how you came by it:\n' + o.held.map(k => '- ' + k).join('\n')
        : null,
      '',
      o.folk && o.folk.length
        ? 'Who you have seen about the village:\n' + o.folk.map(f => '- ' + f.name + ', ' + f.where).join('\n')
        : null
    ].filter(x => x !== null && x !== undefined).join('\n');

    const criteria = {};
    (o.places || []).forEach(p => {
      criteria[p.name] = p.note || '';
    });

    const questions = {
      go: {
        type: 'choice',
        instructions: 'Decide where ' + o.me.name + ' should be for the next while.',
        criteria
      }
    };
    const answers = await askJev(cfg, { kind: 'intent', who: o.me.name }, state, questions);
    const ans = answers && answers.go;
    const choice = ans && typeof ans.choice === 'string' ? ans.choice : null;
    return choice ? { go: choice } : null;
  }

  /* Whether a line completed a trade, as a Jev yes/no. */
  async function confirmTradeByJev(cfg, said, translation, deal) {
    const state = [
      deal.npcName + ' said: ' + JSON.stringify(said),
      translation ? 'In English, that is: ' + JSON.stringify(translation) : null,
      '',
      'The traveller is holding out ' + deal.wants + '.'
    ].filter(x => x !== null).join('\n');
    const questions = {
      deal: {
        type: 'choice',
        instructions: 'Did ' + deal.npcName + ' accept it and hand over ' + deal.gives + ', in that line?',
        criteria: {
          yes: 'completing the exchange now',
          no: 'interested, asking about it, agreeing to trade later, or declining -- not completing it now'
        }
      }
    };
    const answers = await askJev(cfg, { kind: 'trade', who: deal.npcName }, state, questions);
    return !!(answers && answers.deal && answers.deal.choice === 'yes');
  }

  /* Which candidate facts a line stated outright: one Jev question per fact,
     in one call. Jev writes no notes, so confirmed facts come back without
     one and verifyRevealed uses the line as spoken. */
  async function judgeByJev(cfg, said, translation, candidates, who) {
    const state = [
      'The speaker said: ' + JSON.stringify(said),
      translation ? 'In English, that is: ' + JSON.stringify(translation) : null
    ].filter(x => x !== null).join('\n');
    const questions = {};
    candidates.forEach(c => {
      questions[c.id] = {
        type: 'choice',
        instructions: 'Did that line state outright, plainly enough to act on, that: ' + c.text,
        criteria: {
          yes: 'asserted, not merely mentioned, hinted at, or asked about',
          no: 'not stated outright'
        }
      };
    });
    const answers = await askJev(cfg, { kind: 'notebook', who: who }, state, questions);
    if (!answers) return [];
    return candidates
      .filter(c => answers[c.id] && answers[c.id].choice === 'yes')
      .map(c => ({ id: c.id, note: null, ruby: null }));
  }

  /* Where a villager goes next, and why, from their goal and what they know.
     Asked only when something has changed (see routine() in npc.js). */
  async function intent(cfg, opts) {
    const o = opts || {};
    if (cfg.provider === 'openrouter' && cfg.apiKey) {
      return decideByJev(cfg, o);
    }
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are ' + o.here + '.',
      '',
      o.held && o.held.length
        ? 'What you know, and how you came by it:\n' + o.held.map(k => '- ' + k).join('\n')
        : null,
      '',
      // Where others are, so "Sanna has the cards" can be acted on.
      o.folk && o.folk.length
        ? 'Who you have seen about the village:\n' + o.folk.map(f => '- ' + f.name + ', ' + f.where).join('\n')
        : null,
      '',
      // The exact strings as a JSON array: a bulleted list got answered loosely and matched nothing.
      'Places you could go. "go" must be one of these strings exactly:',
      JSON.stringify(o.places.map(p => p.name)),
      o.places.some(p => p.note)
        ? o.places.filter(p => p.note).map(p => '  ' + p.name + ' \u2014 ' + p.note).join('\n')
        : null,
      '',
      'Decide where to be for the next while, and why.',
      '',
      'Reply with only a JSON object:',
      '{"go": "exactly one of the strings listed above", "why": "a few words, in English"}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = helperConfig(cfg);
    const sys = 'You decide what a villager does next. Answer with JSON only.';
    try {
      const raw = await providerCall(vcfg, sys, [{ role: 'user', content: lines }], null, { kind: 'intent', who: o.me.name });
      const obj = parseJSON(raw);
      if (!obj || !obj.go) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* Whether a villager at the noticeboard has anything to pin up, and what.
     Nothing is pre-selected, and "nothing" is a fine answer. */
  async function notice(cfg, opts) {
    const o = opts || {};
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are at the village noticeboard, where anyone may pin up a note for the whole village to read.',
      '',
      o.held && o.held.length
        ? 'What you know, and how you came by it:\n' + o.held.map(k => '- ' + k).join('\n')
        : null,
      '',
      o.board && o.board.length
        ? 'Already pinned up there:\n' + o.board.map(t => '- ' + t).join('\n')
        : 'Nothing is pinned up there right now.',
      '',
      'Decide whether you have anything worth pinning up right now. It does not have to be your own business — a complaint, a warning, an offer, news, anything a person standing here might actually post. Having nothing to say is a perfectly good answer; do not invent something just to have posted.',
      '',
      'If you do post, write it the way it would actually be written up — short, public, in your own words.',
      '',
      ('In ' + o.langName + '. ' + (o.register || '')).trim(),
      '',
      'Reply with only a JSON object:',
      '{"post": true or false,',
      ' "text": "what you pin up, in ' + o.langName + ' — empty string if post is false",',
      ' "translation": "plain English, or empty string if post is false"' +
        (o.romanLabel
          ? ',\n "roman": "' + o.romanLabel + (o.romanNote ? ', ' + o.romanNote : '') +
            ', or empty string if post is false"'
          : '') +
        ',',
      ' "revealed": ["ids from what you know that this notice states outright, [] if none or if post is false"]}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = helperConfig(cfg);
    const sys = 'You decide whether a villager posts a notice, and write it if so. Answer with JSON only.';
    try {
      const raw = await providerCall(vcfg, sys, [{ role: 'user', content: lines }], null, { kind: 'notice', who: o.me.name });
      const obj = parseJSON(raw);
      if (!obj) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* One villager's next line in a conversation with another. One call per
     line, each villager writing only their own: one call writing both sides
     read like a script (see DESIGN.md). */
  async function converse(cfg, opts) {
    const o = opts || {};
    const said = (o.transcript || []).map(t => t.who + ': ' + t.say);
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      // Where they actually are and why, from their own decision.
      o.here ? 'You are ' + o.here + '.' : null,
      o.sought
        ? 'You came looking for ' + o.them.name + ', ' + o.them.job +
          (o.them.persona ? '. ' + o.them.persona : '') + '.' +
          (o.errand ? ' What brought you: ' + o.errand + '.' : '')
        : o.errand
          ? 'What brought you here: ' + o.errand + '.'
          : null,
      o.sought
        ? null
        : o.them.name + ', ' + o.them.job + ', is here too.' +
          (o.them.persona ? ' ' + o.them.persona : ''),
      o.when || null,
      '',
      // Neighbours they have known for years, so a third party can come up naturally.
      o.me.roster && o.me.roster.length
        ? 'Everyone else in the village:\n' +
          o.me.roster.map(r => '- ' + r.name + ' — ' + r.job + '. ' + r.persona).join('\n')
        : null,
      '',
      o.held && o.held.length
        ? 'What you know, and how you came by it — say any of it if it comes up:\n' +
          o.held.map(k => '- ' + k).join('\n')
        : null,
      '',
      // No goods or purse here: nothing carries out a trade between two villagers.
      said.length ? 'So far:\n' + said.join('\n') : 'Neither of you has said anything yet.',
      '',
      o.closing ? 'This is the last thing you will say in this conversation.' : null,
      'Say your next line. A line or two.',
      '',
      ('In ' + o.langName + '. ' + (o.register || '')).trim(),
      // Grammatical, and deliberately nothing about length (see DESIGN.md, "Prompt wording").
      'Say it the way a real ' + o.langName + ' speaker would actually say it out loud.',
      /* Gestures written in the village language, so the overheard log
         stays free of English. Measured only for toki pona, so gated by
         `stageInLang` in data.js. */
      o.stageInLang
        ? 'Whatever you are doing while you speak — a glance, a shrug, flour wiped off your hands — belongs in ' +
          o.langName + ' like everything else you say.'
        : null,
      o.grammarNote ? 'In ' + o.langName + ', ' + o.grammarNote : null,
      o.furigana ? 'Put the furigana in "say".\n' + LG.FURIGANA : null,
      o.diacritics ? 'Write "say" fully vocalised, tashkeel and all.\n' + LG.TASHKEEL : null,
      '',
      'Reply with only a JSON object:',
      '{"say": "your line", "translation": "plain English"' +
        (o.romanLabel ? ', "roman": "' + o.romanLabel + (o.romanNote ? ', ' + o.romanNote : '') + '"' : '') +
        '}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = helperConfig(cfg);
    const sys = 'You play one villager in a two-person conversation. Answer with JSON only.';
    try {
      const raw = await providerCall(vcfg, sys, [{ role: 'user', content: lines }], null, { kind: 'chatter', who: o.me.name });
      const obj = parseJSON(raw);
      if (!obj || !obj.say) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /* Adds furigana to a Japanese line the villager left unannotated. Null on
     anything unexpected. */
  async function furigana(cfg, say, attempt, who) {
    const ask = [
      'Add furigana to this Japanese sentence.',
      '',
      'Sentence: ' + JSON.stringify(say),
      '',
      'Return the sentence exactly as it is, with the readings added.',
      LG.FURIGANA,
      'Even a single kanji gets one.',
      'Change nothing else: same words, same kana, same punctuation, same order.',
      '',
      'Reply with only the rewritten sentence, no quotes and no explanation.'
    ].concat(attempt
      ? [
        '',
        'A previous attempt came back different from the sentence above. Copy the sentence',
        'character for character and add ruby tags around the kanji — do not reword it, do not',
        'add or remove punctuation, and do not wrap it in quotes.'
      ]
      : []).join('\n');
    const vcfg = helperConfig(cfg);
    try {
      const raw = await providerCall(vcfg, 'You add furigana to Japanese text. Output the sentence only.',
        [{ role: 'user', content: ask }], null, { kind: 'furigana', who: who });
      return String(raw).trim();
    } catch (e) {
      return null;
    }
  }

  const FIELDS = 'say|translation|roman|ruby|understood|remember|action|revealed';

  /* Structural fixes for common JSON breakage (curly or missing quotes,
     trailing commas). None of them invent or change content. */
  function repairJSON(t) {
    return (
      t
        // Curly quotes first, or the missing-quote rule strands them inside the value.
        .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)[\u201c\u201d]', 'g'), '$1"')
        .replace(/[\u201c\u201d](\s*[,}])/g, '"$1')
        // A value's opening quote missing entirely ("say":值...").
        .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)(?=[^"\\[{\\s\\dtfn-])', 'g'), '$1"')
        .replace(/,(\s*[}\]])/g, '$1')
    );
  }

  /* Last resort: pulls fields out by regex when the reply isn't JSON at
     all, so the player never sees a raw brace. */
  function salvage(text) {
    const out = {};
    ['say', 'translation', 'roman', 'ruby', 'understood', 'action'].forEach(k => {
      const re = new RegExp('"' + k + '"\\s*:\\s*"?([\\s\\S]*?)"?\\s*(?=,\\s*"(?:' + FIELDS + ')"\\s*:|\\}|$)');
      const m = text.match(re);
      if (m && m[1]) out[k] = m[1].replace(/^"|"$/g, '').trim();
    });
    return out.say ? out : null;
  }

  /* The first balanced {...}, ignoring braces inside strings. Run after
     repairJSON: a missing quote would throw off the string tracking. */
  function extractObject(t) {
    const start = t.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
    return null;
  }

  /* The reply object, through code fences, surrounding prose and the small
     malformations models produce. */
  function parseJSON(text) {
    if (!text) return null;
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();

    const repaired = repairJSON(t);
    for (const cand of [t, repaired]) {
      const chunk = extractObject(cand);
      if (!chunk) continue;
      try { return JSON.parse(chunk); } catch (e) {}
      try { return JSON.parse(repairJSON(chunk)); } catch (e) {}
    }
    return salvage(repaired) || salvage(t);
  }

  /* The character's parsed reply. `opts` may carry `who`, `cachePrefixes`
     (leading parts of `system` that stay the same turn to turn, see
     systemParts) and `session` (OpenRouter's sticky routing). */
  async function speak(cfg, system, messages, schema, opts) {
    const raw = await providerCall(cfg, system, messages, schema, Object.assign({ kind: 'villager' }, opts));
    const obj = parseJSON(raw);
    if (!obj || !obj.say) {
      // The caller reports a failed turn; raw JSON never reaches the player.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dialogue] could not read this reply:\n' + String(raw).slice(0, 600));
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
    salvage
  };
})();
