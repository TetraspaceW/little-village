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
  const RUBY_OK = /^<\/?(?:ruby|rt|rp)>$/;
  function rubyHTML(str) {
    return String(str)
      // throw away any complete tag that is not exactly one of the three we allow,
      // so nothing with an attribute ever reaches the escape step
      .replace(/<\/?[a-zA-Z][^>]*>/g, m => (RUBY_OK.test(m) ? m : ''))
      .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/&lt;(\/?)(ruby|rt|rp)&gt;/g, '<$1$2>');
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
    lines.push('  "say": "what you say out loud, in ' + L.name + '",');
    lines.push('  "translation": "an English translation of exactly what you said",');
    if (L.romanize) lines.push('  "roman": "the ' + L.romanLabel + ' of what you said",');
    if (L.furigana) lines.push('  "ruby": "exactly what you said again, but with furigana: wrap every kanji run as <ruby>漢字<rt>かんじ</rt></ruby> and leave kana, punctuation and spacing untouched",');
    lines.push('  "understood": "full | partial | none — how much of what the traveller just said you actually understood",');
    lines.push('  "revealed": ["tags of any facts above that you plainly TOLD the traveller this turn — [] if none"],');
    lines.push('  "remember": "OPTIONAL: one short English sentence stating a NEW fact you just learned from the traveller. Omit this unless you understood them.",');
    lines.push('  "action": "' + (trade ? 'trade | none' : 'none') + '"');
    lines.push('}');
    lines.push('"translation" and "remember" are notes for the game, not speech — writing English there does not mean you understand any.');
    lines.push('"revealed" is about what you asserted, not what you talked about: using the word, explaining what it means, or asking after it does not count. When in doubt, leave it out.');
    if (trade) lines.push('Set "action" to "trade" at the moment you hand over ' + (trade.gives === 'coins' ? 'the coins' : LG.ITEMS[trade.gives].full) + ', and not before. Someone holding the thing out to you needs no words — that you always understand.');
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
        addLine('npc', h.say, h.translation, h.roman, h.ruby);
      });
    } else {
      status('Say hello — or click a phrase below.');
    }
    setTimeout(() => el.dlgInput.focus(), 60);
  }

  function close() {
    if (current) current.frozen = false;
    current = null;
    el.dlg.classList.remove('open');
    LG.game.canvas.focus();
  }

  function status(msg, kind) {
    el.dlgStatus.textContent = msg || '';
    el.dlgStatus.className = 'dlg-status ' + (kind || '');
  }

  function addLine(who, text, translation, roman, ruby) {
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
    if (roman) {
      const r = document.createElement('div');
      r.className = 'roman';
      r.textContent = roman;
      bub.appendChild(r);
    }
    if (translation) {
      const tr = document.createElement('div');
      tr.className = 'trans' + (s.showTranslation ? '' : ' hidden-tr');
      tr.textContent = translation;
      tr.title = s.showTranslation ? '' : 'click to reveal';
      tr.onclick = () => tr.classList.remove('hidden-tr');
      bub.appendChild(tr);
    }
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
      status('⚠ The reply could not be read. Try again.', 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    npc.history.push({ player: shown, say: reply.say, translation: reply.translation,
                       roman: reply.roman, ruby: reply.ruby });
    if (npc.history.length > 20) npc.history.shift();
    const gotIt = String(reply.understood || 'full').toLowerCase() !== 'none';
    if (gotIt && Array.isArray(reply.revealed) && reply.revealed.length) {
      verifying = verifyRevealed(npc, reply);   // deliberately not awaited
    }
    if (gotIt && reply.remember && typeof reply.remember === 'string' && reply.remember.length > 3) {
      if (npc.memory.indexOf(reply.remember) === -1) {
        npc.memory.push(reply.remember);
        LG.game.log(npc.def.name + ' will remember: "' + reply.remember + '"');
      }
    }

    addLine('npc', reply.say, reply.translation, reply.roman, reply.ruby);
    npc.bubble = reply.say; npc.bubbleT = 6;   // the canvas bubble stays plain text

    const u = String(reply.understood || '').toLowerCase();
    if (u === 'none') status(npc.def.name + ' did not understand you at all.', 'miss');
    else if (u === 'partial') status(npc.def.name + ' only caught part of that.', 'miss');
    else status('');

    // Trades: the model can trigger one, but if the player physically offered the
    // right thing we complete it regardless, so a conversation can never deadlock.
    const trade = npc.tradeDone ? null : (LG.game.plan.roles[npc.def.id] || {}).trade;
    if (trade) {
      const need = trade.wantsCount || 1;
      const offeredRight = offered === trade.wants && LG.game.count(trade.wants) >= need;
      const modelSaysTrade = gotIt && String(reply.action || '').toLowerCase().indexOf('trade') !== -1;
      if (offeredRight || (modelSaysTrade && LG.game.count(trade.wants) >= need)) {
        LG.game.doTrade(npc, trade);
        renderItems();
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
  let verifying = null;
  async function verifyRevealed(npc, reply) {
    const plan = LG.game.plan;
    const claimed = reply.revealed
      .map(id => String(id).replace(/[^\w]/g, ''))
      .filter(id => plan.facts[id] && npc.facts.indexOf(id) !== -1
                 && LG.game.state.notes.indexOf(id) === -1);
    if (!claimed.length) return;
    const candidates = claimed.map(id => ({ id, text: plan.facts[id].text }));
    try {
      const confirmed = await LG.llm.judge(LG.game.llmConfig(), reply.say, reply.translation, candidates);
      confirmed.forEach(id => LG.game.learn(id, npc));
    } catch (e) { /* an unwritten note is always better than a wrong one */ }
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

  return { init, open, close, send, chatterLine, isOpen: () => !!current, renderItems, addLine, status,
           settled: () => verifying || Promise.resolve(),
           _debugPrompt: systemPrompt, _rubyHTML: rubyHTML };
})();
