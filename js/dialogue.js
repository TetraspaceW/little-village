/* dialogue.js — talking to the little guys: prompt building, model calls,
   trades, memory, and the conversation UI. */
window.LG = window.LG || {};

LG.dialogue = (function () {
  let current = null;      // the npc we're talking to
  let busy = false;

  const el = {};
  function bind() {
    ['dlg','dlgName','dlgRole','dlgLog','dlgInput','dlgSend','dlgClose','dlgPhrases',
     'dlgItems','dlgStatus','dlgAvatar'].forEach(id => el[id] = document.getElementById(id));
  }

  function chatterLine() {
    const arr = LG.CHATTER[LG.game.settings.lang] || LG.CHATTER.en;
    return arr[(Math.random() * arr.length) | 0];
  }

  /* Furigana arrives as markup from the model, so escape everything and then
     let exactly three tags back through — no attributes, nothing else. */
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  // <rb> and <rtc> are part of the ruby family and models do emit them
  const RUBY_TAG = /^(?:ruby|rb|rt|rtc|rp)$/;

  /* Peel the furigana back off, permissively — attributes, casing and the whole
     ruby tag family. This only feeds the comparison below, never the page. */
  function stripRuby(html) {
    return String(html)
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<rtc\b[^>]*>[\s\S]*?<\/rtc>/gi, '')
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
      .replace(/<\/?(?:ruby|rb|rt|rtc|rp)\b[^>]*>/gi, '');
  }
  /* Compare loosely enough to survive width and spacing differences, strictly
     enough that we never show the player words the villager did not say. */
  function normText(str) {
    let t = String(str);
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.replace(/\s/g, '');
  }
  function rubyMatches(ruby, say) {
    if (!ruby) return false;
    return normText(stripRuby(ruby)) === normText(say);
  }

  /* A reply may arrive fenced or quoted. Try the plausible unwrappings and take
     the first that survives validation — nothing unvalidated is ever accepted. */
  function usableRuby(raw, say) {
    if (!raw) return null;
    const t = String(raw).trim();
    const tries = [t];
    const unfenced = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    tries.push(unfenced);
    tries.push(unfenced.replace(/^["'`\u300c\u300e]+/, '').replace(/["'`\u300d\u300f]+$/, '').trim());
    for (const cand of tries) if (rubyMatches(cand, say)) return cand;
    return null;
  }
  function needsFurigana(say) { return KANJI.test(String(say)); }

  /* A villager sometimes writes the target language into the English field. A
     translation full of hanzi, kana or Cyrillic is worse than no translation,
     so treat it as missing and fetch a real one. */
  const NOT_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;
  function looksEnglish(str) {
    const t = String(str || '').trim();
    if (!t) return false;
    if (NOT_LATIN.test(t)) return false;
    return /[a-z]{2}/i.test(t);
  }
  function rubyHTML(str) {
    return String(str)
      // Keep the ruby family but strip it back to a bare tag — that removes every
      // attribute while preserving the structure. Anything else tag-shaped goes.
      .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash, name) => {
        const n = name.toLowerCase();
        return RUBY_TAG.test(n) ? '<' + slash + n + '>' : '';
      })
      .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/&lt;(\/?)(ruby|rb|rt|rtc|rp)&gt;/g, '<$1$2>')
      .replace(/<ruby>([\s\S]*?)<\/ruby>/g, dropKanaRuby);
  }

  /* Katakana and hiragana already say how they sound, so a reading over them is
     just clutter. Keep the base text, drop the annotation. */
  function dropKanaRuby(match, inner) {
    const base = String(inner)
      .replace(/<rt>[\s\S]*?<\/rt>/g, '')
      .replace(/<rp>[\s\S]*?<\/rp>/g, '')
      .replace(/<rtc>[\s\S]*?<\/rtc>/g, '')
      .replace(/<\/?(?:rb|rt|rtc|rp)>/g, '');
    return KANJI.test(base) ? match : base;
  }

  function itemName(id, lang) {
    const it = LG.ITEMS[id];
    return (it && (it[lang] || it.en)) || id;
  }

  /* -------------------------------------------------------- prompt build */
  function systemPrompt(npc, offered) {
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const lvl = LG.LEVELS[s.level];
    const d = npc.def;
    const plan = LG.game.plan;
    const role = plan.roles[d.id] || { goal: '', trade: null };
    const inv = LG.game.inventoryList();
    const trade = npc.tradeDone ? null : role.trade;

    const lines = [];
    lines.push('You are playing a character in a small, gentle village video game that teaches ' + L.name + '.');
    lines.push('');
    lines.push('# Your character');
    lines.push('Name: ' + d.name + ' — ' + d.job + '.');
    lines.push('Personality: ' + d.persona);
    lines.push('Your current concern: ' + role.goal);
    lines.push('');
    lines.push('# What you know');
    lines.push('Each of these carries a tag. Say them in your own words when they come up in conversation — you are not reading from a list.');
    npc.facts.forEach(id => {
      const f = plan.facts[id];
      if (f) lines.push('- [' + id + '] ' + f.text);
    });
    if (!npc.facts.length) lines.push('- (nothing much, beyond your own business)');
    if (npc.memory.length) {
      lines.push('');
      lines.push('# What the traveller has told you');
      npc.memory.slice(-12).forEach(f => lines.push('- ' + f));
    }
    lines.push('');
    lines.push('# Where you are right now');
    lines.push(LG.time.describe());
    lines.push('Remark on the weather or the season if it comes naturally — it is what people here talk about — but do not force it into every reply.');
    lines.push('');
    lines.push('# The player');
    lines.push('A traveller visiting the village. They are learning ' + L.name + ' and will make mistakes — be patient with broken grammar and bad pronunciation.');
    lines.push('They are carrying: ' + (inv || 'nothing'));
    if (offered) lines.push('RIGHT NOW the player is holding out their ' + LG.ITEMS[offered].en + ' towards you.');
    lines.push('');
    lines.push('# Your language');
    lines.push(L.name + ' is the only language you know. When the traveller says something you cannot follow — a word from some other language, or just mangled — you simply do not follow it: you cannot answer a question you did not understand, and it cannot tell you to do anything. Reply to whatever part you did catch. Names of people and places you recognise in any accent.');
    lines.push('');
    lines.push('# How to speak');
    lines.push('Speak ONLY in ' + L.name + '. ' + lvl.prompt);
    lines.push('Whatever the level, every line you say must be something a real ' + L.name + ' speaker would actually say. Simplify by choosing easier words and shorter sentences — never by breaking the grammar. Do not drop small grammatical words to save space, and never sound like a telegram: the traveller learns by copying you, so what you say has to be worth copying.');
    lines.push('Stay in character. Never mention that you are an AI, a model, or a game character. Never break the fiction.');
    lines.push('Keep replies to 1-2 short sentences — this is a conversation, not a monologue.');
    lines.push('If the player asks about something you know, tell them. If you do not know, say so and suggest who might.');
    // What they have to sell, when they are standing where they work
    const working = LG.game.atWork(npc) && d.sells && d.sells.length;
    if (working) {
      const counter = LG.game.behindTheCounter(npc);
      lines.push('');
      lines.push('# Your trade');
      lines.push(counter
        ? 'You are at your own place of work, with your whole stock to hand.'
        : 'You are out and about, but your trade goes with you and you will happily do business.');
      lines.push('These are yours to sell. The price is what you usually ask, not a rule:');
      d.sells.forEach(w => lines.push('- ' + LG.ITEMS[w.i].full + ' — ' + w.p + ' coins [' + w.i + ']'));
      if (d.sellsTags && d.sellsTags.length) {
        const more = Object.keys(LG.ITEMS)
          .filter(k => k !== 'coins' && !d.sells.some(w => w.i === k) &&
                       d.sellsTags.some(t => (LG.ITEMS[k].tags || []).indexOf(t) !== -1));
        lines.push('You also keep the ordinary run of shop goods, about ' +
          Math.max(1, Math.round(LG.priceOf(more[0] || 'salt'))) + ' coins apiece — among them ' +
          more.slice(0, 14).map(k => LG.ITEMS[k].en + ' [' + k + ']').join(', ') +
          ', and plenty besides. If the traveller asks for something a village shop would stock, you have it.');
      }
      if (d.buys && d.buys.length) {
        lines.push('You would also buy, if the traveller happens to have one:');
        d.buys.forEach(w => lines.push('- ' + LG.ITEMS[w.i].full + ' — you would pay about ' + w.p + ' [' + w.i + ']'));
      }
      lines.push('The traveller has ' + LG.game.count('coins') + ' coins on them.');
      lines.push('Offer your goods the way you would to any customer, and haggle if it suits you.');
      lines.push('If the traveller holds out their coins, that is them paying you — take the money and hand the goods over in the same breath.');
    }

    if (trade) {
      lines.push('');
      lines.push('# Your deal');
      lines.push('You want: ' + (trade.wants === 'coins'
        ? trade.wantsCount + ' coins'
        : LG.ITEMS[trade.wants].full) + '.');
      lines.push('You will give in return: ' + (trade.gives === 'coins'
        ? trade.givesCount + ' coins'
        : LG.ITEMS[trade.gives].full) + '.');
      lines.push(trade.hint);
    }
    lines.push('');
    lines.push('# Reply format');
    lines.push('Reply with a single JSON object and nothing else:');
    lines.push('{');
    if (L.furigana) {
      lines.push('  "say": "what you say out loud, in ' + L.name + ', with furigana already in it: wrap each kanji word as <ruby>\u6f22\u5b57<rt>\u304b\u3093\u3058</rt></ruby>. Kanji only — katakana and hiragana stay bare.",');
    } else {
      lines.push('  "say": "what you say out loud, in ' + L.name + '",');
    }
    lines.push('  "translation": "an English translation of exactly what you said",');
    if (L.romanize) lines.push('  "roman": "the ' + L.romanLabel + ' of what you said",');
    lines.push('  "understood": "full | partial | none — how much of what the traveller just said you actually understood",');
    lines.push('  "revealed": ["tags of any facts above that you plainly TOLD the traveller this turn — [] if none"],');
    lines.push('  "remember": "OPTIONAL: one short English sentence stating a NEW fact you just learned from the traveller. Omit this unless you understood them.",');
    const acts = ['none'];
    if (trade) acts.push('trade');
    if (working) acts.push('sell', 'buy');
    if (working) {
      lines.push('  "item": "the [tag] of the goods — only with sell or buy",');
      lines.push('  "price": "the coins agreed, as a number — only with sell or buy",');
    }
    lines.push('  "action": "' + acts.join(' | ') + '"');
    lines.push('}');
    if (L.furigana) lines.push('Furigana gives the reading of the whole WORD as it is actually pronounced, never the character readings stitched together: \u5927\u5de5 is \u3060\u3044\u304f, not \u3060\u3044\u3053\u3046.');
    lines.push('"translation" and "remember" are notes for the game, not speech — writing English there does not mean you understand any.');
    lines.push('"revealed" is about what you asserted, not what you talked about: using the word, explaining what it means, or asking after it does not count. When in doubt, leave it out.');
    if (working && d.sells && d.sells.length) {
      lines.push('Use "sell" at the moment you actually hand goods over and take the money, and "buy" when you take something off the traveller and pay for it — not while the two of you are still discussing it.');
    }
    if (trade) {
      lines.push('Set "action" to "trade" at the moment you actually hand over ' + (trade.gives === 'coins' ? 'the coins' : LG.ITEMS[trade.gives].full) + ', and not before.');
      lines.push('Someone holding an object out to you is a gesture you understand without words — but a gesture is not yet a bargain. If it is not clear what the two of you are exchanging, ask them before you take it. Once the exchange is plain to you both, take it and hand yours over in the same breath.');
    }
    return lines.join('\n');
  }

  function historyMessages(npc) {
    const msgs = [];
    npc.history.slice(-8).forEach(h => {
      msgs.push({ role: 'user', content: h.player });
      msgs.push({ role: 'assistant', content: JSON.stringify({ say: h.say }) });
    });
    return msgs;
  }

  /* ---------------------------------------------------------------- UI */
  function open(npc) {
    current = npc;
    npc.frozen = true;
    npc.metPlayer = true;
    el.dlg.classList.add('open');
    el.dlgName.textContent = npc.def.name;
    el.dlgRole.textContent = npc.def.job;
    el.dlgAvatar.textContent = npc.def.emoji;
    el.dlgAvatar.style.background = npc.def.color;
    el.dlgLog.innerHTML = '';
    renderPhrases();
    renderItems();
    if (npc.history.length) {
      npc.history.slice(-4).forEach(h => {
        if (h.player) addLine('player', h.player);
        addLine('npc', h.say, h.translation, h.roman,
                rubyMatches(h.ruby, h.say) ? h.ruby : null, npc);
      });
    } else {
      status('Say hello — or click a phrase below.');
    }
    setTimeout(() => el.dlgInput.focus(), 60);
  }

  function close() {
    LG.tts.stop();
    if (current) current.frozen = false;
    current = null;
    el.dlg.classList.remove('open');
    LG.game.canvas.focus();
  }

  function status(msg, kind) {
    el.dlgStatus.textContent = msg || '';
    el.dlgStatus.className = 'dlg-status ' + (kind || '');
  }

  function speakLine(npc, text) {
    if (!npc || !LG.game.settings.voices) return;
    LG.tts.speak(LG.game.ttsConfig(), npc.def.id, text);
  }

  function addLine(who, text, translation, roman, ruby, npc) {
    const s = LG.game.settings;
    const row = document.createElement('div');
    row.className = 'line ' + who;
    const bub = document.createElement('div');
    bub.className = 'bub';
    const main = document.createElement('div');
    main.className = 'main';
    if (ruby && LG.LANGUAGES[s.lang].furigana) {
      main.innerHTML = rubyHTML(ruby);
      main.classList.add('has-ruby');
    } else {
      main.textContent = text;
    }
    if (who === 'npc') main.style.fontFamily = LG.LANGUAGES[s.lang].fontStack;
    bub.appendChild(main);
    if (who === 'npc' && npc && s.voices && LG.tts.state === 'ready') {
      const say = document.createElement('button');
      say.className = 'replay';
      say.textContent = '🔊';
      say.title = 'Hear it again';
      say.onclick = () => speakLine(npc, text);
      bub.appendChild(say);
    }
    // both gloss lines exist from the start so a late repair can fill them in
    const r = document.createElement('div');
    r.className = 'roman';
    r.textContent = roman || '';
    r.style.display = roman ? '' : 'none';
    bub.appendChild(r);

    const tr = document.createElement('div');
    tr.className = 'trans' + (s.showTranslation ? '' : ' hidden-tr');
    tr.textContent = translation || '';
    tr.title = s.showTranslation ? '' : 'click to reveal';
    tr.onclick = () => tr.classList.remove('hidden-tr');
    tr.style.display = translation ? '' : 'none';
    bub.appendChild(tr);

    row._main = main; row._roman = r; row._trans = tr;
    row.appendChild(bub);
    el.dlgLog.appendChild(row);
    el.dlgLog.scrollTop = el.dlgLog.scrollHeight;
    return row;
  }

  function renderPhrases() {
    const s = LG.game.settings;
    el.dlgPhrases.innerHTML = '';
    LG.PHRASES.forEach(p => {
      const b = document.createElement('button');
      b.className = 'chip';
      if (s.lang === 'ja' && p.jaRuby) { b.innerHTML = rubyHTML(p.jaRuby); b.classList.add('has-ruby'); }
      else b.textContent = p[s.lang] || p.en;
      b.style.fontFamily = LG.LANGUAGES[s.lang].fontStack;
      b.title = p.en;
      b.onclick = () => { el.dlgInput.value = p[s.lang] || p.en; el.dlgInput.focus(); };
      el.dlgPhrases.appendChild(b);
    });
  }

  function renderItems() {
    const s = LG.game.settings;
    el.dlgItems.innerHTML = '';
    const inv = LG.game.state.inv;
    const keys = Object.keys(inv).filter(k => inv[k] > 0);
    if (!keys.length) {
      el.dlgItems.innerHTML = '<span class="muted">(you are carrying nothing)</span>';
      return;
    }
    keys.forEach(k => {
      const b = document.createElement('button');
      b.className = 'chip item';
      b.innerHTML = LG.ITEMS[k].icon + ' <span>' + itemName(k, s.lang) +
        (inv[k] > 1 ? ' ×' + inv[k] : '') + '</span>';
      b.title = 'Offer your ' + LG.ITEMS[k].en;
      b.onclick = () => send('', k);
      el.dlgItems.appendChild(b);
    });
  }

  /* -------------------------------------------------------- the exchange */
  async function send(text, offered) {
    if (!current || busy) return;
    text = (text || '').trim();
    if (!text && !offered) return;
    const npc = current;
    busy = true;
    el.dlgSend.disabled = true;

    const shown = offered
      ? (text ? text + '  ' : '') + '[holds out the ' + LG.ITEMS[offered].en + ']'
      : text;
    addLine('player', shown);
    el.dlgInput.value = '';
    status(npc.def.name + ' is thinking…', 'thinking');

    let reply;
    try {
      const cfg = LG.game.llmConfig();
      const msgs = historyMessages(npc);
      msgs.push({ role: 'user', content: shown || '[says nothing, just holds out the item]' });
      reply = await LG.llm.speak(cfg, systemPrompt(npc, offered), msgs);
    } catch (err) {
      status('⚠ ' + err.message, 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    if (!reply || !reply.say) {
      status('⚠ ' + npc.def.name + ' said something the game could not read. Try again.', 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    // For a furigana language the villager annotates as it writes, so the spoken
    // line is whatever remains once the readings are peeled off.
    const L = LG.LANGUAGES[LG.game.settings.lang];
    let spoken = reply.say, ruby = null;
    if (L.furigana) {
      const bare = stripRuby(reply.say);
      if (bare !== reply.say) { ruby = reply.say; spoken = bare; }   // annotated in one pass
      else if (reply.ruby) ruby = usableRuby(reply.ruby, reply.say); // separate field, still honoured
    }

    const turn = { player: shown, say: spoken, translation: reply.translation,
                   roman: reply.roman, ruby: ruby };
    npc.history.push(turn);
    if (npc.history.length > 20) npc.history.shift();
    const gotIt = String(reply.understood || 'full').toLowerCase() !== 'none';
    if (gotIt && Array.isArray(reply.revealed) && reply.revealed.length) {
      pending.push(verifyRevealed(npc, reply, spoken, ruby));   // deliberately not awaited
    }
    if (gotIt && reply.remember && typeof reply.remember === 'string' && reply.remember.length > 3) {
      if (npc.memory.indexOf(reply.remember) === -1) {
        npc.memory.push(reply.remember);
        LG.game.log(npc.def.name + ' will remember: "' + reply.remember + '"');
      }
    }

    const row = addLine('npc', spoken, reply.translation, reply.roman, ruby, npc);
    speakLine(npc, spoken);
    if (L.furigana && !ruby && needsFurigana(spoken)) {
      pending.push(repairFurigana(npc, spoken, row));               // ask the small model for it
    }
    const missingTrans = !looksEnglish(reply.translation);
    const missingRoman = L.romanize && !looksEnglish(reply.roman);
    if (reply.translation && missingTrans) {
      // don't show the player a "translation" in the language they are learning
      reply.translation = '';
      turn.translation = '';
    }
    if (reply.roman && missingRoman) { reply.roman = ''; turn.roman = ''; }
    if (missingTrans || missingRoman) {
      pending.push(repairGloss(npc, spoken, row,
        { translation: !missingTrans, roman: !missingRoman }));
    }
    npc.bubble = spoken; npc.bubbleT = 6;   // the canvas bubble stays plain text

    const u = String(reply.understood || '').toLowerCase();
    if (u === 'none') status(npc.def.name + ' did not understand you at all.', 'miss');
    else if (u === 'partial') status(npc.def.name + ' only caught part of that.', 'miss');
    else status('');

    // Shopkeeping: the villager decides a sale has happened; the game makes it real.
    if (gotIt && LG.game.atWork(npc)) {
      const act = String(reply.action || '').toLowerCase();
      if (act === 'sell' || act === 'buy') {
        if (LG.game.commerce(npc, act, reply.item, reply.price)) renderItems();
        else status('That sale could not be squared up.', 'miss');
      }
    }

    // A trade happens because the villager agreed to it, never because an object
    // was waved at them. If they agreed in words but forgot the field, a second
    // reader catches that — see confirmOffer.
    const trade = npc.tradeDone ? null : (LG.game.plan.roles[npc.def.id] || {}).trade;
    if (trade) {
      const need = trade.wantsCount || 1;
      const haveEnough = LG.game.count(trade.wants) >= need;
      const modelSaysTrade = gotIt && String(reply.action || '').toLowerCase().indexOf('trade') !== -1;
      if (modelSaysTrade && haveEnough) {
        LG.game.doTrade(npc, trade);
        renderItems();
      } else if (offered === trade.wants && haveEnough) {
        pending.push(confirmOffer(npc, trade, spoken, reply.translation));
      } else if (offered) {
        status(npc.def.name + ' does not want your ' + LG.ITEMS[offered].en + '.');
      }
    } else if (offered) {
      status(npc.def.name + ' has no use for that.');
    }

    busy = false;
    el.dlgSend.disabled = false;
    el.dlgInput.focus();
  }

  /* The villager nominates facts it thinks it revealed; a second, cheaper model
     confirms them against what was actually said before anything is written in
     the notebook. Runs after the reply is on screen, so nobody waits for it. */
  const pending = [];

  /* A villager sometimes answers with no translation, or no romanisation. Ask
     the small model for the missing half rather than leaving a learner with a
     bare sentence. */
  async function repairGloss(npc, spoken, row, have) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    try {
      const got = await LG.llm.gloss(LG.game.llmConfig(), spoken,
        { langName: L.name, romanLabel: (L.romanize && !have.roman) ? L.romanLabel : null });
      if (!got) return;
      const turn = npc.history[npc.history.length - 1];
      if (!have.translation && got.translation) {
        if (turn && turn.say === spoken) turn.translation = got.translation;
        if (row && row._trans) { row._trans.textContent = got.translation; row._trans.style.display = ''; }
      }
      if (L.romanize && !have.roman && got.roman) {
        if (turn && turn.say === spoken) turn.roman = got.roman;
        if (row && row._roman) { row._roman.textContent = got.roman; row._roman.style.display = ''; }
      }
    } catch (e) { /* the line is still readable */ }
  }

  /* The player held out exactly the right thing and the villager did not flag a
     trade. Either they declined, or they agreed and dropped the field — ask a
     reader which it was. */
  async function confirmOffer(npc, trade, spoken, translation) {
    try {
      const yes = await LG.llm.confirmTrade(LG.game.llmConfig(), spoken, translation, {
        npcName: npc.def.name,
        wants: trade.wantsCount > 1 ? trade.wantsCount + ' coins' : LG.ITEMS[trade.wants].full,
        gives: trade.givesCount > 1 ? trade.givesCount + ' coins' : LG.ITEMS[trade.gives].full
      });
      if (!yes || npc.tradeDone) return;
      if (LG.game.count(trade.wants) < (trade.wantsCount || 1)) return;
      LG.game.doTrade(npc, trade);
      renderItems();
    } catch (e) { /* no deal */ }
  }

  /* The villager forgot the furigana (or mangled it). Ask the small model for
     just that, check it strips back to the same sentence, and slot it into the
     line already on screen. */
  async function repairFurigana(npc, spoken, row) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got = null;
      try { got = await LG.llm.furigana(LG.game.llmConfig(), spoken, attempt); }
      catch (e) { got = null; }
      last = got;
      const ok = usableRuby(got, spoken);
      if (ok) {
        const turn = npc.history[npc.history.length - 1];
        if (turn && turn.say === spoken) turn.ruby = ok;
        if (row && row._main) {
          row._main.innerHTML = rubyHTML(ok);
          row._main.classList.add('has-ruby');
        }
        return true;
      }
    }
    // Nothing usable. Say so rather than leaving the player wondering.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[furigana] gave up on this line.\n  said:     ' + spoken +
                   '\n  returned: ' + last);
    }
    status('No furigana for that line — ' + (last ? 'the reading did not match.' : 'the request failed.'), 'miss');
    return false;
  }

  async function verifyRevealed(npc, reply, spoken, ruby) {
    const plan = LG.game.plan;
    const claimed = reply.revealed
      .map(id => String(id).replace(/[^\w]/g, ''))
      .filter(id => plan.facts[id] && npc.facts.indexOf(id) !== -1 && !LG.game.hasNote(id));
    if (!claimed.length) return;
    const candidates = claimed.map(id => ({ id, text: plan.facts[id].text }));
    const L = LG.LANGUAGES[LG.game.settings.lang];
    try {
      const confirmed = await LG.llm.judge(LG.game.llmConfig(), spoken, reply.translation, candidates,
                                           { langName: L.name, furigana: !!L.furigana });
      confirmed.forEach(c => {
        // fall back to the line as spoken, so a note is never in the wrong language
        const note = c.note || spoken;
        const nRuby = usableRuby(c.ruby, c.note) || (c.note ? null : ruby);
        LG.game.learn(c.id, npc, note, nRuby);
      });
    } catch (e) { /* an unwritten note is always better than a wrong one */ }
  }

  /* Villagers passing news to each other, out loud, wherever they are. This runs
     on the small model, so the village talks to itself freely; the queue below
     exists only to stop a dozen simultaneous meetings firing at once, not to
     ration the conversation. */
  const chatQueue = [];
  let chatGap = 0, chatBusy = 0;
  const CHAT_GAP = 1.2, CHAT_PARALLEL = 2, CHAT_STALE = 12;

  function overheard(a, b, news) {
    if (chatQueue.length > 8) return;                  // a crowd, not a queue
    if (a.chatting || b.chatting) return;
    a.chatting = b.chatting = true;
    chatQueue.push({ a, b, aNews: news.aNews, bNews: news.bNews,
                     aExtra: news.aExtra, bExtra: news.bExtra, age: 0 });
  }

  function chatTick(dt) {
    chatGap -= dt;
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      chatQueue[i].age += dt;
      if (chatQueue[i].age > CHAT_STALE) {             // they have wandered off
        const q = chatQueue.splice(i, 1)[0];
        q.a.chatting = q.b.chatting = false;
      }
    }
    while (chatQueue.length && chatGap <= 0 && chatBusy < CHAT_PARALLEL) {
      chatGap = CHAT_GAP;
      startChat(chatQueue.shift());
    }
  }

  let turnHold = 2800;                 // how long a line sits before the reply
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* A meeting between two villagers, played out turn by turn. Each line is its
     own call to the small model, given that villager's persona and the
     transcript so far, so they are genuinely answering each other rather than
     performing an exchange one model wrote in advance. */
  async function startChat(job) {
    const a = job.a, b = job.b;
    chatBusy++;
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const turns = 4 + ((Math.random() * 3) | 0);        // 4–6 lines between them
    const transcript = [];
    const news = { };
    news[a.def.id] = job.aNews;
    news[b.def.id] = job.bNews;
    const extra = { };
    extra[a.def.id] = job.aExtra;
    extra[b.def.id] = job.bExtra;

    try {
      for (let t = 0; t < turns; t++) {
        // the player pulling one of them into a conversation ends this one
        if (a.frozen || b.frozen) break;
        const me = (t % 2 === 0) ? a : b, them = (t % 2 === 0) ? b : a;
        const turn = await LG.llm.converse(LG.game.llmConfig(), {
          me: { name: me.def.name, job: me.def.job, persona: me.def.persona },
          them: { name: them.def.name, job: them.def.job, persona: them.def.persona },
          // each villager brings their own news, and only mentions it once
          news: t < 2 ? news[me.def.id] : null,
          knows: extra[me.def.id],
          transcript: transcript,
          closing: t === turns - 1,
          when: t === 0 ? LG.time.describe() : '',
          langName: L.name,
          furigana: !!L.furigana,
          romanLabel: L.romanize ? L.romanLabel : null,
          register: (LG.LEVELS[s.level] || {}).register || ''
        });
        if (!turn) break;
        if (a.frozen || b.frozen) break;

        const plain = stripRuby(turn.say);
        transcript.push({ who: me.def.name, say: plain });
        me.bubble = plain; me.bubbleT = 5;
        // both of them stay put for as long as the conversation is running
        a.pauseT = Math.max(a.pauseT, 6); a.route = null;
        b.pauseT = Math.max(b.pauseT, 6); b.route = null;

        if (LG.game.canOverhear(a, b)) {
          const ruby = (L.furigana && plain !== turn.say) ? turn.say : null;
          LG.game.logSpeech(me.def.name, plain, ruby, turn.roman, turn.translation);
        }
        await sleep(turnHold);
      }
    } catch (e) { /* a dropped call just ends the conversation early */ }

    chatBusy--;
    a.chatting = b.chatting = false;
  }

  function init() {
    bind();
    el.dlgSend.onclick = () => send(el.dlgInput.value);
    el.dlgClose.onclick = close;
    el.dlgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(el.dlgInput.value); }
      if (e.key === 'Escape') close();
    });
  }

  return { init, open, close, send, chatterLine, overheard, chatTick,
           set turnHold(ms) { turnHold = ms; },
           _chatReset() {
             while (chatQueue.length) { const q = chatQueue.pop(); q.a.chatting = q.b.chatting = false; }
             chatGap = 0;
           },
           get chatPending() { return chatQueue.length; },
           get chatRunning() { return chatBusy; },
           isOpen: () => !!current, renderItems, addLine, status,
           settled: () => { const all = pending.splice(0); return Promise.all(all); },
           _debugPrompt: systemPrompt, _rubyHTML: rubyHTML,
           _stripRuby: stripRuby, _rubyMatches: rubyMatches, _needsFurigana: needsFurigana,
           _looksEnglish: looksEnglish,
           rubyHTML: rubyHTML, _usableRuby: usableRuby };
})();
