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
      { id: 'anthropic/claude-sonnet-5',  label: 'Claude Sonnet 5' },
      { id: 'anthropic/claude-opus-5',    label: 'Claude Opus 5' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-4.1-mini',        label: 'GPT-4.1 mini' },
      { id: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
      { id: 'z-ai/glm-5.2',               label: 'GLM-5.2 (Z.ai)' }
    ]
  };

  /* A second, smaller model does the bookkeeping the in-character one is bad at:
     notebook fact-checking, furigana repair, and confirming a trade was agreed.
     Anything cheap and literal-minded suits it. */
  const HELPERS = {
    anthropic: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fast and cheap' },
      { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5 — more careful, pricier' }
    ],
    openrouter: [
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 — fast and cheap' },
      { id: 'xiaomi/mimo-v2.5',           label: 'MiMo-V2.5' },
      { id: 'xiaomi/mimo-v2.5-pro',       label: 'MiMo-V2.5 Pro' },
      { id: 'google/gemma-4-31b-it',      label: 'Gemma 4 31B — quick off the mark' },
      { id: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
      { id: 'openai/gpt-4.1-mini',        label: 'GPT-4.1 mini' },
      { id: 'z-ai/glm-5.2',               label: 'GLM-5.2' }
    ]
  };
  const VERIFIER = {
    anthropic: 'claude-haiku-4-5',
    openrouter: 'anthropic/claude-haiku-4.5'
  };

  /* An explicit choice wins; otherwise the provider's default; otherwise fall
     back to whatever is playing the villagers. */
  function helperModel(cfg) {
    return (cfg && cfg.helper) || VERIFIER[cfg && cfg.provider] || (cfg && cfg.model);
  }

  // Models that accept output_config.effort. Older models (Haiku 4.5, Sonnet 4.5)
  // reject it, so we only send it where it is supported.
  const SUPPORTS_EFFORT = /^claude-(opus-5|sonnet-5|opus-4-8|opus-4-7|fable-5)/;

  /* Turn transport failures into something a player can act on. The most common
     one by far is opening the page from file://, where the browser sends
     `Origin: null` and the provider's CORS check rejects it. */
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

  function anthropicBody(cfg, system, messages, maxTokens) {
    const body = { model: cfg.model, max_tokens: maxTokens, system, messages };
    if (SUPPORTS_EFFORT.test(cfg.model)) {
      // Snappy dialogue matters more than deep reasoning here. Disabling thinking
      // is allowed at effort "high" or below.
      body.thinking = { type: 'disabled' };
      body.output_config = { effort: 'low' };
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

  function openrouterHeaders(cfg) {
    return {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + cfg.apiKey,
      'HTTP-Referer': location.origin || 'https://localhost',
      'X-Title': 'Little Village Language Game'
    };
  }

  /* ---------------------------------------------------------------- audit

     Every call the game makes goes through the two functions below, so this is
     the one place that sees all of it. Each one is recorded whole — the system
     prompt, the messages, the raw reply before any parsing or repair, how long
     it took and what it cost — and printed as a collapsed console group you can
     open and read.

     Raw matters: most of the failures in this game have been the difference
     between what the model actually returned and what the game made of it, and
     a log of the tidied-up version would have hidden every one of them.

       LG.llm.audit = false     stop printing (still recorded)
       LG.llm.transcript        the records, newest last
       LG.llm.dump()            the lot as plain text, for copying out */
  /* Helper calls are known by the opening of their system prompt. A villager's
     own prompt opens with their name, which is not something to match on, so it
     is known by a section heading only it has — keep these in step with the
     prompts or the log fills up with "call". */
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

  /* Who it is about, when the prompt says so — a log of twenty "villager" calls
     is much less use than one that names them. */
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
      // A reasoning model can spend the whole budget thinking and never get to the
      // JSON. That comes back as an empty-handed success, so it is called out.
      truncated: !!(res && (res.stop === 'max_tokens' || res.stop === 'length')),
      error: err ? (err.message || String(err)) : null,
      at: new Date().toISOString()
    };
    transcript.push(entry);
    if (transcript.length > KEEP) transcript.shift();
    if (LG.logbook) LG.logbook.call(entry);          // and onto the disk, if a log is running
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

  /* Wraps a provider call so the record is written whether it returns or throws. */
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

  async function anthropicCall(cfg, system, messages) {
    return audited(cfg, system, messages, () => anthropicSend(cfg, system, messages));
  }

  async function openrouterCall(cfg, system, messages) {
    return audited(cfg, system, messages, () => openrouterSend(cfg, system, messages));
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

  async function anthropicSend(cfg, system, messages) {
    const data = await post('https://api.anthropic.com/v1/messages',
      anthropicHeaders(cfg), anthropicBody(cfg, system, messages, 700));
    if (data.stop_reason === 'refusal') throw new Error('The model declined to answer that.');
    const blocks = data.content || [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
             // the model's own working, when it shows any — this is the interesting half
             reasoning: blocks.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking')
                              .map(b => b.thinking || '[redacted]').join('\n') || null,
             usage: data.usage || null, stop: data.stop_reason || null };
  }

  async function openrouterSend(cfg, system, messages) {
    const data = await post('https://openrouter.ai/api/v1/chat/completions',
      openrouterHeaders(cfg),
      { model: cfg.model, messages: [{ role: 'system', content: system }].concat(messages) });
    if (data.error) throw new Error(data.error.message || 'OpenRouter error');
    const choice = (data.choices || [])[0] || {};
    const m = choice.message || {};
    /* Reasoning models return their working in a field of its own and it was
       being dropped on the floor — which is a shame, because it is where you can
       see a villager talk themselves into something daft. Providers disagree
       about the name, so take whichever turns up. */
    const think = m.reasoning ||
      (Array.isArray(m.reasoning_details)
        ? m.reasoning_details.map(d => d.text || d.summary || '').filter(Boolean).join('\n')
        : null);
    return { text: m.content || '', reasoning: think || null,
             usage: data.usage || null, stop: choice.finish_reason || null };
  }

  /* A minimal round trip, so a bad key or a blocked origin is caught at the
     door rather than halfway through a conversation. */
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

  /* Did the villager actually SAY these things? The villager's own report is
     unreliable — it will flag a fact because it used the word, or explained it.
     This asks a small model that has no character to play and nothing else to
     track. It fails closed: anything unconfirmed simply does not get written
     down. */
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
    lines.push('');
    lines.push('Leave out anything that was not told. Reply [] if none of them were.');

    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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
      // tolerate a bare tag as well as the object form
      const id = String(typeof x === 'string' ? x : (x && x.tag) || '').replace(/[^\w]/g, '');
      if (!valid[id] || out.some(o => o.id === id)) return;
      out.push({ id,
                 note: (x && typeof x.note === 'string' && x.note.trim()) || null,
                 ruby: (x && typeof x.ruby === 'string' && x.ruby.trim()) || null });
    });
    return out;
  }

  /* Did the villager just close the deal? Asked only when the player physically
     offered the right thing and the villager's own reply did not flag a trade —
     a second reader catches the missed field without letting a wordless gesture
     complete a bargain on its own. */
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You answer yes or no about what a line of dialogue did.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You answer yes or no about what a line of dialogue did.',
            [{ role: 'user', content: ask }]);
      return /^\W*yes\b/i.test(String(raw).trim());
    } catch (e) { return false; }        // no deal on a failed check
  }

  /* A villager sometimes returns a line with no translation or no romanisation.
     Rather than showing a learner a bare sentence, ask the small model for the
     missing parts. */
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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

  /* Two villagers meeting in the street. The small model writes the exchange,
     seeded with the piece of news actually being passed. */
  /* One villager's next line in a conversation with another villager.

     This is deliberately one call per turn rather than one call that writes the
     whole exchange. Two actors improvising at each other produce a conversation;
     one actor writing both halves produces a script, and it shows — the halves
     agree too neatly, nobody misunderstands anybody, and the second speaker never
     says anything the first did not set up. It runs on the small model precisely
     so that this is affordable: a six-turn conversation is six cheap calls. */
  /* What two villagers took away from talking to each other.

     Gossip is not a mechanic here. Nothing is "shared" as a token: Ilya knows he
     has a dog, and if he happens to mention the dog then whoever he was talking
     to now knows about the dog. He might just as easily talk about his back, or
     the weather, or how much he likes chocolate, and that is worth remembering
     too if the other one found it interesting. So this is asked afterwards, of
     the conversation that actually happened, rather than decided in advance.

     `learned` exists only because the errand chain needs to know when one of its
     facts has genuinely travelled — the notebook is built on those ids. It is a
     record of what was said, not a licence: a fact nobody mentioned does not
     move, however convenient that would be. */
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
      'Did anything change hands? Only if it plainly did in the words above —',
      'someone handing something over, someone paying. An agreement to do it later',
      'is not it happening.',
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
      '  "' + o.b.name + '": {"remembers": ["..."], "said": ["ids ' + o.b.name + ' actually said, [] if none"]},',
      '  "exchanged": [{"from": "who handed it over", "to": "who took it", ' +
        '"item": "what, in plain English", "coins": 0}]',
      '}',
      '"exchanged" is [] unless something actually passed between them.'
    ].join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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
      const moved = Array.isArray(obj.exchanged) ? obj.exchanged.filter(x => x && x.item) : [];
      return { a: pick(o.a.name), b: pick(o.b.name), exchanged: moved };
    } catch (e) { return null; }
  }

  /* Where a villager goes next, and why.

     This used to be a probability table — morning meant a 60% chance of work —
     which made everyone a dumb NPC in a game whose whole premise is that they
     are not. A villager who wants a saw more than anything never went looking
     for one; a villager who had just been told the baker has bread did not walk
     to the bakery. They have a goal, a memory and a helper model already; there
     is no reason for the one decision they make all day to be a dice roll.

     Asked only when something has changed — they arrived, the hour turned, the
     weather broke, they learned something — so a settled villager costs nothing. */
  async function intent(cfg, opts) {
    const o = opts || {};
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      o.goal ? 'What you are about: ' + o.goal : null,
      '',
      o.when || null,
      'You are ' + o.here + '.',
      '',
      o.knows && o.knows.length ? 'What you know:\n' + o.knows.map(k => '- ' + k).join('\n') : null,
      '',
      /* Who is where, so that knowing Sanna has the cards is something you can
         act on. Without it a villager can want a thing, know exactly who has it,
         and have no way to express going to find them. */
      o.folk && o.folk.length ? 'Who you have seen about the village:\n' +
        o.folk.map(f => '- ' + f.name + ', ' + f.where).join('\n') : null,
      '',
      /* The options as a JSON array of the exact strings that will be accepted.
         A bulleted list reads as prose and gets answered in prose — "village
         green" for "the village green" — which then matches nothing and the
         villager quietly does not move. */
      'Places you could go. "go" must be one of these strings exactly:',
      JSON.stringify(o.places.map(p => p.name)),
      o.places.some(p => p.note)
        ? o.places.filter(p => p.note).map(p => '  ' + p.name + ' \u2014 ' + p.note).join('\n')
        : null,
      '',
      /* The old version ended "even if the reason is only that it is your own bed
         and it is late", which was meant to license a dull answer and was instead
         picked over as a rule — one villager spent her reasoning establishing that
         it was only the afternoon so the bed clause did not apply. */
      'Decide where to be for the next while, and why.',
      '',
      'Reply with only a JSON object:',
      '{"go": "exactly one of the strings listed above", "why": "a few words, in English"}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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

  async function converse(cfg, opts) {
    const o = opts || {};
    const said = (o.transcript || []).map(t => t.who + ': ' + t.say);
    const lines = [
      'You are ' + o.me.name + ' — ' + o.me.job + '. ' + o.me.persona,
      /* Where they are and why they are there. This used to say "you have run
         into X" and, further down, that they were both on their way somewhere —
         asserted of everyone, always, including two people who had each walked
         somewhere on purpose and arrived. It made every conversation an
         interruption, and the village spent its days telling each other to go
         home. They are where they chose to be, for the reason they chose it. */
      o.here ? 'You are ' + o.here + '.' : null,
      o.sought
        ? 'You came looking for ' + o.them.name + ', ' + o.them.job + '.' +
          (o.errand ? ' What brought you: ' + o.errand + '.' : '')
        : (o.errand ? 'What brought you here: ' + o.errand + '.' : null),
      o.sought ? null : o.them.name + ', ' + o.them.job + ', is here too.',
      o.when || null,
      '',
      o.knows && o.knows.length
        ? 'On your mind, if any of it comes up:\n' + o.knows.map(k => '- ' + k).join('\n') : null,
      o.recent && o.recent.length
        ? 'Lately you have picked up:\n' + o.recent.map(k => '- ' + k).join('\n') : null,
      '',
      /* Villagers had no money and no way to hand anything over, so they agreed
         to deals that never happened and went round in circles about them for a
         whole afternoon. They can deal with each other now, and this is what
         they have to deal with. */
      o.purse !== undefined ? 'In your purse: ' + o.purse + (o.purse === 1 ? ' coin' : ' coins') + '.' : null,
      o.wares && o.wares.length ? 'Yours to sell or hand over: ' + o.wares.join(', ') + '.' : null,
      o.theirs && o.theirs.length ? o.them.name + ' has: ' + o.theirs.join(', ') + '.' : null,
      o.after ? 'You are after: ' + o.after + '.' : null,
      '',
      said.length ? 'So far:\n' + said.join('\n')
                  : 'Neither of you has said anything yet.',
      '',
      o.closing ? 'This is the last thing you will say in this conversation.' : null,
      'Say your next line. A line or two.',
      '',
      ('In ' + o.langName + '. ' + (o.register || '')).trim(),
      /* The player reads these too, so they have to be worth reading. This rule
         lives in the villager's own prompt and was missing here, which is how a
         laconic character ended up producing telegraphese: "\u9ec4\u660f\u51b7\uff1f" is not a
         sentence anyone says.

         It says nothing about length on purpose. The first draft ended "terse is
         fine, ungrammatical is not", and "terse" is the most salient word in it —
         a clause meant to permit brevity reads as an instruction to be brief. How
         long a villager's sentences are is their character's business; whether
         they are sentences is not. */
      'Say it the way a real ' + o.langName + ' speaker would actually say it out loud.',
      o.furigana ? 'Put the furigana in "say".\n' + LG.FURIGANA : null,
      '',
      'Reply with only a JSON object:',
      '{"say": "your line", "translation": "plain English"' +
        (o.romanLabel ? ', "roman": "' + o.romanLabel +
          (o.romanNote ? ', ' + o.romanNote : '') + '"' : '') + '}'
    ].filter(x => x !== null && x !== undefined).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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

  /* Add furigana to a Japanese line. The villager often forgets the ruby field,
     or returns it without markup — it is busy being a person. The small model
     has nothing else to do. Returns null if anything looks off. */
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
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
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

  /* Models drop the odd quote or leave a trailing comma. These repairs are all
     shape-level — none of them invents content. */
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

  /* Last resort: lift the fields out by hand. Anything is better than showing a
     player a brace. */
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

  /* Find the first balanced {...}. A missing quote throws the string-state
     tracking off, which is why repair runs before this, not after. */
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
  async function speak(cfg, system, messages) {
    const raw = cfg.provider === 'anthropic'
      ? await anthropicCall(cfg, system, messages)
      : await openrouterCall(cfg, system, messages);
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

  return { MODELS, HELPERS, VERIFIER, helperModel, speak, judge, furigana, gloss, converse, intent, recall,
           get transcript() { return transcript; }, dump,
           get audit() { return audit; }, set audit(v) { audit = !!v; }, confirmTrade,
           validate, parseJSON, repairJSON, salvage };
})();
