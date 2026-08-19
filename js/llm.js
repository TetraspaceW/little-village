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
      { id: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' }
    ]
  };

  // A small, cheap model does the notebook fact-checking (see judge below).
  const VERIFIER = {
    anthropic: 'claude-haiku-4-5',
    openrouter: 'anthropic/claude-haiku-4.5'
  };

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
  async function judge(cfg, said, translation, candidates) {
    if (!candidates.length) return [];
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
    lines.push('Reply with only a JSON array of the tags that were genuinely told, like ["f0"] or [].');

    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: VERIFIER[cfg.provider] || cfg.model };
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
    const m = String(raw).match(/\[[\s\S]*?\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr)) return [];
      const valid = {};
      candidates.forEach(c => valid[c.id] = true);
      return arr.map(x => String(x).replace(/[^\w]/g, '')).filter(id => valid[id]);
    } catch (e) { return []; }
  }

  /* Add furigana to a Japanese line. The villager often forgets the ruby field,
     or returns it without markup — it is busy being a person. The small model
     has nothing else to do. Returns null if anything looks off. */
  async function furigana(cfg, say) {
    const ask = [
      'Add furigana to this Japanese sentence.',
      '',
      'Sentence: ' + JSON.stringify(say),
      '',
      'Return the sentence exactly as it is, but wrap every kanji run in ruby tags with its',
      'reading in hiragana, like <ruby>漢字<rt>かんじ</rt></ruby>. Even a single kanji gets one.',
      'Change nothing else: same words, same kana, same punctuation, same order.',
      '',
      'Reply with only the rewritten sentence, no quotes and no explanation.'
    ].join('\n');
    const vcfg = { provider: cfg.provider, apiKey: cfg.apiKey, model: VERIFIER[cfg.provider] || cfg.model };
    try {
      const raw = vcfg.provider === 'anthropic'
        ? await anthropicCall(vcfg, 'You add furigana to Japanese text. Output the sentence only.',
            [{ role: 'user', content: ask }])
        : await openrouterCall(vcfg, 'You add furigana to Japanese text. Output the sentence only.',
            [{ role: 'user', content: ask }]);
      return String(raw).trim();
    } catch (e) { return null; }
  }

  /* Pull the first JSON object out of a reply, tolerating ```json fences and
     stray prose around it. */
  function parseJSON(text) {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
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
      else if (c === '}') { depth--; if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return null; }
      } }
    }
    return null;
  }

  /* Returns the parsed JSON object the character replied with. */
  async function speak(cfg, system, messages) {
    const raw = cfg.provider === 'anthropic'
      ? await anthropicCall(cfg, system, messages)
      : await openrouterCall(cfg, system, messages);
    const obj = parseJSON(raw);
    if (!obj) return { say: raw.slice(0, 300), translation: '', roman: '', action: 'none' };
    return obj;
  }

  return { MODELS, VERIFIER, speak, judge, furigana, validate, parseJSON };
})();
