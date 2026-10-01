/* game.js — core game state, main loop, input handling, notebook, and settings. */
window.LG = window.LG || {};

LG.game = (function () {
  const W = LG.world, A = LG.actors, TILE = 32;

  const settings = {
    lang: 'ru', level: 'beginner', autorun: false,
    provider: 'openrouter', apiKey: '', model: 'deepseek/deepseek-v4.1-flash', helper: '',
    /* One key per provider, so switching provider and back doesn't lose
       the other one. `apiKey` is always the current provider's entry. */
    keys: { openrouter: '', logfare: '' },
    voices: false, ttsKey: ''
  };

  // `gated` blocks input until settings (incl. API key) are confirmed via the front-door panel.
  let gated = true, gateMode = false, lastValidated = '';
  let fromEnv = false;             // true if keys came from the log server's .env, not typed by the user
  // The settings panel's unsaved key per provider, and which provider the key box is showing right now.
  let draftKeys = {}, keyProvider = '';

  const state = { inv: {}, notes: [], deeds: [], won: false, board: [] };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0, dpr = 1;

  /* The ground, buildings and signs are painted to an offscreen layer and
     blitted each frame; it changes only when the player enters or leaves a
     room, snow depth moves, night falls or lifts, or the language changes.
     It's OVERSCAN pixels bigger than the view on every side, so a moving
     camera just blits from a new offset, and when the camera drifts off it
     only the strip that came into view is painted (scrollGroundLayer).
     Water glints, the fountain, characters and weather go on top each frame. */
  const OVERSCAN = 96;
  let groundCanvas = null, groundCtx = null, spareCanvas = null, spareCtx = null;
  const groundSeen = { x: NaN, y: NaN, roomX: NaN, roomY: NaN, snow: -1, night: false, lang: '' };
  let player, npcs = [], beast = null, worldItem = null;
  let whereFact = null;             // the fact saying where the world thing is lying
  let chainNeeds = {};              // items the errand cannot be finished without
  /* Bound to physical key positions (e.code), not the characters they
     produce (e.key) — on a Russian keyboard, e.key for WASD is цфыв and
     for E is у. Falls back to e.key only when e.code is unavailable. */
  const MOVE_CODE = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
                      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const MOVE_KEY  = { w: 'up', s: 'down', a: 'left', d: 'right',
                      arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
  function moveDir(e) {
    return MOVE_CODE[e.code] || MOVE_KEY[String(e.key || '').toLowerCase()] || null;
  }
  function isInteract(e) {
    if (e.code) return e.code === 'KeyE' || e.code === 'Space';
    const k = String(e.key || '').toLowerCase();
    return k === 'e' || k === ' ' || k === 'spacebar';
  }
  function isCancel(e) { return e.code === 'Escape' || e.key === 'Escape'; }
  function isShift(e) { return e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift'; }

  const held = { up: false, down: false, left: false, right: false, run: false };
  /* Running: Shift, the touch gesture (double-tap and hold, tracked in
     LG.touch, since a phone's steering thumb can't also hold a key), or the
     `autorun` setting. Each works whatever the others are doing. */
  function running() { return settings.autorun || held.run || LG.touch.runHeld; }
  // Close enough to talk: the E key and a tap both, and where a chasing villager stops.
  const REACH = TILE * 1.6;
  let last = 0, nearby = null;
  // A hint the player set off (an out-of-reach tap), kept on screen past the frame that recomputes the hint.
  let nudge = '', nudgeT = 0;
  const logLines = [];

  /* ------------------------------------------------------------ settings */
  function loadSettings() {
    try {
      const raw = localStorage.getItem('lg-settings');
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    /* A browser last saved with the removed Anthropic provider holds an
       Anthropic key and Claude model ids; drop them rather than send that
       key to OpenRouter. */
    if (!LG.llm.MODELS[settings.provider]) {
      settings.provider = 'openrouter';
      settings.apiKey = '';
      settings.model = LG.llm.MODELS.openrouter[0].id;
      settings.helper = '';
    }
    // An older browser kept one key for every provider: file it under the provider it was saved with.
    settings.keys = Object.assign({ openrouter: '', logfare: '' }, settings.keys);
    if (settings.apiKey && !settings.keys[settings.provider]) settings.keys[settings.provider] = settings.apiKey;
    settings.apiKey = settings.keys[settings.provider] || '';
    /* Settings that are no longer choices: villagers always gossip,
       translations always start blurred, voices are always cast from the
       curated library at a pace set by difficulty, and Jev is always used
       on OpenRouter. Dropped from an older browser's stored settings. */
    ['npcChatter', 'showTranslation', 'voiceQuality', 'voiceSpeed', 'jevMovement', 'jevValidation']
      .forEach(k => { delete settings[k]; });
  }
  function saveSettings() {
    try { localStorage.setItem('lg-settings', JSON.stringify(settings)); } catch (e) {}
  }
  function ttsConfig() {
    // Talking speed follows difficulty.
    const speed = (LG.LEVELS[settings.level] || {}).speed || 0.85;
    return { key: settings.ttsKey.trim(), speed: speed, lang: settings.lang };
  }
  function llmConfig() {
    return { provider: settings.provider, apiKey: settings.apiKey.trim(),
             model: settings.model, helper: settings.helper };
  }

  /* ---------------------------------------------------------- inventory */
  function count(id) { return state.inv[id] || 0; }
  function give(id, n) { state.inv[id] = (state.inv[id] || 0) + (n || 1); renderHUD(); }
  function take(id, n) {
    state.inv[id] = Math.max(0, (state.inv[id] || 0) - (n || 1));
    if (!state.inv[id]) delete state.inv[id];
    renderHUD();
  }
  /* `exclude` leaves out an animal following the player, which isn't in a
     pocket and is described separately (see LG.view.companion). */
  function inventoryList(exclude) {
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0 && k !== exclude);
    if (!ks.length) return '';
    // For the villager's prompt, so items are named as the rest of it names them (LG.itemSaid).
    return ks.map(k => LG.itemSaid(k, settings.lang, true) +
                       (state.inv[k] > 1 ? ' x' + state.inv[k] : '')).join(', ');
  }
  function itemLabel(id) { return LG.itemName(id, settings.lang); }

  /* What the player calls a villager: their job until that villager has
     told the player their own name (`nameKnown`, set in dialogue.js), never
     from hearsay. Everything that shows a villager to the player goes
     through this; what the model is told is unaffected. */
  function displayName(n) {
    return (n.nameKnown && n.def.name) || n.def.job;
  }
  /* Like displayName, for text in the village's language, where an English
     job would read as a stray foreign word: the villager's emoji instead. */
  function nameOrEmoji(n) {
    return (n.nameKnown && n.def.name) || n.def.emoji;
  }

  /* Narrates a deal ("you hand over the rope") in the village's language,
     from LG.TXN templates; the English fill is the click-to-reveal gloss. */
  function itemsPhrase(ids, lang) {
    const conj = ' ' + (LG.CONJ[lang] || LG.CONJ.en) + ' ';
    return ids.map(id => (LG.ITEMS[id] && (LG.ITEMS[id][lang] || LG.ITEMS[id].en)) || id).join(conj);
  }
  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : ''));
  }
  function txnLog(icon, key, native, english) {
    const set = LG.TXN[key];
    if (!set) return;
    const L = LG.LANGUAGES[settings.lang];
    const line = fillTemplate(set[settings.lang] || set.en, native);
    const gloss = fillTemplate(set.en, english);
    pushLog(icon + ' <span class="heard" lang="' + L.tag + '">' + escapeHTML(line) + '</span>' +
            '<span class="gloss hidden-tr" lang="en" title="click to read">' + escapeHTML(gloss) + '</span>');
  }

  /* ------------------------------------------------------------ notebook
     Only facts a villager has actually told the player (see `learn`).
     Opinion facts are learnable too, but aren't the errand, and the
     notebook is the page that says what to do next. */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (plan.facts[factId].type === 'opinion') return;   // gossip, not the errand
    if (hasNote(factId)) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    /* A note records only that the player was told something. Whether it's
       still a live lead is read off the world when drawn (factSpent). */
    state.notes.push({ id: factId, text: note || plan.facts[factId].text,
                       ruby: ruby || null });
    log('📓 ' + (note || plan.facts[factId].text));
    renderHUD();
  }

  /* ----------------------------------------------------------------- log */
  function pushLog(html) {
    logLines.push(html);
    if (logLines.length > 5) logLines.shift();
    const box = document.getElementById('log');
    box.innerHTML = logLines.map(l => '<div>' + l + '</div>').join('');
  }

  function log(msg) { pushLog(escapeHTML(msg)); }

  /* Logs a line overheard between two villagers, in their language with
     furigana or romanisation like any other line. The English gloss is
     there to check yourself against, blurred until clicked: overhearing
     is a comprehension test. */
  function logSpeech(name, said, ruby, roman, gloss) {
    const L = LG.LANGUAGES[settings.lang];
    const heard = (ruby && L.furigana) ? LG.dialogue.rubyHTML(ruby) : escapeHTML(said);
    let html = '<span class="who">\uD83D\uDC42 ' + escapeHTML(name) + ':</span> ' +
               '<span class="heard" lang="' + L.tag + '"' +
               (ruby && L.furigana ? ' style="line-height:2"' : '') +
               '>' + heard + '</span>';
    if (roman && L.romanize) html += '<span class="roman" lang="' + L.romanTag + '">' +
                                     escapeHTML(roman) + '</span>';
    if (gloss) html += '<span class="gloss hidden-tr" lang="en" title="click to read">' +
                       escapeHTML(gloss) + '</span>';
    pushLog(html);
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ----------------------------------------------------------------- HUD */
  function renderHUD() {
    const purse = document.getElementById('purse');
    if (purse) purse.textContent = '\u00a4' + (state.inv.coins || 0);
    const inv = document.getElementById('inv');
    const L = LG.LANGUAGES[settings.lang];
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0 && k !== 'coins');
    inv.innerHTML = ks.length
      ? ks.map(k => '<span class="pill" title="' + LG.ITEMS[k].en + '">' + LG.ITEMS[k].icon +
          ' <span lang="' + L.tag + '">' + escapeHTML(itemLabel(k)) +
          (state.inv[k] > 1 ? ' ×' + state.inv[k] : '') + '</span></span>').join('')
      : '<span class="muted">empty pockets</span>';

    const nb = document.getElementById('notebook');
    const rows = state.deeds.map(d => '<div class="q done">✔ ' + escapeHTML(d) + '</div>')
      .concat(state.notes.map(n => {
        const heard = (n.ruby && L.furigana) ? LG.dialogue.rubyHTML(n.ruby) : escapeHTML(n.text);
        const gloss = plan.facts[n.id].text;
        const done = factSpent(n.id);          // read off the world, never stored
        return '<div class="q' + (done ? ' done' : '') + '"><span class="heard" lang="' +
               L.tag + '"' + (L.furigana && n.ruby ? ' style="line-height:2"' : '') +
               '>' + (done ? '\u2714 ' : '\u2022 ') + heard + '</span>' +
               '<span class="gloss hidden-tr" lang="en" title="' + escapeHTML(gloss) + '">' +
               escapeHTML(gloss) + '</span></div>';
      }));
    nb.innerHTML = rows.length ? rows.join('')
      : '<div class="q muted">Nothing yet. Try asking around!</div>';
  }

  /* --------------------------------------------------------------- shops */

  // Every item the errand chain involves: wants, gives, the terminal item and the prize.
  function chainItems() {
    const out = {};
    if (!plan) return out;
    plan.links.forEach(lk => { out[lk.wants] = true; out[lk.gives] = true; });
    out[plan.terminal.item] = true;
    out[plan.prize] = true;
    delete out.coins;
    return out;
  }
  function neededForChain(id) { return !!chainNeeds[id]; }

  /* Carries out a sale or purchase a villager's reply claimed, or refuses
     it and says why. Their price stands within a haggling band. `item` may
     be a list ("beer and wine, that's six" is one sale). A 'buy' of
     something they sold the player is a refund, at the price paid, which
     their `buys` list doesn't need to cover. */
  function commerce(npc, act, itemId, price) {
    const d = npc.def;
    const coins = n => n + (n === 1 ? ' coin' : ' coins');

    npc.sold = npc.sold || {};                 // index of what can be refunded, and at what price
    npc.till = npc.till || [];                 // transaction log the villager's prompt can read
    npc.stock = npc.stock || {};               // items currently held (bought from the player)

    // Shut at night; the villager is told so through the till, like every refusal.
    if (!LG.view.open()) {
      return refuse('It is the middle of the night and you are not trading, so nothing changed hands.',
                    displayName(npc) + ' is not trading at this hour — nothing changed hands.');
    }

    /* A refusal goes in the till as well as the log, or the villager
       believes the deal they narrated went through. */
    function refuse(note, shown) {
      npc.till.push({ failed: true, note: note });
      log('¤ ' + (shown || note));
      renderHUD();
      return false;
    }

    // `itemId` can arrive as a list, or as one string like "beer, wine" — both are handled.
    /* A price of zero is narration, not a sale; the haggling band would
       otherwise round it up to a coin. A missing price is the usual one. */
    // `null` is how the reply schema says "no price given" -- missing, not zero.
    const named = price != null && String(price).trim() !== '';
    if (named && Number(price) === 0) {
      return refuse('Nothing was actually exchanged, so nothing happened.',
                    'No price was named, so nothing changed hands.');
    }

    const asked = (Array.isArray(itemId) ? itemId : String(itemId || '').split(/[,;+]|\band\b/))
      .map(x => String(x || '').replace(/[^\w]/g, ''))
      .filter(x => x && x !== 'coins' && LG.ITEMS[x]);
    if (!asked.length) return false;

    const back = id => npc.sold[id] && npc.sold[id].n > 0 ? npc.sold[id] : null;
    const priced = asked.map(id => {
      // An item they've bought from the player can be resold, whether or not it's normally part of their trade.
      if (act === 'sell') {
        const own = npc.stock[id] > 0 ? Math.max(1, Math.round(LG.priceOf(id))) : 0;
        return { id: id, base: priceFrom(d.sells, d.sellsTags, id, 1) || own, fromStock: own > 0 };
      }
      const owed = back(id);                       // returning something they sold you
      return owed ? { id: id, base: owed.price, refund: true }
                  : { id: id, base: priceFrom(d.buys, d.buysTags, id, 0.5) };
    }).filter(w => w.base > 0);

    // Whether the player has it at all comes before whether the villager buys it.
    if (act === 'buy') {
      const short = asked.filter(id => count(id) < 1);
      if (short.length) {
        const names = short.map(id => LG.ITEMS[id].en).join(' or ');
        return refuse('The traveller does not actually have ' + names + ' to give you.',
                      'You have no ' + names + ' to hand over.');
      }
    }

    /* An item the errand needs can't be sold for coins, or the chain could
       dead-end; trading it (doTrade) is how the chain moves. The note says
       only what the till did. */
    if (act === 'buy') {
      const spoken = asked.filter(neededForChain);
      if (spoken.length) {
        const names = spoken.map(id => LG.ITEMS[id].en).join(' and ');
        return refuse('The ' + names + ' did not change hands: that is not one you buy off them.',
                      displayName(npc) + ' will not buy the ' + names + ' — it is part of the errand.');
      }
    }

    if (!priced.length) {
      const names = asked.map(id => LG.ITEMS[id].en).join(' and ');
      const theirs = asked.filter(id => priceFrom(d.sells, d.sellsTags, id, 1) > 0);
      return theirs.length
        ? refuse('That is not one you sold them, so there is nothing to refund.',
                 displayName(npc) + ' did not sell you that ' + LG.ITEMS[theirs[0]].en + '.')
        : refuse('You do not deal in ' + names + ', and said so.',
                 displayName(npc) + ' does not deal in ' + names + '.');
    }

    const base = priced.reduce((n, w) => n + w.base, 0);
    let cost = named ? Math.round(Number(price)) : base;
    if (!isFinite(cost) || cost < 0) cost = base;

    // Clamped to a haggling band, and the player told when the clamp changes
    // the spoken price. A refund returns exactly what was paid.
    const refunding = priced.every(w => w.refund);
    const asking = cost;
    cost = refunding
      ? Math.min(cost, base)                                   // never more than was paid
      : Math.max(Math.ceil(base * 0.4), Math.min(Math.ceil(base * 2.5), cost));

    const names = priced.map(w => LG.ITEMS[w.id].full).join(' and ');

    /* The same goods from the same villager on the very next turn after a
       sale are a repeat of that sale (agreeing the price, then handing it
       over), not a second one. A later repeat is an ordinary second sale. */
    if (act === 'sell') {
      const last = npc.till[npc.till.length - 1];
      if (last && !last.failed && last.act === 'sell' && last.names === names &&
          (npc.turns || 0) - (last.turn || 0) <= 1) {
        return refuse('You had already handed over ' + names + ' and been paid for it, ' +
                      'so nothing changed hands this time.',
                      displayName(npc) + ' had already sold you ' + names + ' — nothing changed hands.');
      }
    }

    if (act === 'sell') {
      if (count('coins') < cost) {
        return refuse('The traveller could not afford that — they have ' +
          coins(count('coins')) + ', and you asked for ' + coins(cost) + '.',
          'Not enough coins for ' + names + ' (' + cost + ').');
      }
      take('coins', cost);
      priced.forEach(w => {
        if (npc.stock[w.id] > 0) npc.stock[w.id]--;      // off their own shelf
        give(w.id, 1);
        const share = Math.max(1, Math.round(cost * w.base / base));
        npc.sold[w.id] = { price: share, n: (npc.sold[w.id] ? npc.sold[w.id].n : 0) + 1 };
      });
    } else {
      priced.forEach(w => {
        take(w.id, 1);
        if (w.refund && npc.sold[w.id]) npc.sold[w.id].n--;
        // What they buy, they now hold, and can say so or sell it on.
        else npc.stock[w.id] = (npc.stock[w.id] || 0) + 1;
      });
      give('coins', cost);
    }

    if (asking !== cost) log('¤ ' + displayName(npc) + ' said ' + asking + ', the going rate is ' + cost + '.');
    const dealKey = act === 'sell' ? 'buy' : refunding ? 'refund' : 'handOver';
    const ids = priced.map(w => w.id);
    txnLog('¤', dealKey, { items: itemsPhrase(ids, settings.lang), name: nameOrEmoji(npc), cost: cost },
                          { items: itemsPhrase(ids, 'en'), name: displayName(npc), cost: cost });

    // The till is what the villager reads, so it records what the game did, in coins.
    npc.till.push({ act: act, refund: refunding, names: names, coins: cost,
                    asked: asking, at: LG.time.clock(), turn: npc.turns || 0 });
    renderHUD();
    return true;
  }

  /* ------------------------------------------------------------- trading */
  function doTrade(npc, trade) {
    const needN = trade.wantsCount || 1, giveN = trade.givesCount || 1;
    take(trade.wants, needN);
    give(trade.gives, giveN);
    npc.tradeDone = true;

    const got = trade.gives === 'coins' ? giveN + ' coins' : LG.ITEMS[trade.gives].full;
    const gave = trade.wants === 'coins' ? needN + ' coins' : LG.ITEMS[trade.wants].full;
    state.deeds.push('Gave ' + displayName(npc) + ' ' + gave + ', got ' + got + '.');
    const oneItem = (id, n, lang) => {
      const nm = (LG.ITEMS[id] && (LG.ITEMS[id][lang] || LG.ITEMS[id].en)) || id;
      return id === 'coins' ? n + ' ' + nm : nm;
    };
    txnLog('✔', 'tradeReceive',
      { item: oneItem(trade.gives, giveN, settings.lang), name: nameOrEmoji(npc) },
      { item: oneItem(trade.gives, giveN, 'en'), name: displayName(npc) });

    /* The player's notes on this deal stay, struck through (factSpent reads
       the trade). This villager's own facts about it are retired, since
       they did it themselves; anyone merely told keeps believing them until
       they hear otherwise. */
    const ofThisDeal = id => {
      const f = plan.facts[id];
      return !!(f && f.link === (plan.roles[npc.def.id] || {}).link && f.type !== 'opinion');
    };
    npc.facts = (npc.facts || []).filter(id => !ofThisDeal(id));
    remember(npc, 'The traveller gave you ' + gave + ' and you handed over ' + got +
                  '. That is done with.');

    if (beast && trade.wants === beast.item) {
      beast.following = false;
      beast.home = npc.def.home;
      beast.tx = npc.tx; beast.ty = npc.ty;
    }
    // Both sides of the exchange go in the till, so the villager knows it's done.
    npc.till = npc.till || [];
    npc.till.push({ act: 'trade', names: gave, gaveBack: got, coins: 0, asked: 0,
                    at: LG.time.clock() });

    if ((plan.roles[npc.def.id] || {}).link === 0) win();
    renderHUD();
    // Saved at once: chain progress shouldn't wait for the autosave.
    if (saving()) LG.save.write();
  }

  function win() {
    state.won = true;
    if (saving()) LG.save.write();
    const c = plan.links[0];
    document.getElementById('endingText').textContent =
      c.npcName + ' has ' + (LG.ITEMS[c.wants].full) + ' at last, and you have ' +
      LG.ITEMS[c.gives].full + ' to show for it — along with a fistful of a new language.';
    setTimeout(() => document.getElementById('ending').classList.add('open'), 900);
  }

  /* ------------------------------------------------------------- startup */
  function init() {
    loadSettings();
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d');
    W.build();

    /* A saved village resumes where it was left; `resume` restores the
       local copy at once and checks the log server's in the background. */
    if (!LG.save.resume(log)) newVillage(null, true);

    LG.dialogue.init();
    wireUI();
    resize();
    window.addEventListener('resize', resize);
    trackViewport();

    if (settings.apiKey) { gated = false; LG.llm.probe(llmConfig()); }
    else { openSettings(true); }
    showChrome();
    loadVoices();
    requestAnimationFrame(loop);
    adoptEnv();
  }

  /* Takes API keys (and any settings) from the log server's .env, if it's
     running. Doesn't hold up startup; the settings gate closes itself if a
     key arrives. */
  function adoptEnv() {
    if (typeof fetch !== 'function') return;
    if (typeof location === 'undefined' || !/^https?:/.test(location.protocol)) return;
    fetch('/env', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(env => { if (env) useEnv(env); })
      .catch(() => {});                       // no server, or not that sort of server
  }

  function useEnv(env) {
    const was = { lang: settings.lang, level: settings.level };
    if (LG.llm.MODELS[env.provider]) settings.provider = env.provider;
    if (env.openrouterKey) settings.keys.openrouter = env.openrouterKey;
    if (env.logfareKey) settings.keys.logfare = env.logfareKey;
    settings.apiKey = settings.keys[settings.provider] || '';
    let got = [];
    if ({ openrouter: env.openrouterKey, logfare: env.logfareKey }[settings.provider]) got.push('the model key');
    if (env.ttsKey) { settings.ttsKey = env.ttsKey; settings.voices = true; got.push('a voice key'); }
    if (env.model) settings.model = env.model;
    if (env.helper) settings.helper = env.helper;
    if (env.lang && LG.LANGUAGES[env.lang]) settings.lang = env.lang;
    if (env.level && LG.LEVELS[env.level]) settings.level = env.level;
    if (!got.length && was.lang === settings.lang && was.level === settings.level) return;

    fromEnv = true;
    saveSettings();
    /* Language and difficulty build the village, so a change rebuilds it,
       unless a saved village was resumed: that one keeps its own. */
    if (was.lang !== settings.lang || was.level !== settings.level) {
      if (LG.save.resumed) { settings.lang = was.lang; settings.level = was.level; }
      else newVillage(null, true);
    }
    if (settings.apiKey && gated) {
      gated = false; gateMode = false;
      document.getElementById('settings').classList.remove('open');
    }
    showChrome();
    renderHUD();
    if (settings.voices && settings.ttsKey) loadVoices();
    log('\u00a4 Read ' + got.join(' and ') + ' from .env.');
  }

  /* Generates a fresh errand chain and resets all state that depends on it.
     `given` is a saved plan from LG.save.restore, which lays the rest of
     the save over the result and must not have the bare village saved
     over it first. */
  function newVillage(seed, quiet, given) {
    plan = given || LG.chain.generate({ level: settings.level, seed: seed || null });

    // A random day of the year, and its weather; always mid-morning, never 3am in the dark.
    LG.time.start();

    state.inv = { coins: 10 };          // a little money to be going on with
    state.notes = []; state.deeds = []; state.won = false; state.board = [];

    // The player arrives by train, at the east end of the high street.
    const p = W.nearestOpen(LG.START.x, LG.START.y);
    player = { px: p.x * TILE + TILE / 2, py: p.y * TILE + TILE / 2, dir: 'left',
               tx: p.x, ty: p.y, bubble: null, bubbleT: 0 };
    npcs = LG.NPCS.map(d => A.makeNPC(d, plan.npcFacts[d.id]));
    // Every villager gets an assigned workplace, and a fallback indoor shelter for bad weather.
    const publics = ['Inn', 'Village Hall', 'Chapel']
      .map(l => W.buildingByLabel(l)).filter(Boolean);
    npcs.forEach((n, i) => {
      const b = n.def.workplace ? W.buildingByLabel(n.def.workplace) : null;
      n.work = b ? b.inside : (n.def.workRect || n.def.home);
      n.workBuilding = b;
      const refuge = b || publics[i % Math.max(1, publics.length)];
      n.shelter = refuge ? refuge.inside : n.def.home;
    });

    /* Petra, who knows everyone's business, always comes to meet the
       train: she starts already on her way over (see followPlayer). */
    const petra = npcs.find(n => n.def.id === 'petra');
    if (petra) {
      const spot = W.nearestOpen(p.x - 5, p.y + 1);
      petra.tx = spot.x; petra.ty = spot.y;
      petra.px = spot.x * TILE + TILE / 2; petra.py = spot.y * TILE + TILE / 2;
      petra.followingPlayer = true;
      petra.wentAfter = 'player';
      petra.why = 'a traveller has just got off the train, and nobody has told them anything about the village yet';
    }

    // Find the "where" fact -- the location of the terminal (chain-ending) item.
    whereFact = Object.keys(plan.facts).find(id => plan.facts[id].type === 'where') || null;
    chainNeeds = chainItems();
    beast = null; worldItem = null;
    const t = plan.terminal;
    if (t.isBeast) {
      beast = A.makeCreature({ item: t.item, name: t.beastName,
                               emoji: LG.ITEMS[t.item].icon, home: t.rect });
    } else {
      const r = t.rect;
      const spot = W.nearestOpen(r.x + ((Math.random() * r.w) | 0), r.y + ((Math.random() * r.h) | 0));
      worldItem = { item: t.item, px: spot.x * TILE + TILE / 2, py: spot.y * TILE + TILE / 2, taken: false };
    }

    renderHUD();
    logLines.length = 0;
    log(quiet ? (LG.touch.on
                  ? 'Drag anywhere to walk. Tap a villager you are beside to talk.'
                  : 'Use WASD or the arrow keys to walk. Press E next to someone to talk.')
              : 'A new village, in ' + LG.time.season().name.toLowerCase() +
                '. Nobody has told you anything yet.');
    // Saved at once, so closing the tab straight away doesn't bring back the old village.
    if (given) return;
    LG.save.keep();
    if (saving()) LG.save.write();
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    vw = Math.floor(r.width); vh = Math.floor(r.height);
    canvas.width = vw * dpr; canvas.height = vh * dpr;
    canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    readInsets();       // a phone that turned has swapped notch for home bar

    // The vignette is a CSS gradient over the canvas: filled into it every frame it cost Firefox ~5 ms.
    document.getElementById('vignette').style.background =
      'radial-gradient(circle at 50% 50%, rgba(20,14,8,0) ' + Math.round(Math.min(vw, vh) * 0.42) +
      'px, rgba(20,14,8,.3) ' + Math.round(Math.max(vw, vh) * 0.75) + 'px)';

    if (!groundCanvas) { groundCanvas = document.createElement('canvas'); spareCanvas = document.createElement('canvas'); }
    for (const c of [groundCanvas, spareCanvas]) {
      c.width = (vw + 2 * OVERSCAN) * dpr; c.height = (vh + 2 * OVERSCAN) * dpr;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = false;
    }
    groundCtx = groundCanvas.getContext('2d'); spareCtx = spareCanvas.getContext('2d');
    groundSeen.x = NaN;                  // a resized canvas has nothing painted on it yet
  }

  /* ------------------------------------------------- what you can see of it
     The canvas always fills the page, but on a phone less of it is visible:
     the browser's visible window can be shorter than the page and scrolled
     within it (an on-screen keyboard scrolls it, and closing one doesn't
     reliably scroll back), and viewport-fit=cover paints under the notch
     and nav buttons (env(safe-area-inset-*), read off #safe).
     The village is drawn under all of that, but the camera centres the
     player in the visible band and clamps the map's edges to it, so the
     bottom rows aren't stuck behind the nav buttons. On desktop the band is
     the whole canvas. It isn't updated while a keyboard is up or the page
     is pinch-zoomed. */
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let seenTop = 0, seenBottom = Infinity;    // the window, in page pixels

  function readInsets() {
    const el = document.getElementById('safe');
    const cs = el && window.getComputedStyle ? getComputedStyle(el) : null;
    if (!cs) return;
    const n = v => Math.max(0, parseFloat(v) || 0);
    insets = { top: n(cs.paddingTop), right: n(cs.paddingRight),
               bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) };
  }

  /* The visible band, in canvas pixels. A nonsensical measurement (before
     the first frame, say) falls back to the whole canvas, as a browser
     without visualViewport gets anyway. */
  function seen() {
    let top = Math.max(0, seenTop, insets.top);
    let bottom = Math.min(vh, seenBottom, vh - insets.bottom);
    let left = Math.max(0, insets.left), right = Math.min(vw, vw - insets.right);
    if (!(bottom - top > 1)) { top = 0; bottom = vh; }
    if (!(right - left > 1)) { left = 0; right = vw; }
    return { top: top, bottom: bottom, left: left, right: right };
  }

  /* An on-screen keyboard overlays a smaller visible window rather than
     shrinking the page, so the overlays and HUD are laid out to
     visualViewport while the canvas keeps the whole screen. The cramped/
     tight classes come from that height, not from focus: tapping "Say it"
     blurs the input with the keyboard still up. */
  const CRAMPED = 460;             // below this height, trays lose their full size
  const TIGHT = 320;               // below this height, trays are hidden entirely

  // About one row of keys: a smaller change is a suggestion strip, not the keyboard.
  const KB_ROW = 96;
  /* How long a taller reading that isn't the keyboard closing must last
     before it's believed: the keyboard's opening animation can overshoot
     its resting height, and a card that latched on would stay too short. */
  const GROW_MS = 220;
  let fullH = 0, fullW = 0;   // the tallest this window has been at this width
  let heldH = 0;              // the height the overlays are being laid out to
  let kbUp = false;           // is a keyboard over the page right now
  let growTimer = null;       // a taller reading waiting to see if it sticks
  let growTo = 0;             // what it is waiting to become

  function typingBox() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
  }

  function cancelGrow() {
    if (growTimer !== null) { clearTimeout(growTimer); growTimer = null; }
  }

  /* The height the overlays are laid out to. An IME's suggestion strip
     comes and goes with each word, a one-row resize each time, so while
     typing on touch the overlays follow the window down but ignore a grow
     of less than a row: the card doesn't hop under the text being read.
     A larger grow short of full height waits GROW_MS (see above). Losing
     focus falls back to the real measurement. Desktop always follows the
     real height. */
  function heightForOverlays(raw, w) {
    if (w !== fullW) { fullW = w; fullH = 0; heldH = 0; cancelGrow(); }   // the phone turned
    if (raw > fullH) fullH = raw;
    kbUp = fullH > 0 && fullH - raw > KB_ROW;
    if (!(kbUp && LG.touch.on && typingBox())) { heldH = 0; cancelGrow(); return raw; }
    if (!heldH || raw <= heldH) {
      heldH = raw;
      cancelGrow();
    } else if (growTimer === null || raw !== growTo) {
      cancelGrow();
      growTo = raw;
      growTimer = setTimeout(() => {
        growTimer = null;
        const vv = window.visualViewport;
        const nowRaw = vv ? vv.height : (window.innerHeight || 0);
        if (kbUp && nowRaw === growTo) { heldH = growTo; measureViewport(); }
      }, GROW_MS);
    }
    return heldH;
  }

  function measureViewport() {
    const vv = window.visualViewport;
    const raw = vv ? vv.height : (window.innerHeight || 0);
    const w = vv ? vv.width : (window.innerWidth || 0);
    const h = heightForOverlays(raw, w);
    const root = document.documentElement;
    if (root && root.style) {
      root.style.setProperty('--vv-h', h + 'px');
      root.style.setProperty('--vv-top', (vv ? vv.offsetTop : 0) + 'px');
    }
    // The camera gets the raw height: the hold is for the card being typed into, not the village behind it.
    if (!kbUp && !(vv && vv.scale > 1.01)) {
      seenTop = vv ? vv.offsetTop : 0;
      seenBottom = vv ? vv.offsetTop + raw : Infinity;
    }
    const b = document.body;
    if (b && b.classList) {
      const wasCramped = b.classList.contains('cramped');
      b.classList.toggle('cramped', h > 0 && h < CRAMPED);
      b.classList.toggle('tight', h > 0 && h < TIGHT);
      /* Android's back gesture can close the keyboard without blurring the
         input, so a return to full height blurs it, as tapping the
         conversation does. Text inputs only; the canvas keeps its focus. */
      if (LG.touch.on && wasCramped && !b.classList.contains('cramped')) {
        const a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) a.blur();
      }
    }
  }
  /* Firefox for Android can go on reporting the pre-keyboard height after
     focus until some unrelated event, so a focused input is rechecked a
     few times as the keyboard opens. */
  const FOCUS_RECHECK_MS = [80, 220, 450];

  function trackViewport() {
    const vv = window.visualViewport;
    if (vv && vv.addEventListener) {
      vv.addEventListener('resize', measureViewport);
      vv.addEventListener('scroll', measureViewport);
    }
    window.addEventListener('resize', measureViewport);
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (!LG.touch.on || !t || (t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT')) return;
      FOCUS_RECHECK_MS.forEach(ms => setTimeout(measureViewport, ms));
    });
    measureViewport();
  }

  /* --------------------------------------------------------------- input */
  function wireUI() {
    window.addEventListener('keydown', e => {
      if (uiBlocked()) return;
      const dir = moveDir(e);
      if (dir) { held[dir] = true; if (e.code !== 'KeyW' && e.code !== 'KeyA' &&
                 e.code !== 'KeyS' && e.code !== 'KeyD') e.preventDefault(); }
      if (isShift(e)) held.run = true;
      if (isInteract(e)) { e.preventDefault(); interact(); }
      if (isCancel(e)) closePanels();
    });
    window.addEventListener('keyup', e => {
      const dir = moveDir(e);
      if (dir) held[dir] = false;
      if (isShift(e)) held.run = false;
    });
    window.addEventListener('blur', () => { for (const k in held) held[k] = false; });

    // A blurred gloss anywhere (the log, notebook, board or a conversation) comes clear when clicked.
    document.addEventListener('click', e => {
      const gloss = e.target && e.target.closest && e.target.closest('.hidden-tr');
      if (gloss) gloss.classList.remove('hidden-tr');
    });

    LG.touch.init(canvas, { blocked: uiBlocked, tap: tapAt });

    // On a phone the HUD boxes cover the village: their headings fold them away.
    document.querySelectorAll('.hud-box h3').forEach(h => {
      h.onclick = () => h.parentElement.classList.toggle('folded');
    });

    document.getElementById('btnSettings').onclick = () => openSettings(false);
    document.getElementById('btnHelp').onclick = () =>
      document.getElementById('help').classList.toggle('open');
    document.getElementById('helpClose').onclick = () =>
      document.getElementById('help').classList.remove('open');
    document.getElementById('boardClose').onclick = () =>
      document.getElementById('board').classList.remove('open');
    document.getElementById('endingClose').onclick = () =>
      document.getElementById('ending').classList.remove('open');
    document.getElementById('endingAgain').onclick = () => {
      document.getElementById('ending').classList.remove('open');
      newVillage();
    };
    document.getElementById('setNew').onclick = () => submitSettings(true);
    document.getElementById('setForget').onclick = () => {
      LG.save.forget();
      log('\u00a4 The saved village has been forgotten. This one goes on until you start another.');
      showSaveNote();
    };
    // Not `= submitSettings`: the click event would arrive as a truthy forceNewVillage.
    document.getElementById('setSave').onclick = () => submitSettings(false);
    document.getElementById('setProvider').onchange = () => { swapKeyField(); refreshPickers(); };
    document.getElementById('setModel').onchange = () => syncPicker('model');
    document.getElementById('setHelper').onchange = () => syncPicker('helper');
  }

  /* Files the key box under the provider it was typed for and shows the
     newly picked provider's key, so a key survives a detour to the other. */
  function swapKeyField() {
    const field = document.getElementById('setKey');
    draftKeys[keyProvider] = field.value.trim();
    keyProvider = document.getElementById('setProvider').value;
    field.value = draftKeys[keyProvider] || '';
  }

  /* Before the settings gate is passed, the village behind it is a
     backdrop, and saving it would overwrite a real save. */
  function saving() { return !gated && !!plan; }

  function panelOpen() { return !!document.querySelector('.panel.open'); }
  function uiBlocked() { return gated || panelOpen() || LG.dialogue.isOpen(); }
  function closePanels() {
    if (gated) return;   // Escape does not close the front-door settings panel
    document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  }

  async function submitSettings(forceNewVillage) {
    const btn = document.getElementById('setSave');
    const newBtn = document.getElementById('setNew');
    const err = document.getElementById('setError');
    swapKeyField();                // files the key box under its provider; a no-op swap otherwise
    const next = {
      lang: document.getElementById('setLang').value,
      level: document.getElementById('setLevel').value,
      autorun: document.getElementById('setAutorun').checked,
      provider: document.getElementById('setProvider').value,
      apiKey: document.getElementById('setKey').value.trim(),
      keys: Object.assign({}, draftKeys),
      model: readPicker('model') || settings.model,
      helper: readPicker('helper'),
      voices: document.getElementById('setVoices').checked,
      ttsKey: document.getElementById('setTtsKey').value.trim()
    };
    err.textContent = '';

    // Skip re-validating the key when the provider/key/model haven't changed.
    const stamp = next.provider + '|' + next.apiKey + '|' + next.model;
    if (stamp !== lastValidated) {
      btn.disabled = true;
      newBtn.disabled = true;
      btn.textContent = 'Checking your key…';
      try {
        await LG.llm.validate({ provider: next.provider, apiKey: next.apiKey, model: next.model });
        lastValidated = stamp;
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
        newBtn.disabled = false;
        btn.textContent = gateMode ? 'Enter the village' : 'Save';
        return;
      }
      btn.disabled = false;
      newBtn.disabled = false;
    }

    const levelChanged = next.level !== settings.level;
    const voiceChanged = next.voices !== settings.voices || next.ttsKey !== settings.ttsKey;
    Object.assign(settings, next);
    saveSettings();
    // Schema support is per provider and model: look the new pair up ahead of the first call.
    LG.llm.probe(llmConfig());
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

    if (voiceChanged) { LG.tts.stop(); loadVoices(); }

    if (gateMode) {
      gated = false;
      gateMode = false;
      showChrome();
      /* Coming in through the front door keeps a resumed village; a new
         difficulty is a different village. */
      if (LG.save.resumed && !levelChanged) LG.save.write();
      else newVillage(null, true);
      document.getElementById('help').classList.add('open');
    } else if (levelChanged) {
      log('A different sort of errand, then.');
      newVillage();
    } else if (forceNewVillage) {
      newVillage();
    } else {
      log('The villagers now speak ' + LG.LANGUAGES[settings.lang].name + '.');
    }
  }

  // Casting voices is one request, made while the player is still reading the help panel.
  function loadVoices() {
    if (!settings.voices || !settings.ttsKey) return;
    LG.tts.load(ttsConfig()).then(ok => {
      if (ok) log('🔊 The villagers have found their voices.');
      else log('🔊 No voices: ' + LG.tts.error);
    });
  }

  // No HUD behind the title screen.
  function showChrome() {
    document.getElementById('hud').style.display = gated ? 'none' : '';
  }

  function openSettings(asGate) {
    gateMode = !!asGate;
    const s = document.getElementById('settings');
    document.getElementById('setTitle').textContent = gateMode ? 'Little Village' : 'Settings';
    document.getElementById('setLede').style.display = gateMode ? '' : 'none';
    document.getElementById('setNew').style.display = gateMode ? 'none' : '';
    document.getElementById('setSave').textContent = gateMode ? 'Enter the village' : 'Save';
    document.getElementById('setError').textContent = '';
    document.getElementById('setLang').value = settings.lang;
    document.getElementById('setLevel').value = settings.level;
    document.getElementById('setAutorun').checked = settings.autorun;
    document.getElementById('setProvider').value = settings.provider;
    draftKeys = Object.assign({}, settings.keys);
    keyProvider = settings.provider;
    document.getElementById('setKey').value = draftKeys[keyProvider] || '';
    // Shows where the key came from, so a pre-filled field isn't a mystery to the player.
    const note = document.getElementById('setKeyNote');
    if (note) {
      note.textContent = fromEnv ? 'filled from .env — type over it to change it for this session' : '';
      note.style.display = fromEnv ? '' : 'none';
    }
    document.getElementById('setVoices').checked = settings.voices;
    document.getElementById('setTtsKey').value = settings.ttsKey;
    refreshPickers();
    showSaveNote();
    s.classList.add('open');
  }

  // The one place the player is told their village is being saved, and where: autosaving is silent.
  function showSaveNote() {
    const note = document.getElementById('setSaveNote');
    const btn = document.getElementById('setForget');
    if (!note || !btn) return;
    const have = LG.save.has();
    btn.disabled = !have;
    if (!have && LG.save.forgotten) { note.textContent = 'Forgotten — this village is no longer being saved. A new village will be.'; return; }
    if (!have) { note.textContent = 'Nothing saved yet — the village is written down every few seconds once you are in it.'; return; }
    const when = LG.save.lastAt
      ? 'last written ' + new Date(LG.save.lastAt).toLocaleTimeString()
      : 'kept from an earlier session';
    note.textContent = 'This village is saved in this browser (' + when +
      ')' + (LG.save.onServer ? ' and in saves/village.json' : '') + '.';
  }

  /* The model and helper pickers: the provider's offered models, plus
     "Other", which reveals a box for any model id, so a model newer than
     the list can be used without editing the source. `role` is the
     setting each one fills in. */
  const PICKERS = {
    model: { sel: 'setModel', custom: 'setModelCustom', list: () => LG.llm.MODELS },
    helper: { sel: 'setHelper', custom: 'setHelperCustom', list: () => LG.llm.HELPERS }
  };

  function readPicker(role) {
    const p = PICKERS[role], sel = document.getElementById(p.sel);
    return sel.value !== 'other' ? sel.value : document.getElementById(p.custom).value.trim();
  }

  function refreshPicker(role) {
    const p = PICKERS[role], current = settings[role];
    const prov = document.getElementById('setProvider').value;
    const sel = document.getElementById(p.sel);
    const list = p.list()[prov] || [];
    // Logfare has exactly one model and always picks it — nothing to override.
    const fixed = prov === 'logfare';
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + (fixed ? '' : '<option value="other">Other — type an id below</option>');
    sel.disabled = fixed;
    const known = list.some(m => m.id === current);
    sel.value = fixed ? list[0].id
              : current && !known ? 'other' : (current || (list[0] && list[0].id) || 'other');
    document.getElementById(p.custom).value = fixed || known ? '' : current;
    syncPicker(role);
  }

  function syncPicker(role) {
    const p = PICKERS[role];
    const other = document.getElementById(p.sel).value === 'other';
    document.getElementById(p.custom).style.display = other ? '' : 'none';
  }

  function refreshPickers() {
    refreshPicker('model');
    refreshPicker('helper');
    document.getElementById('keyHint').textContent = document.getElementById('setProvider').value === 'logfare'
      ? 'From logfare.ai/register — free and instant, no email needed.'
      : 'From openrouter.ai/keys.';
  }

  /* A villager who came looking for the player speaks first, as between
     two villagers (see villagerTalk). `wentAfter` is read and cleared
     here, once (LG.view.arrived). */
  function talkTo(n) {
    const sought = n.wentAfter === 'player';
    const why = sought ? (n.why || '') : null;
    if (sought) { LG.view.arrived(n); n.bubble = null; n.bubbleT = 0; }
    LG.dialogue.open(n, why);
  }

  function interact() {
    if (nearby) { talkTo(nearby); return; }
    if (beast && !beast.caught && dist(player, beast) < TILE * 1.4) catchBeast();
    else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.4) pickUp();
    else if (nearBoard()) openBoard();
  }

  /* ------------------------------------------------------------------ a tap */
  /* A tap names its target, where E takes whatever's nearest, but both
     have the same reach, and a tap out of reach says so (`aside`): one
     that does nothing reads as a broken control. */

  /* A villager is ~16px wide and a fingertip ~40px, so hit boxes are
     padded; where two overlap, the nearer centre wins. */
  const TAP_PAD = 14;
  function tapPick(wx, wy) {
    // Only what's drawn can be tapped: not someone behind another building's walls.
    const room = W.buildingUnder(player);
    const seen = a => { const r = W.buildingUnder(a); return !r || r === room; };
    const marks = [];
    for (const n of npcs) if (seen(n)) marks.push({ kind: 'npc', a: n, reach: REACH });
    if (beast && !beast.caught && seen(beast))
      marks.push({ kind: 'beast', a: beast, reach: TILE * 1.4 });
    if (worldItem && !worldItem.taken)
      marks.push({ kind: 'item', a: worldItem, reach: TILE * 1.4 });

    let best = null, near = Infinity;
    for (const m of marks) {
      const a = m.a;
      if (Math.abs(wx - a.px) > 12 + TAP_PAD) continue;
      if (wy < a.py - 26 - TAP_PAD || wy > a.py + 14 + TAP_PAD) continue;
      const d = Math.hypot(wx - a.px, wy - (a.py - 6));
      if (d < near) { near = d; best = m; }
    }
    return best;
  }

  function aside(line) { nudge = line; nudgeT = 2.4; }

  // `sx`/`sy` are canvas coordinates; adding the camera gives the village's.
  function tapAt(sx, sy) {
    if (uiBlocked()) return;
    const wx = sx + cam.x, wy = sy + cam.y;
    const m = tapPick(wx, wy);
    if (m) {
      if (dist(player, m.a) > m.reach) {
        aside(m.kind === 'npc' ? 'Walk over to ' + displayName(m.a) + ' to talk.'
                               : 'Walk over to it first.');
      } else if (m.kind === 'npc') talkTo(m.a);
      else if (m.kind === 'beast') catchBeast();
      else pickUp();
      return;
    }

    // The noticeboard is a patch of ground, so it's hit by tile.
    const spot = { tx: (wx / TILE) | 0, ty: (wy / TILE) | 0 };
    if (nearRect(spot, LG.BOARD_SPOT, 0)) {
      if (nearBoard()) openBoard();
      else aside('Walk over to the noticeboard to read it.');
    }
  }

  // Whether the item at the end of the chain has been collected: once, for good.
  function haveTerminal() {
    return !!((worldItem && worldItem.taken) || (beast && beast.caught));
  }

  /* Whether a fact is spent: the one answer the notebook, learning and
     trading all use. It reads two things that never revert, the end item
     collected and a link's trade done, so nothing is stored to go stale. */
  function factSpent(id) {
    const f = plan && plan.facts[id];
    if (!f || f.type === 'opinion') return false;      // an opinion is never spent
    if (f.type === 'where') return haveTerminal();
    if (typeof f.link === 'number' && f.link >= 0) {
      const lk = plan.links[f.link];
      const owner = lk && npcs.find(n => n.def.id === lk.npcId);
      return !!(owner && owner.tradeDone);
    }
    return false;
  }

  function catchBeast() {
    beast.caught = true; beast.following = true;
    give(beast.item);
    renderHUD();
    log(beast.emoji + ' ' + beast.name + ' lets you pick ' + (Math.random() < 0.5 ? 'her' : 'him') + ' up.');
  }
  function pickUp() {
    worldItem.taken = true;
    give(worldItem.item);
    renderHUD();
    log(LG.ITEMS[worldItem.item].icon + ' You pick up ' + LG.ITEMS[worldItem.item].full + '.');
  }

  function dist(a, b) { return Math.hypot(a.px - b.px, a.py - b.py); }

  // The noticeboard is the ground rectangle villagers are sent to.
  function nearBoard() { return nearRect(player, LG.BOARD_SPOT, 1); }

  const nearRect = W.nearRect;

  /* Adds a memory for `npc`: the one way anything a villager believes
     arrives, each dated (`at`) and sourced (`from`, null for what they saw
     themselves), so two claims about the same thing can be weighed. */
  function remember(npc, text, from) {
    if (!text || typeof text !== 'string' || text.length < 3) return false;
    npc.memory = npc.memory || [];
    if (npc.memory.some(m => (m && m.text) === text)) return false;
    npc.memory.push({ at: LG.time.clock(), text: text, from: from || null });
    if (npc.memory.length > 24) npc.memory.shift();
    return true;
  }

  /* When and from whom a chain fact was learned. Facts dealt at the start
     are left unstamped, so they read as always known. */
  function noteFactSource(npc, id, from) {
    npc.factAt = npc.factAt || {};
    if (!npc.factAt[id]) npc.factAt[id] = { at: LG.time.clock(), from: from || null };
  }

  function noticeItemGone(n) {
    if (!whereFact || !haveTerminal()) return;
    const i = n.facts.indexOf(whereFact);
    if (i === -1) return;
    if (!nearRect(n, plan.terminal.rect, 3)) return;
    n.facts.splice(i, 1);
    /* What they saw and nothing more: that it wasn't there. A conclusion
       ("somebody took it") would be passed on as fact. */
    const t = plan.terminal;
    const line = t.isBeast
      ? 'You went ' + t.placeText + ' yourself and ' + t.beastName + ' was not there.'
      : 'You went ' + t.placeText + ' yourself and there was no ' +
        LG.ITEMS[t.item].en + ' there.';
    remember(n, line);                       // seen with their own eyes: no source to name
    think(n, 'finds nothing there', t.placeText);
  }

  /* The price this villager would sell or buy `id` at: their own list
     first, then their trade's tags. 0 if they don't deal in it. */
  function priceFrom(list, tags, id, factor) {
    const ware = (list || []).find(w => w.i === id);
    if (ware) return ware.p;
    const it = LG.ITEMS[id];
    if (it && tags && tags.some(t => (it.tags || []).indexOf(t) !== -1)) {
      return Math.max(1, Math.round(LG.priceOf(id) * (factor || 1)));
    }
    return 0;
  }

  /* Where a villager goes is decided from their goal and what they know
     (Jev or the helper model), not a dice roll; PHASE_TABLE in npc.js is
     the fallback. Asked at most once per DECIDE_COOL seconds. */
  const DECIDE_COOL = 25;

  /* Narrates a villager in the console, in their own colour, and to the
     log. `LG.game.thoughts = false` stops the console part. */
  let thoughts = true;
  function think(n, what, detail) {
    // The log keeps these whether or not the console is printing them.
    if (LG.logbook) LG.logbook.note('villager', n.def ? n.def.name : '?', what,
      { detail: detail || '', where: n.px !== undefined ? LG.view.where(n) : '',
        clock: LG.time && LG.time.clock ? LG.time.clock() : '' });
    if (!thoughts || typeof console === 'undefined' || !console.log) return;
    const c = (n.def && n.def.color) || '#888';
    console.log('%c ' + (n.def ? n.def.name : '?') + ' %c ' + what +
                (detail ? '%c  ' + detail : ''),
      'background:' + c + ';color:#fff;border-radius:3px;font-weight:600',
      'color:inherit',
      'color:#888;font-style:italic');
  }
  /* Everywhere a villager could walk to, including after anyone they can
     see: knowing who has something is only useful with a way to go and
     find them. */
  function placesFor(n) {
    const out = [{ name: 'home', rect: n.def.home, note: 'your own place' }];
    let workLabel = null;
    if (n.work) {
      // Named as the building (or `def.workLabel`, for a job that isn't a place);
      // an option called "your work" had models wondering where that was.
      workLabel = n.workBuilding ? n.workBuilding.label : (n.def.workLabel || n.def.job || 'your work');
      out.push({ name: workLabel, rect: n.work, note: 'where you work' });
    }
    // Not twice, for Petra, whose work is the green.
    if (workLabel !== 'the village green') {
      out.push({ name: 'the village green', rect: LG.GREEN, note: 'where people gather' });
    }
    out.push({ name: 'the noticeboard', rect: LG.BOARD_SPOT,
               note: 'where anyone may pin up a note for the village to read' });
    /* One way into the woods and one to the station, not every clearing:
       spread over six glades, villagers would be too thin to ever find. */
    const glade = (LG.PLACES.find(p => p.id === 'glade') || {}).rect;
    if (glade) out.push({ name: 'the big clearing', rect: glade,
                          note: 'up in the woods north of the village, a fair walk' });
    const platform = (LG.PLACES.find(p => p.id === 'platform') || {}).rect;
    if (platform) out.push({ name: 'the station platform', rect: platform,
                             note: 'the far end of the high street, where the train comes in' });
    W.buildings.forEach(b => {
      if (n.workBuilding && b === n.workBuilding) return;
      out.push({ name: b.label, rect: b.inside });
    });
    npcs.forEach(o => {
      if (o === n) return;
      if (!LG.view.near(n, o, LG.view.SIGHT)) return;   // only people they can see
      out.push({ name: 'after ' + o.def.name, rect: besideThem(o),
                 note: LG.view.where(o), after: o.def.id });
    });
    /* The player too, when in sight. Going after them is a chase
       (followPlayer), not a walk to where they stood. */
    if (LG.view.near(n, player, LG.view.SIGHT)) {
      out.push({ name: 'after you', rect: besideThem(player),
                 note: 'the traveller, wherever they get to', after: 'player' });
    }
    return out;
  }

  // A small area beside `o`, so going after someone ends up next to them, not on their tile.
  function besideThem(o) {
    return { x: Math.max(0, o.tx - 2), y: Math.max(0, o.ty - 2), w: 5, h: 5 };
  }

  function decideWhereToGo(n, green) {
    if (n.decideCool > 0) { n.deciding = false; return false; }   // rate limit -- decided too recently
    const opts = placesFor(n);
    const done = () => { n.deciding = false; n.decideCool = DECIDE_COOL; };
    think(n, 'wonders where to be', LG.view.where(n) + ', ' + LG.time.phase().name);
    // The same view of them as every other prompt, including what they know.
    const v = LG.view.of(n, 'intent');
    LG.llm.intent(llmConfig(), {
      me: v,
      goal: v.goal,
      when: v.when,
      here: v.here,
      folk: v.folk,
      held: LG.view.held(v),
      places: opts.map(o => ({ name: o.name, note: o.note }))
    }).then(res => {
      done();
      if (!res) { think(n, 'could not decide', 'falling back to habit'); return; }
      // Matched leniently: "village green" is "the village green".
      const norm = x => String(x).toLowerCase()
        .replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]/g, '').trim();
      const said = norm(res.go);
      const want = opts.find(o => norm(o.name) === said)
                || opts.find(o => said && (norm(o.name).indexOf(said) !== -1 ||
                                           said.indexOf(norm(o.name)) !== -1));
      if (!want) {
        think(n, 'wanted to go somewhere that is not a place', String(res.go));
        return;
      }
      n.why = res.why || '';
      if (want.after === 'player') {
        // A chase, not a walk: no `wantsGo`, so nothing stale is left once it ends.
        n.followingPlayer = true;
        n.wentAfter = 'player';
      } else {
        n.wantsGo = want.rect;
        // A "go after X" decision means any resulting conversation with X wasn't a chance encounter.
        n.wentAfter = want.after || null;
      }
      think(n, '\u2192 ' + want.name, n.why);
    }).catch(() => { done(); think(n, 'could not decide', 'the call failed'); });
    return true;
  }

  // Whether the player is near enough to overhear: it's logged if so, and happens either way.
  function canOverhear(a, b) {
    return dist(player, a) < TILE * 11 || dist(player, b) < TILE * 11;
  }

  /* Starts a conversation between two villagers who've met. Nothing is
     decided in advance, and what each takes away is worked out afterwards.
     Both are snapshotted once here, so the conversation is between them
     as they were when it began. */
  function villagerTalk(a, b) {
    if (!settings.apiKey) return false;
    const va = LG.view.of(a, 'chat'), vb = LG.view.of(b, 'chat');
    // Whether either came looking for the other, read once and cleared (LG.view.arrived).
    va.sought = va.errand.after === vb.id;
    vb.sought = vb.errand.after === va.id;
    LG.view.arrived(a); LG.view.arrived(b);
    LG.dialogue.overheard(a, b, { a: va, b: vb });
    return true;
  }

  /* ------------------------------------------------------------- the board
     A villager who walks to the noticeboard, and hasn't posted lately, is
     asked whether they'd pin anything up. What is up to them, and nothing
     is a fine answer. */
  const BOARD_MAX = 6;
  function maybePostNotice(n) {
    if (!settings.apiKey) return;
    if (n.boardCool > 0) return;
    n.boardCool = 90 + Math.random() * 150;
    const v = LG.view.of(n, 'board');
    const L = LG.LANGUAGES[settings.lang];
    const lvl = LG.LEVELS[settings.level] || {};
    think(n, 'wonders whether to pin anything up', '');
    LG.llm.notice(llmConfig(), {
      me: v, goal: v.goal, when: v.when,
      held: LG.view.held(v),
      board: (state.board || []).map(b => b.translation || b.text),
      langName: L.name, register: lvl.register,
      romanLabel: L.romanize ? L.romanLabel : null, romanNote: L.romanNote
    }).then(res => {
      if (!res || !res.post || !String(res.text || '').trim()) {
        think(n, 'had nothing to pin up', '');
        return;
      }
      pinNotice(n, res);
    }).catch(() => {});
  }

  function pinNotice(n, res) {
    const text = String(res.text).trim();
    const entry = { npcId: n.def.id, name: n.def.name, text: text,
                    translation: String(res.translation || '').trim(),
                    roman: String(res.roman || '').trim(), factIds: [], at: LG.time.clock() };
    state.board = state.board || [];
    state.board.push(entry);
    while (state.board.length > BOARD_MAX) state.board.shift();
    think(n, 'pins something up', text);
    log('📌 ' + displayName(n) + ' pins something up at the noticeboard.');
    if (saving()) LG.save.write();

    // Facts the notice claims to state are checked against its text, as in dialogue.
    const claimed = Array.isArray(res.revealed)
      ? res.revealed.map(id => String(id).replace(/[^\w]/g, ''))
                     .filter(id => plan.facts[id] && n.facts.indexOf(id) !== -1)
      : [];
    if (!claimed.length) return;
    const candidates = claimed.map(id => ({ id, text: plan.facts[id].text }));
    const L = LG.LANGUAGES[settings.lang];
    LG.llm.judge(llmConfig(), text, entry.translation, candidates, { who: n.def.name, langName: L.name })
      .then(confirmed => { confirmed.forEach(c => entry.factIds.push(c.id)); })
      .catch(() => {});
  }

  /* A notice's confirmed facts reach the notebook when the player reads
     it, not when it's pinned up. No source villager is passed: a notice
     stands on its own. */
  function openBoard() {
    (state.board || []).forEach(entry => {
      entry.factIds.forEach(id => learn(id, null, entry.text, null));
    });
    renderBoard();
    document.getElementById('board').classList.add('open');
  }

  function renderBoard() {
    const L = LG.LANGUAGES[settings.lang];
    const box = document.getElementById('boardList');
    const rows = (state.board || []).slice().reverse().map(entry => {
      // A notice is signed: the poster's name shows, unlike a nametag.
      const who = entry.name;
      return '<div class="notice"><span class="who">' + escapeHTML(who) + '</span>' +
             '<span class="heard" lang="' + L.tag + '">' + escapeHTML(entry.text) + '</span>' +
             (entry.roman && L.romanize ? '<span class="roman" lang="' + L.romanTag + '">' +
               escapeHTML(entry.roman) + '</span>' : '') +
             (entry.translation ? '<span class="gloss hidden-tr" lang="en" title="click to read">' +
               escapeHTML(entry.translation) + '</span>' : '') +
             '</div>';
    });
    box.innerHTML = rows.length ? rows.join('')
      : '<div class="notice muted">Nothing pinned up yet.</div>';
  }

  /* ---------------------------------------------------------------- loop */
  const WALK_SPEED = 132, RUN_SPEED = 210;
  /* Keys and the stick add into one vector, so both work at once. It's
     normalised only above length 1: keyboard diagonals stay full speed and
     a half-pushed stick walks at half speed. */
  function movePlayer(dt) {
    if (uiBlocked()) return;
    let dx = 0, dy = 0;
    if (held.left) dx -= 1;
    if (held.right) dx += 1;
    if (held.up) dy -= 1;
    if (held.down) dy += 1;
    const stick = LG.touch.axis;
    if (stick) { dx += stick.x; dy += stick.y; }
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const scale = len > 1 ? 1 / len : 1;
    const speed = running() ? RUN_SPEED : WALK_SPEED;
    const nx = player.px + dx * scale * speed * dt;
    const ny = player.py + dy * scale * speed * dt;
    if (canStand(nx, player.py)) player.px = nx;
    if (canStand(player.px, ny)) player.py = ny;
    player.tx = (player.px / TILE) | 0;
    player.ty = (player.py / TILE) | 0;
    if (Math.abs(dx) > Math.abs(dy)) player.dir = dx > 0 ? 'right' : 'left';
    else player.dir = dy > 0 ? 'down' : 'up';
  }

  function canStand(px, py) {
    const r = 8;
    for (const [ox, oy] of [[-r, 4], [r, 4], [-r, 10], [r, 10]]) {
      if (W.isSolid(((px + ox) / TILE) | 0, ((py + oy) / TILE) | 0)) return false;
    }
    return true;
  }

  /* A villager chasing the player: a real route, replanned every second
     or so rather than every frame, so the chase keeps to walls and doors.
     Given up after FOLLOW_GIVE_UP seconds without catching up. */
  const CATCH_UP = REACH;                  // close enough to be spoken to
  const FOLLOW_RECALC = 1.2;               // seconds between replanning the route
  const FOLLOW_GIVE_UP = 50;               // seconds of chasing before it can wait
  function followPlayer(n, dt) {
    if (dist(player, n) <= CATCH_UP) {
      n.followingPlayer = false; n.followFor = 0; n.route = null;
      const dx = player.px - n.px, dy = player.py - n.py;
      n.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      n.bubble = '…'; n.bubbleT = 40;      // waiting to be spoken to
      return false;
    }
    n.followFor = (n.followFor || 0) + dt;
    if (n.followFor > FOLLOW_GIVE_UP) {
      n.followingPlayer = false; n.followFor = 0; n.wentAfter = null; n.route = null;
      return false;
    }
    n.followCool = (n.followCool || 0) - dt;
    if (n.followCool <= 0 && !(n.route && n.route.length)) {
      const path = W.pathTo(n.tx, n.ty, player.tx, player.ty, 400);
      n.followCool = FOLLOW_RECALC + Math.random() * 0.6;
      if (path && path.length) n.route = path;
    }
    if (n.route && n.route.length) A.walk(n, dt, 140);   // hurrying, not their usual pace
    return true;
  }

  function update(dt) {
    if (saving()) LG.save.tick(dt);
    // Time stands still in a conversation, so a long one doesn't burn hours or turn the weather.
    if (!LG.dialogue.isOpen() && LG.time.tick(dt))
      log('🗓 ' + LG.time.season().name + ', day ' + LG.time.dayOfSeason() + '.');
    // Written only on a change: setting the same text still makes the browser redo layout.
    const el = document.getElementById('clock'), label = LG.time.label();
    if (el && el.textContent !== label) el.textContent = label;

    movePlayer(dt);

    for (const n of npcs) {
      const wasFollowing = n.followingPlayer;
      const walking = wasFollowing ? followPlayer(n, dt) : !!(n.route && n.route.length);
      if (!wasFollowing)
        A.routine(n, dt, LG.GREEN, settings.apiKey ? decideWhereToGo : null);
      if (n.wasWalking && !walking) {
        think(n, 'arrives', LG.view.where(n) + (n.why ? ' — ' + n.why : ''));
        // Not after a chase: `patch` is still where they last decided to go.
        if (!wasFollowing && n.patch === LG.BOARD_SPOT) maybePostNotice(n);
      }
      n.wasWalking = walking;
      if (!wasFollowing) A.walk(n, dt, 34);
      noticeItemGone(n);
      if (n.bubbleT > 0) n.bubbleT -= dt;
      if (n.boardCool > 0) n.boardCool -= dt;
    }
    LG.dialogue.chatTick(dt);
    A.meet(npcs, dt, log, LG.dialogue.chatterLine, villagerTalk);

    if (beast) {
      if (beast.following) {
        if (dist(player, beast) > TILE * 1.1) {
          beast.tx = player.tx; beast.ty = player.ty;
          A.stepTowards(beast, 118, dt);
        }
      } else {
        A.wander(beast, dt, beast.home, 26);
        // Catching it takes E or a tap; walking into it doesn't, unlike a dropped item.
      }
    }
    if (worldItem && !worldItem.taken && !uiBlocked() && dist(player, worldItem) < TILE * 0.7) pickUp();

    nearby = null;
    let best = REACH;
    for (const n of npcs) {
      const d = dist(player, n);
      if (d < best) { best = d; nearby = n; }
    }

    if (nudgeT > 0) nudgeT -= dt;
    const hint = document.getElementById('hint');
    // On touch the hint names what's there to tap; on a keyboard it names the key.
    const tap = LG.touch.on;
    let say = '';
    if (uiBlocked()) {
      // nothing, over an open panel
    } else if (nudgeT > 0) {
      say = nudge;
    } else if (nearby) {
      say = tap ? 'Tap ' + displayName(nearby) + ' to talk'
                : 'Press E to talk to ' + displayName(nearby);
    } else if (beast && !beast.caught && dist(player, beast) < TILE * 1.8) {
      say = (tap ? 'Tap to pick up ' : 'Press E to pick up ') + beast.name;
    } else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.8) {
      say = tap ? 'Tap to pick it up' : 'Press E to pick it up';
    } else if (nearBoard()) {
      say = tap ? 'Tap the noticeboard to read it'
                : 'Press E to read the noticeboard';
    }
    // Same as the clock: touched only on a change. A hidden hint keeps its
    // last text, so it doesn't blank out while it fades.
    if (say && hint.textContent !== say) hint.textContent = say;
    hint.classList.toggle('show', !!say);

    /* The camera centres the player in the visible band (see seen()) and
       clamps the map's edges to it, so corners aren't lost under browser
       chrome or phone controls. On desktop the band is the whole canvas. */
    const band = seen();
    const bw = band.right - band.left, bh = band.bottom - band.top;
    cam.x = clamp(player.px - (band.left + band.right) / 2, -band.left, W.W * TILE - band.right);
    cam.y = clamp(player.py - (band.top + band.bottom) / 2, -band.top, W.H * TILE - band.bottom);
    if (W.W * TILE < bw) cam.x = (W.W * TILE - bw) / 2 - band.left;
    if (W.H * TILE < bh) cam.y = (W.H * TILE - bh) / 2 - band.top;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function drawWorldItem() {
    if (!worldItem || worldItem.taken) return;
    const bob = Math.sin(performance.now() / 400) * 2.5;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#fff6c8';
    ctx.beginPath(); ctx.ellipse(worldItem.px, worldItem.py + 6, 13, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.font = '22px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(LG.ITEMS[worldItem.item].icon, worldItem.px, worldItem.py + 4 + bob);
  }

  /* The camera offset on whole device pixels: at a fractional dpr, a whole
     CSS pixel can land tile edges between device pixels and draw a faint
     lattice over the ground. The cached layer uses it too, to stay aligned. */
  function roundedCam() {
    return { x: Math.round(cam.x * dpr) / dpr, y: Math.round(cam.y * dpr) / dpr };
  }

  /* Paints the part of the cached layer at (rx, ry, rw, rh), in layer
     coordinates — the whole of it, or a strip that has just come into
     view. A strip is clipped to itself, and drawn from two tiles further
     out on every side, so what overhangs into it from just outside
     (roofs, drift shadows, a canopy's top) comes out exactly as a whole
     repaint would draw it. Signs are drawn for the whole layer, clipped. */
  function paintGround(room, rx, ry, rw, rh) {
    const g = groundCtx, at = { x: groundSeen.x, y: groundSeen.y };
    const w = vw + 2 * OVERSCAN, h = vh + 2 * OVERSCAN;
    const whole = rw >= w && rh >= h, m = whole ? 0 : W.TILE * 2;
    const part = { x: at.x + rx - m, y: at.y + ry - m }, pw = rw + 2 * m, ph = rh + 2 * m;
    g.save();
    if (!whole) { g.beginPath(); g.rect(rx, ry, rw, rh); g.clip(); }
    g.fillStyle = '#3f6b3a';
    g.fillRect(rx, ry, rw, rh);
    g.translate(-at.x, -at.y);
    W.drawGround(g, part, pw, ph, dpr);
    W.drawBuildings(g, room, part, pw, ph);
    W.drawSigns(g, at, w, h, settings.lang, dpr);
    g.restore();
  }

  /* Slides what's painted by the camera's move onto the spare canvas,
     which becomes the layer, then paints the strips that came into view.
     Moves are whole device pixels, like the layer's own position. */
  function scrollGroundLayer(room, nx, ny) {
    // In device pixels: the canvas's own size is rounded down from the
    // layer's at a fractional dpr, and a strip measured from the layer's
    // would leave a column of the spare canvas's old contents at its edge.
    const dw = groundCanvas.width, dh = groundCanvas.height;
    const dx = Math.round((nx - groundSeen.x) * dpr), dy = Math.round((ny - groundSeen.y) * dpr);
    spareCtx.setTransform(1, 0, 0, 1, 0, 0);
    spareCtx.drawImage(groundCanvas, -dx, -dy);
    spareCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    [groundCanvas, spareCanvas] = [spareCanvas, groundCanvas];
    [groundCtx, spareCtx] = [spareCtx, groundCtx];
    groundSeen.x = nx; groundSeen.y = ny;
    if (dx > 0) paintGround(room, (dw - dx) / dpr, 0, dx / dpr, dh / dpr);
    else if (dx < 0) paintGround(room, 0, 0, -dx / dpr, dh / dpr);
    if (dy > 0) paintGround(room, 0, (dh - dy) / dpr, dw / dpr, dy / dpr);
    else if (dy < 0) paintGround(room, 0, 0, dw / dpr, -dy / dpr);
  }

  /* Repaints the cached ground layer only when something in it changed: the
     camera leaving it, entering or leaving a room, snow depth moving a
     step, the lamps, or the signs' language. A camera move paints only the
     strip that came into view, and a snow step repaints one band a frame
     over GROUND_BANDS frames (a whole snowy repaint in one frame hitched
     Firefox by 30-45 ms). */
  const GROUND_BANDS = 6;
  let bandNext = 0, bandsOwed = 0;
  function refreshGroundLayer(room) {
    const c = roundedCam();
    const snow = Math.round((LG.time && typeof LG.time.snow === 'number' ? LG.time.snow : 0) * 400);
    const night = LG.time.isNight();
    const roomX = room ? room.x : -1, roomY = room ? room.y : -1;
    // Centred on the camera again, on whole device pixels like roundedCam(),
    // so the blit offset in draw() is always a whole number of device pixels.
    const nx = Math.round((c.x - OVERSCAN) * dpr) / dpr, ny = Math.round((c.y - OVERSCAN) * dpr) / dpr;
    const w = vw + 2 * OVERSCAN, h = vh + 2 * OVERSCAN;
    // Still the same picture, bar the snow and where it's been scrolled to.
    if (groundSeen.x === groundSeen.x &&                  // NaN until it's first painted
        roomX === groundSeen.roomX && roomY === groundSeen.roomY && night === groundSeen.night &&
        settings.lang === groundSeen.lang &&
        Math.abs(nx - groundSeen.x) < w / 2 && Math.abs(ny - groundSeen.y) < h / 2) {
      if (snow !== groundSeen.snow) { groundSeen.snow = snow; bandsOwed = GROUND_BANDS; }
      if (c.x < groundSeen.x || c.x > groundSeen.x + 2 * OVERSCAN ||
          c.y < groundSeen.y || c.y > groundSeen.y + 2 * OVERSCAN) scrollGroundLayer(room, nx, ny);
      if (bandsOwed) {
        // Bands are whole device pixels, like strips (see scrollGroundLayer).
        const dw = groundCanvas.width, dh = groundCanvas.height, bh = Math.ceil(dh / GROUND_BANDS);
        const top = bandNext * bh;
        paintGround(room, 0, top / dpr, dw / dpr, Math.min(bh, dh - top) / dpr);
        bandNext = (bandNext + 1) % GROUND_BANDS; bandsOwed--;
      }
      return;
    }
    groundSeen.x = nx; groundSeen.y = ny;
    groundSeen.roomX = roomX; groundSeen.roomY = roomY; groundSeen.snow = snow; groundSeen.night = night;
    groundSeen.lang = settings.lang;
    bandsOwed = 0;
    paintGround(room, 0, 0, w, h);
  }

  function draw() {
    const room = W.buildingUnder(player);
    refreshGroundLayer(room);
    const c = roundedCam();
    ctx.drawImage(groundCanvas, groundSeen.x - c.x, groundSeen.y - c.y,
                  groundCanvas.width / dpr, groundCanvas.height / dpr);

    ctx.save();
    ctx.translate(-c.x, -c.y);

    W.drawAnimated(ctx, c, vw, vh);
    drawWorldItem();

    /* Nobody inside a building the player isn't in (the roof lifts only on
       the player's own room), and nobody off screen; the margin is for
       their speech bubble. */
    const onScreen = a => a.px > c.x - 240 && a.px < c.x + vw + 240 &&
                          a.py > c.y - 240 && a.py < c.y + vh + 240;
    const drawables = npcs.filter(a => {
      if (!onScreen(a)) return false;
      const r = W.buildingUnder(a);
      return !r || r === room;
    });
    if (beast && onScreen(beast)) { const r = W.buildingUnder(beast); if (!r || r === room) drawables.push(beast); }
    drawables.push(player);
    drawables.sort((a, b) => a.py - b.py);

    for (const a of drawables) {
      if (a === player) {
        A.drawCharacter(ctx, a, { color: '#2f6fb0', skin: '#f2cba4', hair: '#2b2118', name: 'You', emoji: '🎒' });
      } else if (a.isBeast) {
        A.drawCharacter(ctx, a, { name: a.caught ? '' : a.name });
      } else {
        // The role emoji is always shown -- only the name is withheld until known.
        A.drawCharacter(ctx, a, {
          color: a.def.color, emoji: a.def.emoji, name: a.nameKnown ? a.def.name : '?',
          skin: '#f0c8a0', hair: '#3b2b20'
        });
      }
    }
    for (const a of drawables) {
      if (a.bubble) A.drawBubble(ctx, a, LG.LANGUAGES[settings.lang].fontStack);
    }

    ctx.restore();
    LG.sky.draw(ctx, vw, vh, W.roofRects(cam, vw, vh, dpr, room), dpr);

    // Drawn on top of the weather -- it's a UI control, not part of the scenery.
    LG.touch.draw(ctx);
  }

  function loop(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0);
    last = t;
    LG.sky.step(dt, vw, vh);
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  return { init, settings, state, llmConfig, ttsConfig, log, learn, hasNote, give, take, count,
           remember, noteFactSource, factSpent, displayName, nameOrEmoji,
           _moveDir: moveDir, _isInteract: isInteract, _tapAt: tapAt,
           get cam() { return cam; },
           canOverhear, logSpeech, think,
           factText: id => (plan && plan.facts[id]) ? plan.facts[id].text : null,
           set thoughts(v) { thoughts = !!v; },
           get thoughts() { return thoughts; },
           _debugPlayerAt: (x, y) => {
             player.px = x; player.py = y;
             player.tx = (x / TILE) | 0; player.ty = (y / TILE) | 0;
           },
           // Past the settings gate without a key, HUD showing: for the console and the tests.
           _debugOpenTheDoor: () => {
             gated = false;
             document.getElementById('settings').classList.remove('open');
             showChrome();
           },
           // one turn of the world by hand, for poking at it from the console
           // (and for tests, which cannot rely on requestAnimationFrame)
           _debugTick: dt => update(dt || 1 / 60),
           // Re-runs the viewport measurement, for a test environment
           // with no real keyboard to open and no browser to fire a resize event.
           _debugViewport: () => { readInsets(); measureViewport(); },
           // Returns the resulting visible-canvas band (see seen()).
           _debugSeen: seen,
           inventoryList, doTrade, commerce, renderHUD, openSettings, uiBlocked, newVillage,
           get plan() { return plan; },
           get npcs() { return npcs; },
           // what save.js reads and writes back; the rest of the world it can
           // reach through the exports above
           get player() { return player; },
           get beast() { return beast; },
           get worldItem() { return worldItem; },
           get saving() { return saving(); },
           get canvas() { return canvas; } };
})();

window.addEventListener('DOMContentLoaded', () => LG.game.init());
