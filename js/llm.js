/* llm.js — provider abstraction: OpenRouter and Anthropic (direct from the browser). */
window.LG = window.LG || {};

LG.llm = (function () {
  const MODELS = {
    anthropic: [
      { id: 'claude-opus-5',    label: 'Claude Opus 5 (best)' },
      { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5 (faster)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest/cheapest)' }
    ],
    openrouter: [
      { id: 'google/gemini-3.7-flash',    label: 'Gemini 3.7 Flash' },
      { id: 'anthropic/claude-sonnet-5',  label: 'Claude Sonnet 5' },
      { id: 'anthropic/claude-opus-5',    label: 'Claude Opus 5' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-4.1-mini',        label: 'GPT-4.1 mini' },
      { id: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
      { id: 'z-ai/glm-5.2',               label: 'GLM-5.2 (Z.ai)' }
    ]
  };

  /* Small/cheap helper model list, used for bookkeeping tasks the
     in-character model handles poorly: notebook fact-checking, furigana
     repair, confirming a trade completed. Any cheap, literal model works. */
  const HELPERS = {
    anthropic: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fast and cheap' },
      { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5 — more careful, pricier' }
    ],
    openrouter: [
      { id: 'google/gemma-4-31b-it',      label: 'Gemma 4 31B' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'xiaomi/mimo-v2.5',           label: 'MiMo-V2.5' },
      { id: 'xiaomi/mimo-v2.5-pro',       label: 'MiMo-V2.5 Pro' },
      { id: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
      { id: 'openai/gpt-4.1-mini',        label: 'GPT-4.1 mini' },
      { id: 'z-ai/glm-5.2',               label: 'GLM-5.2' }
    ]
  };
  const VERIFIER = {
    anthropic: 'claude-haiku-4-5',
    openrouter: 'anthropic/claude-haiku-4.5'
  };

  /* Resolves the helper model: explicit user choice, else provider's
     default VERIFIER, else falls back to the main villager model. */
  function helperModel(cfg) {
    return (cfg && cfg.helper) || VERIFIER[cfg && cfg.provider] || (cfg && cfg.model);
  }

  // Models that accept output_config.effort. Older models (Haiku 4.5, Sonnet 4.5)
  // reject it, so we only send it where it is supported.
  const SUPPORTS_EFFORT = /^claude-(opus-5|sonnet-5|opus-4-8|opus-4-7|fable-5)/;

  /* Wraps transport/HTTP failures into player-readable error messages. The
     most common failure is opening the page via file://, which sends
     `Origin: null` and fails the provider's CORS check. */
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
    if (res.status === 429) throw new Error('Rate limited. Wait a moment and try again.');
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 240); } catch (e) {}
      throw new Error('API error ' + res.status + (detail ? ': ' + detail : ''));
    }
    return res.json();
  }

  function anthropicBody(cfg, system, messages, maxTokens, schema) {
    const body = { model: cfg.model, max_tokens: maxTokens, system, messages };
    if (SUPPORTS_EFFORT.test(cfg.model)) {
      // Response speed matters more than reasoning depth for in-character
      // dialogue. Disabling thinking is only permitted at effort "high" or below.
      body.thinking = { type: 'disabled' };
      body.output_config = { effort: 'low' };
    }
    // effort and format share the one object, so merge rather than assign
    if (schema) {
      body.output_config = Object.assign({}, body.output_config,
        { format: { type: 'json_schema', schema: schema } });
    }
    return body;
  }

  function anthropicHeaders(cfg) {
    return {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // Required opt-in for calling the API straight from a browser page.
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }

  /* OpenRouter attributes calls to an "app" keyed by this URL (viewable
     at openrouter.ai/apps?url=<this>). Previously this was derived from
     `location.origin`, which is the literal string "null" when opened via
     file://, so calls showed up as unattributed. Hardcoded instead, so
     every call is attributed to the same app regardless of what port or
     protocol the page is served from.

     Changing APP_URL later creates a new, separate app with its own
     history; APP_TITLE can be edited freely without that effect. */
  const APP_URL = 'https://github.com/TetraspaceW/little-village';
  const APP_TITLE = 'Little Village (Beta)';

  function openrouterHeaders(cfg) {
    return {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + cfg.apiKey,
      'HTTP-Referer': APP_URL,
      'X-Title': APP_TITLE
    };
  }

  /* ------------------------------------------------------- can it take a schema

     Previously every call just asked for JSON in the prompt and hoped;
     logging showed roughly a third of player-facing replies came back
     missing fields (English translation, romanization). Both providers
     support telling the model the exact expected shape — Anthropic via
     `output_config.format`, OpenRouter via OpenAI-style `response_format`
     (which it translates to whatever its backend actually speaks) — so
     this only needs two branches, not one per model.

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
  const SCHEMA_OK = {};                  // 'provider:model' -> true | false, cached after first check
  let orModels = null;                   // OpenRouter's model list, fetched once and shared by both model checks

  async function getJSON(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function schemaKey(cfg, model) { return cfg.provider + ':' + model; }

  /* Synchronous check so the send path never blocks on it. Unresolved/unknown reads as false. */
  function schemaOK(cfg, model) {
    return SCHEMA_OK[schemaKey(cfg, model || cfg.model)] === true;
  }

  async function probeOne(cfg, model) {
    const key = schemaKey(cfg, model);
    if (key in SCHEMA_OK) return SCHEMA_OK[key];
    SCHEMA_OK[key] = false;                            // stands unless we learn otherwise
    try {
      if (cfg.provider === 'anthropic') {
        const m = await getJSON('https://api.anthropic.com/v1/models/' +
                                encodeURIComponent(model), anthropicHeaders(cfg));
        const c = m && m.capabilities && m.capabilities.structured_outputs;
        SCHEMA_OK[key] = !!(c && c.supported);
      } else {
        if (!orModels) orModels = getJSON('https://openrouter.ai/api/v1/models');
        const d = await orModels;
        const m = (d.data || []).find(x => x.id === model);
        SCHEMA_OK[key] = !!m && (m.supported_parameters || []).indexOf('structured_outputs') !== -1;
      }
    } catch (e) {
      orModels = null;                                 // don't cache a failed fetch — allow retrying later
    }
    return SCHEMA_OK[key];
  }

  /* Probes both the main and helper model once, up front. Never throws —
     an unresolved probe is a valid, handled state (see schemaOK). */
  async function probe(cfg) {
    if (!cfg || !cfg.provider) return;
    try { await Promise.all([probeOne(cfg, cfg.model), probeOne(cfg, helperModel(cfg))]); }
    catch (e) { /* fails closed on its own */ }
  }

  /* ---------------------------------------------------------------- audit

     Every API call goes through anthropicCall/openrouterCall below, which
     is why this is centralized here rather than at each call site. Each
     call is recorded in full — system prompt, messages, the *raw* reply
     before any parsing/repair, timing, and usage — and printed as a
     collapsed console group.

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
    ['You decide what a villager does next', 'intent'],
    ['You play one villager', 'chatter'],
    ['You verify claims', 'notebook'],
    ['You add furigana', 'furigana'],
    ['You translate and romanise', 'gloss'],
    ['You answer yes or no', 'trade']
  ];
  const transcript = [];
  let audit = true, seq = 0;
  const KEEP = 200;

  function kindOf(system) {
    const t = String(system || '');
    for (const [head, name] of KINDS) if (t.indexOf(head) === 0) return name;
    if (t.indexOf('# Your character') !== -1) return 'villager';
    return 'call';
  }

  /* Extracts the villager's name from the prompt when present, so log
     entries can be labeled by who they're about instead of all showing
     as generic "villager" calls. */
  function subjectOf(system, messages) {
    const t = String(system || '') + '\n' + (messages || []).map(m => m.content).join('\n');
    const named = /^Name:\s*([^—\n.]+)/m.exec(t) || /^You are ([A-Z][\w'-]*)/m.exec(t);
    return named ? named[1].trim() : '';
  }

  function record(cfg, system, messages, out, err, ms, res) {
    const entry = {
      n: ++seq,
      kind: kindOf(system),
      who: subjectOf(system, messages),
      model: cfg.model,
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
      // emit the JSON — that comes back as a 200 with an empty body, so flag it explicitly.
      truncated: !!(res && (res.stop === 'max_tokens' || res.stop === 'length')),
      error: err ? (err.message || String(err)) : null,
      at: new Date().toISOString()
    };
    transcript.push(entry);
    if (transcript.length > KEEP) transcript.shift();
    if (LG.logbook) LG.logbook.call(entry);          // also persist to disk, if logging is active
    if (audit && typeof console !== 'undefined' && console.log) {
      const u = entry.usage || {};
      const tok = (u.input_tokens || u.prompt_tokens) ?
        '  ' + (u.input_tokens || u.prompt_tokens) + '\u2192' +
        (u.output_tokens || u.completion_tokens || 0) + ' tok' : '';
      const head = '%c ' + entry.kind + ' %c' + (entry.who ? ' ' + entry.who : '') +
                   '  ' + entry.model + '  ' + entry.ms + 'ms' + tok +
                   (entry.truncated ? '  CUT OFF (max_tokens)' : '') +
                   (err ? '  FAILED' : '');
      const tag = 'background:' + (err ? '#a33' : '#356') +
                  ';color:#fff;border-radius:3px;font-weight:600';
      const group = console.groupCollapsed || console.log;
      group.call(console, head, tag, 'color:#888');
      console.log('system:\n' + system);
      (messages || []).forEach(m => console.log(m.role + ':\n' + m.content));
      if (entry.reasoning) console.log('reasoning:\n' + entry.reasoning);
      if (err) console.log('error: ' + entry.error);
      else {
        console.log('raw reply:\n' + out);
        if (entry.truncated) console.log('*** cut off at max_tokens — the reply is incomplete ***');
        if (entry.usage) console.log('usage: ' + JSON.stringify(entry.usage) +
                                     (entry.stop ? '  stop: ' + entry.stop : ''));
      }
      if (console.groupEnd) console.groupEnd();
    }
    return entry;
  }

  /* Wraps a provider call so a log entry is recorded whether it succeeds or throws. */
  async function audited(cfg, system, messages, run) {
    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const since = () => ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()) - t0;
    try {
      const res = await run();
      record(cfg, system, messages, res.text, null, since(), res);
      return res.text;
    } catch (e) {
      record(cfg, system, messages, undefined, e, since());
      throw e;
    }
  }

  /* Callers pass the schema they want without needing to know whether the
     target model actually supports structured outputs — that check
     (schemaOK) happens centrally here. */
  async function anthropicCall(cfg, system, messages, schema) {
    const s = (schema && schemaOK(cfg, cfg.model)) ? schema : null;
    return audited(cfg, system, messages, () => anthropicSend(cfg, system, messages, s));
  }

  async function openrouterCall(cfg, system, messages, schema) {
    const s = (schema && schemaOK(cfg, cfg.model)) ? schema : null;
    return audited(cfg, system, messages, () => openrouterSend(cfg, system, messages, s));
  }

  function dump() {
    return transcript.map(e =>
      '=== #' + e.n + '  ' + e.kind + (e.who ? '  ' + e.who : '') + '  ' + e.model +
      '  ' + e.ms + 'ms  ' + e.at +
      (e.usage ? '  ' + JSON.stringify(e.usage) : '') +
      '\n--- system\n' + e.system +
      (e.messages || []).map(m => '\n--- ' + m.role + '\n' + m.content).join('') +
      (e.reasoning ? '\n--- reasoning\n' + e.reasoning : '') +
      (e.truncated ? '\n--- CUT OFF at max_tokens' : '') +
      (e.error ? '\n--- error\n' + e.error : '\n--- raw\n' + e.raw)
    ).join('\n\n');
  }

  async function anthropicSend(cfg, system, messages, schema) {
    const data = await post('https://api.anthropic.com/v1/messages',
      anthropicHeaders(cfg), anthropicBody(cfg, system, messages, 700, schema));
    if (data.stop_reason === 'refusal') throw new Error('The model declined to answer that.');
    const blocks = data.content || [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
             // the model's reasoning trace, when present
             reasoning: blocks.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking')
                              .map(b => b.thinking || '[redacted]').join('\n') || null,
             usage: data.usage || null, stop: data.stop_reason || null,
             schema: !!schema };
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

  async function openrouterSend(cfg, system, messages, schema) {
    const body = { model: cfg.model,
                   messages: [{ role: 'system', content: system }].concat(messages) };
    if (cfg.fast) body.reasoning = { max_tokens: FAST_REASONING_TOKENS };
    if (schema) {
      body.response_format = { type: 'json_schema',
                               json_schema: { name: 'reply', strict: true, schema: schema } };
    }
    const data = await post('https://openrouter.ai/api/v1/chat/completions',
      openrouterHeaders(cfg), body);
    if (data.error) throw new Error(data.error.message || 'OpenRouter error');
    const choice = (data.choices || [])[0] || {};
    const m = choice.message || {};
    /* Reasoning models return their trace in a separate field, previously
       discarded here (it's useful for debugging odd model decisions).
       Different OpenRouter backends name the field differently, so check
       both. */
    const think = m.reasoning ||
      (Array.isArray(m.reasoning_details)
        ? m.reasoning_details.map(d => d.text || d.summary || '').filter(Boolean).join('\n')
        : null);
    return { text: m.content || '', reasoning: think || null,
             usage: data.usage || null, stop: choice.finish_reason || null,
             schema: !!schema };
  }

  /* Minimal test request, so a bad key or blocked origin is caught up
     front rather than mid-conversation. */
  async function validate(cfg) {
    if (!cfg.apiKey) throw new Error('Please paste an API key.');
    const msgs = [{ role: 'user', content: 'Say OK.' }];
    if (cfg.provider === 'anthropic') {
      await post('https://api.anthropic.com/v1/messages',
        anthropicHeaders(cfg), anthropicBody(cfg, 'Reply with one word.', msgs, 8));
    } else {
      const data = await post('https://openrouter.ai/api/v1/chat/completions',
        openrouterHeaders(cfg),
        { model: cfg.model, max_tokens: 8, messages: [{ role: 'system', content: 'Reply with one word.' }].concat(msgs) });
      if (data.error) throw new Error(data.error.message || 'OpenRouter error');
    }
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

    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    let raw;
    try {
      raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You verify claims against a transcript. Answer with JSON only.',
            [{ role: 'user', content: lines.join('\n') }])
        : await openrouterCall(vcfg, 'You verify claims against a transcript. Answer with JSON only.',
            [{ role: 'user', content: lines.join('\n') }]);
    } catch (e) {
      return [];                                   // never guess on failure
    }
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const valid = {};
    candidates.forEach(c => valid[c.id] = true);
    const out = [];
    arr.forEach(x => {
      // accept either a bare tag string or the {tag, note, ruby} object form
      const id = String(typeof x === 'string' ? x : (x && x.tag) || '').replace(/[^\w]/g, '');
      if (!valid[id] || out.some(o => o.id === id)) return;
      out.push({ id,
                 note: (x && typeof x.note === 'string' && x.note.trim()) || null,
                 ruby: (x && typeof x.ruby === 'string' && x.ruby.trim()) || null });
    });
    return out;
  }

  /* Checks whether a line of dialogue actually completed a trade. Only
     called when the player physically offered the correct item but the
     in-character reply didn't flag a completed trade — this second check
     catches cases the villager missed, without letting a wordless
     player action complete a trade on its own. */
  async function confirmTrade(cfg, said, translation, deal) {
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You answer yes or no about what a line of dialogue did.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You answer yes or no about what a line of dialogue did.',
            [{ role: 'user', content: ask }]);
      return /^\W*yes\b/i.test(String(raw).trim());
    } catch (e) { return false; }        // treat a failed check as no deal
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
      o.who + ' already believes these, oldest first:',
      o.held.map((h, i) => (i + 1) + '. ' + h).join('\n'),
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You keep one person\'s beliefs up to date. Answer with JSON only.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You keep one person\'s beliefs up to date. Answer with JSON only.',
            [{ role: 'user', content: ask }]);
      const obj = parseJSON(raw);
      const n = obj && Number(obj.n);
      if (!obj || !n || !(n > 0) || n > o.held.length) return null;
      const line = String(obj.line || '').trim();
      if (line.length < 4) return null;
      return { n: n, line: line };
    } catch (e) { return null; }
  }

  /* Fills in a missing translation or romanization when the in-character
     model's reply omitted one, rather than showing the player a bare
     sentence with no gloss. */
  async function gloss(cfg, say, opts) {
    const o = opts || {};
    const want = ['  "translation": "a plain English translation of the line"'];
    if (o.romanLabel) want.push('  "roman": "the ' + o.romanLabel + ' of the line' +
      (o.romanNote ? ', ' + o.romanNote : '') + '"');
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You translate and romanise single lines. Answer with JSON only.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You translate and romanise single lines. Answer with JSON only.',
            [{ role: 'user', content: ask }]);
      const o2 = parseJSON(raw);
      return o2 || null;
    } catch (e) { return null; }
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
    const side = (who, other) => [
      who.name + ' knows these things. Which of them did ' + who.name + ' actually say out loud?',
      who.facts.length ? who.facts.map(f => '  [' + f.id + '] ' + f.text).join('\n')
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    const sys = 'You note what people took away from a conversation. Answer with JSON only.';
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, sys, [{ role: 'user', content: lines }])
        : await openrouterCall(vcfg, sys, [{ role: 'user', content: lines }]);
      const obj = parseJSON(raw);
      if (!obj) return null;
      const pick = n => {
        const v = obj[n] || {};
        return { remembers: Array.isArray(v.remembers) ? v.remembers.filter(x => typeof x === 'string') : [],
                 said: Array.isArray(v.said) ? v.said.map(String) : [] };
      };
      return { a: pick(o.a.name), b: pick(o.b.name) };
    } catch (e) { return null; }
  }

  /* Decides where a villager goes next and why.

     Previously this was purely a probability table (e.g. 60% chance of
     going to work in the morning), independent of what the villager
     actually knew or wanted — a villager looking for a saw would never
     actually go looking for one, and one just told the bakery has bread
     wouldn't walk there. Since villagers already have a goal, memory, and
     a helper model available, this uses that instead of a dice roll.
     PHASE_TABLE in npc.js remains the fallback for no key / failed calls.

     Only called when something relevant has changed (arrival, hour
     change, weather change, new fact learned) — an already-settled
     villager isn't re-asked. */
  async function intent(cfg, opts) {
    const o = opts || {};
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are ' + o.here + '.',
      '',
      // dated, attributed list of facts — same content the player-facing prompt shows
      o.held && o.held.length
        ? 'What you know, and how you came by it:\n' + o.held.map(k => '- ' + k).join('\n') : null,
      '',
      /* Locations of nearby villagers, so a fact like "Sanna has the
         cards" can actually be acted on — otherwise a villager could know
         exactly who has something with no way to express going to them. */
      o.folk && o.folk.length ? 'Who you have seen about the village:\n' +
        o.folk.map(f => '- ' + f.name + ', ' + f.where).join('\n') : null,
      '',
      /* Places are given as a literal JSON array of accepted strings,
         not a bulleted list — a bulleted list gets answered in loose
         prose (e.g. "village green" for "the village green"), which then
         fails to match any option and silently leaves the villager
         stuck. */
      'Places you could go. "go" must be one of these strings exactly:',
      JSON.stringify(o.places.map(p => p.name)),
      o.places.some(p => p.note)
        ? o.places.filter(p => p.note).map(p => '  ' + p.name + ' \u2014 ' + p.note).join('\n')
        : null,
      '',
      /* Bug history: an earlier version of this prompt ended "even if the
         reason is only that it is your own bed and it is late," meant as
         permission to give a mundane answer. A model instead treated it
         as a literal precondition — one villager's reasoning concluded
         the "bed" clause didn't apply because it wasn't actually late. */
      'Decide where to be for the next while, and why.',
      '',
      'Reply with only a JSON object:',
      '{"go": "exactly one of the strings listed above", "why": "a few words, in English"}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    const sys = 'You decide what a villager does next. Answer with JSON only.';
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, sys, [{ role: 'user', content: lines }])
        : await openrouterCall(vcfg, sys, [{ role: 'user', content: lines }]);
      const obj = parseJSON(raw);
      if (!obj || !obj.go) return null;
      return obj;
    } catch (e) { return null; }
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
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are at the village noticeboard, where anyone may pin up a note for the whole village to read.',
      '',
      o.held && o.held.length
        ? 'What you know, and how you came by it:\n' + o.held.map(k => '- ' + k).join('\n') : null,
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
        (o.romanLabel ? ',\n "roman": "' + o.romanLabel +
          (o.romanNote ? ', ' + o.romanNote : '') + ', or empty string if post is false"' : '') + ',',
      ' "revealed": ["ids from what you know that this notice states outright, [] if none or if post is false"]}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    const sys = 'You decide whether a villager posts a notice, and write it if so. Answer with JSON only.';
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, sys, [{ role: 'user', content: lines }])
        : await openrouterCall(vcfg, sys, [{ role: 'user', content: lines }]);
      const obj = parseJSON(raw);
      if (!obj) return null;
      return obj;
    } catch (e) { return null; }
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
    const said = (o.transcript || []).map(t => t.who + ': ' + t.say);
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      /* Bug history: this used to unconditionally say "you have run into
         X" and that both parties were on their way elsewhere — even for
         two villagers who had each deliberately walked somewhere and
         arrived. Every conversation read as an interruption, and
         villagers kept telling each other to go home. Now states where
         they actually are and why, based on their real decision. */
      o.here ? 'You are ' + o.here + '.' : null,
      o.sought
        ? 'You came looking for ' + o.them.name + ', ' + o.them.job + '.' +
          (o.errand ? ' What brought you: ' + o.errand + '.' : '')
        : (o.errand ? 'What brought you here: ' + o.errand + '.' : null),
      o.sought ? null : o.them.name + ', ' + o.them.job + ', is here too.',
      o.when || null,
      '',
      /* Roster of everyone else in the village by name/job — same
         background info a villager gets when talking to the player. Lets
         a third party get mentioned naturally ("Tomas has one of those")
         instead of the name seeming to come from nowhere. */
      o.me.roster && o.me.roster.length
        ? 'Everyone else in the village, by name and trade:\n' +
          o.me.roster.map(r => '- ' + r.name + ' — ' + r.job).join('\n') : null,
      '',
      // same dated fact list the other prompts (intent, notice) get
      o.held && o.held.length
        ? 'What you know, and how you came by it — say any of it if it comes up:\n' +
          o.held.map(k => '- ' + k).join('\n') : null,
      '',
      /* Removed: this prompt used to include a purse, stock, and wants
         list so two villagers could trade with each other. Nothing
         downstream actually executes villager-to-villager trades — the
         game has no code path for one villager handing an item to
         another — so describing tradeable goods just led to villagers
         "agreeing" to deals that never actually happened. This will come
         back if/when that mechanic is implemented. */
      said.length ? 'So far:\n' + said.join('\n')
                  : 'Neither of you has said anything yet.',
      '',
      o.closing ? 'This is the last thing you will say in this conversation.' : null,
      'Say your next line. A line or two.',
      '',
      ('In ' + o.langName + '. ' + (o.register || '')).trim(),
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
      'Say it the way a real ' + o.langName + ' speaker would actually say it out loud.',
      o.furigana ? 'Put the furigana in "say".\n' + LG.FURIGANA : null,
      o.diacritics ? 'Write "say" fully vocalised, tashkeel and all.\n' + LG.TASHKEEL : null,
      '',
      'Reply with only a JSON object:',
      '{"say": "your line", "translation": "plain English"' +
        (o.romanLabel ? ', "roman": "' + o.romanLabel +
          (o.romanNote ? ', ' + o.romanNote : '') + '"' : '') + '}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    const sys = 'You play one villager in a two-person conversation. Answer with JSON only.';
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, sys, [{ role: 'user', content: lines }])
        : await openrouterCall(vcfg, sys, [{ role: 'user', content: lines }]);
      const obj = parseJSON(raw);
      if (!obj || !obj.say) return null;
      return obj;
    } catch (e) { return null; }
  }

  /* Adds furigana to a Japanese line when the in-character model's reply
     omitted the ruby field or left it unmarked. Returns null on anything
     unexpected. */
  async function furigana(cfg, say, attempt) {
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
    ].concat(attempt ? [
      '',
      'A previous attempt came back different from the sentence above. Copy the sentence',
      'character for character and add ruby tags around the kanji — do not reword it, do not',
      'add or remove punctuation, and do not wrap it in quotes.'
    ] : []).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg), fast: true };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You add furigana to Japanese text. Output the sentence only.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You add furigana to Japanese text. Output the sentence only.',
            [{ role: 'user', content: ask }]);
      return String(raw).trim();
    } catch (e) { return null; }
  }

  const FIELDS = 'say|translation|roman|ruby|understood|remember|action|revealed';

  /* Fixes common small JSON malformations from model output (missing/
     curly quotes, trailing commas). Purely structural fixes — none of
     these invent or alter content. */
  function repairJSON(t) {
    return t
      // curly quotes first, or the missing-quote rule below fires on them and
      // leaves the curly one stranded inside the value
      .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)[\u201c\u201d]', 'g'), '$1"')
      .replace(/[\u201c\u201d](\s*[,}])/g, '"$1')
      // "say":值..."   — the opening quote of a string value went missing
      .replace(new RegExp('("(?:' + FIELDS + ')"\\s*:\\s*)(?=[^"\\[{\\s\\dtfn-])', 'g'), '$1"')
      // a trailing comma before the close
      .replace(/,(\s*[}\]])/g, '$1');
  }

  /* Last-resort fallback: extracts fields by regex when the reply isn't
     valid JSON at all. Used to avoid ever showing the player a raw brace
     or malformed JSON. */
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

  /* Extracts the first balanced {...} substring, tracking string state to
     avoid matching braces inside string values. Run after repairJSON, not
     before — an unrepaired missing quote would throw off the in-string
     tracking here. */
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

  /* Pull the reply object out, tolerating ```json fences, prose around it, and
     the small breakages models produce. */
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

  /* Returns the parsed JSON object the character replied with. */
  async function speak(cfg, system, messages, schema) {
    const raw = cfg.provider === 'anthropic'
      ? await anthropicCall(cfg, system, messages, schema)
      : await openrouterCall(cfg, system, messages, schema);
    const obj = parseJSON(raw);
    if (!obj || !obj.say) {
      // Never put a brace in a villager's mouth — let the caller report a failure.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dialogue] could not read this reply:\n' + String(raw).slice(0, 600));
      }
      return null;
    }
    return obj;
  }

  return { MODELS, HELPERS, VERIFIER, helperModel, speak, judge, furigana, gloss, converse, intent, notice, recall,
           get transcript() { return transcript; }, dump,
           get audit() { return audit; }, set audit(v) { audit = !!v; }, confirmTrade,
           validate, probe, schemaOK, revise, parseJSON, repairJSON, salvage };
})();
