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

  async function anthropicCall(cfg, system, messages) {
    const data = await post('https://api.anthropic.com/v1/messages',
      anthropicHeaders(cfg), anthropicBody(cfg, system, messages, 700));
    if (data.stop_reason === 'refusal') throw new Error('The model declined to answer that.');
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  async function openrouterCall(cfg, system, messages) {
    const data = await post('https://openrouter.ai/api/v1/chat/completions',
      openrouterHeaders(cfg),
      { model: cfg.model, messages: [{ role: 'system', content: system }].concat(messages) });
    if (data.error) throw new Error(data.error.message || 'OpenRouter error');
    return data.choices[0].message.content || '';
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
      lines.push('  "ruby" - the same note with furigana over the kanji only, like <ruby>\u6f22\u5b57<rt>\u304b\u3093\u3058</rt></ruby>');
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
    if (o.romanLabel) want.push('  "roman": "the ' + o.romanLabel + ' of the line"');
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
  async function chatter(cfg, opts) {
    const o = opts || {};
    const lines = [
      'Two villagers have run into each other and stopped to talk. Write their exchange.',
      '',
      o.a.name + ' — ' + o.a.job + '. ' + o.a.persona,
      o.b.name + ' — ' + o.b.job + '. ' + o.b.persona,
      '',
      o.when || '',
      '',
      o.a.name + ' has been wanting to pass on this piece of news: ' + o.news,
      o.extra ? ('They also know: ' + o.extra) : '',
      '',
      'Write it in ' + o.langName + ' only. ' + (o.level || ''),
      o.a.name + ' brings the news up in their own way; ' + o.b.name + ' reacts in theirs.',
      'One short sentence each — this is two people passing in the street, not a scene.',
      '',
      'Reply with only a JSON object:',
      '{',
      '  "a": {"say": "' + o.a.name + '\u2019s line", "translation": "plain English"' +
        (o.romanLabel ? ', "roman": "' + o.romanLabel + '"' : '') + '},',
      '  "b": {"say": "' + o.b.name + '\u2019s line", "translation": "plain English"' +
        (o.romanLabel ? ', "roman": "' + o.romanLabel + '"' : '') + '}',
      '}'
    ].filter(Boolean).join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: helperModel(cfg) };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You write short village dialogue. Answer with JSON only.',
            [{ role: 'user', content: lines }])
        : await openrouterCall(vcfg, 'You write short village dialogue. Answer with JSON only.',
            [{ role: 'user', content: lines }]);
      const obj = parseJSON(raw);
      if (!obj || !obj.a || !obj.a.say || !obj.b || !obj.b.say) return null;
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
      'Return the sentence exactly as it is, but wrap every kanji run in ruby tags with its',
      'reading in hiragana, like <ruby>漢字<rt>かんじ</rt></ruby>. Even a single kanji gets one.',
      'Kanji only — katakana and hiragana are left exactly as they are, with no reading.',
      'Give the reading of the whole WORD as it is actually pronounced, never the character',
      'readings stitched together: \u5927\u5de5 is \u3060\u3044\u304f, not \u3060\u3044\u3053\u3046.',
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

  return { MODELS, HELPERS, VERIFIER, helperModel, speak, judge, furigana, gloss, chatter, confirmTrade,
           validate, parseJSON, repairJSON, salvage };
})();
