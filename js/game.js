/* game.js — core game state, main loop, input handling, notebook, and settings. */
window.LG = window.LG || {};

LG.game = (function () {
  const W = LG.world, A = LG.actors, TILE = 32;

  const settings = {
    lang: 'ru', level: 'beginner',
    provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5', helper: '',
    showTranslation: true, npcChatter: true,
    voices: false, ttsKey: '', voiceSpeed: 'auto', voiceQuality: 'curated',
    dayMinutes: 6
  };

  // `gated` blocks input until settings (incl. API key) are confirmed via the front-door panel.
  let gated = true, gateMode = false, lastValidated = '';
  let fromEnv = false;             // true if keys came from the log server's .env, not typed by the user

  const state = { inv: {}, notes: [], deeds: [], won: false, board: [] };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0, dpr = 1;
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

  const held = { up: false, down: false, left: false, right: false };
  let last = 0, nearby = null;
  const logLines = [];

  /* ------------------------------------------------------------ settings */
  function loadSettings() {
    try {
      const raw = localStorage.getItem('lg-settings');
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem('lg-settings', JSON.stringify(settings)); } catch (e) {}
  }
  function ttsConfig() {
    const auto = (LG.LEVELS[settings.level] || {}).speed || 0.85;
    const speed = settings.voiceSpeed === 'auto' ? auto : Number(settings.voiceSpeed);
    return { key: settings.ttsKey.trim(), speed: speed,
             lang: settings.lang, curatedOnly: settings.voiceQuality === 'curated' };
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
  function inventoryList() {
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0);
    if (!ks.length) return '';
    return ks.map(k => LG.ITEMS[k].en + (state.inv[k] > 1 ? ' x' + state.inv[k] : '')).join(', ');
  }
  function itemLabel(id) {
    const it = LG.ITEMS[id];
    return (it && (it[settings.lang] || it.en)) || id;
  }

  /* A villager's name is unknown to the player until that villager
     actually states it — same rule the notebook applies to every other
     fact a villager knows, extended to cover names, which used to be
     shown for free. Every place that would otherwise print
     `npc.def.name` directly to the player goes through this function
     instead. Doesn't affect what the model itself is told (its own name
     in its system prompt) — only what the *player* has been told.
     `nameKnown` is set only when a villager's own reply states their
     name — see the check in dialogue.js — never by a fact arriving via
     any other source, however reliable, since that isn't the villager
     telling the player their name. */
  function displayName(n) {
    return (n.nameKnown && n.def.name) || n.def.job;
  }
  /* Like displayName, but for text written *in the village's language*
     — an English job description there would read as an out-of-place
     foreign word. Uses the emoji instead, matching how every character
     is already marked on screen (see drawCharacter): identifiable, if
     not yet named. */
  function nameOrEmoji(n) {
    return (n.nameKnown && n.def.name) || n.def.emoji;
  }

  /* Narrates a completed deal ("you hand over the rope") in the
     village's language rather than English — see LG.TXN. `native` and
     `english` fill the same template's placeholders in each language;
     the English fill doubles as the click-to-reveal gloss, matching
     everything else the notebook shows. */
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
    const hide = settings.showTranslation ? '' : ' hidden-tr';
    pushLog(icon + ' <span class="heard" lang="' + L.tag + '">' + escapeHTML(line) + '</span>' +
            '<span class="gloss' + hide + '" lang="en" title="click to read">' + escapeHTML(gloss) + '</span>');
  }

  /* ------------------------------------------------------------ notebook
     The notebook only contains facts a villager has actually told the
     player — villagers self-report which facts they revealed, and those
     reports are recorded here (see `learn` below). */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (hasNote(factId)) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    /* A note records only that the player was told something — not
       whether it's still actionable. That state was previously cached
       and could go stale: e.g. a note about an item's location used to
       still display as a live lead even after the item was already in
       the player's inventory. `factSpent` (see renderHUD) now reads that
       status live from current game state at render time instead, so
       there's no cached flag that can be wrong. */
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
    Array.prototype.forEach.call(box.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  function log(msg) { pushLog(escapeHTML(msg)); }

  /* Logs a line overheard between two villagers.

     Villagers speak to each other only in their own language — no
     English shown by default, matching the exchange itself. The line
     shown carries furigana/romanization like any other displayed line.
     The English gloss is available to self-check against but stays
     blurred until clicked, and unlike other lines it stays blurred even
     with translations turned on globally — showing it by default would
     let the player skip understanding the overheard language entirely. */
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
        const hide = settings.showTranslation ? '' : ' hidden-tr';
        const done = factSpent(n.id);          // read off the world, never stored
        return '<div class="q' + (done ? ' done' : '') + '"><span class="heard" lang="' +
               L.tag + '"' + (L.furigana && n.ruby ? ' style="line-height:2"' : '') +
               '>' + (done ? '\u2714 ' : '\u2022 ') + heard + '</span>' +
               '<span class="gloss' + hide + '" lang="en" title="' + escapeHTML(gloss) + '">' +
               escapeHTML(gloss) + '</span></div>';
      }));
    nb.innerHTML = rows.length ? rows.join('')
      : '<div class="q muted">Nothing yet. Ask around — somebody here wants something.</div>';
    Array.prototype.forEach.call(nb.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  /* --------------------------------------------------------------- shops */

  /* Set of every item id involved anywhere in the errand chain (wants,
     gives, the terminal item, the prize). Computed once per village
     rather than per sale, since it's fixed for the whole playthrough. */
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

  /* Processes a sale (single or multi-item) or its reverse (a refund).

     The villager's reply claims a sale happened; this function verifies
     and applies it, or explains why it can't. Their stated price is
     accepted as long as it isn't unreasonable — haggling is intentional
     and allowed.

     `item` accepts a list (not just a single tag), since a villager might
     narrate "beer and wine, that's six" as one sale. A single-tag-only
     version of this used to ring up a two-item sale as one item at the
     combined price — the player paid for both but only received one.

     Also handles taking an item back for a refund. A villager's `buys`
     list is only what they purchase as their trade (e.g. the innkeeper
     buys fish and meat) — it doesn't include their own recently-sold
     stock, so refunding a beer just poured a few minutes ago used to
     silently fail (no listed price for it) while the villager narrated
     agreeing to refund it. What was actually sold to the player is now
     tracked separately, and a refund uses the price actually paid. */
  function commerce(npc, act, itemId, price) {
    const d = npc.def;
    const coins = n => n + (n === 1 ? ' coin' : ' coins');

    npc.sold = npc.sold || {};                 // index of what can be refunded, and at what price
    npc.till = npc.till || [];                 // transaction log the villager's prompt can read
    npc.stock = npc.stock || {};               // items currently held (bought from the player)

    /* Blocks trading at night. Before the till existed, this was a bare
       `return false` — a silent failure: the villager's reply had already
       narrated handing over tea and taking payment, with nothing in the
       game state or conversation ever contradicting it. */
    if (!LG.view.open()) {
      return refuse('It is the middle of the night and you are not trading, so nothing changed hands.',
                    d.name + ' is not trading at this hour — nothing changed hands.');
    }

    /* A refusal must be visible to the villager via the till, not just
       to the player — otherwise the villager narrates the refund as
       completed with no way to know the game disagreed, then is
       confused when the same item is offered again later. */
    function refuse(note, shown) {
      npc.till.push({ failed: true, note: note });
      log('¤ ' + (shown || note));
      renderHUD();
      return false;
    }

    // `itemId` can arrive as a list, or as one string like "beer, wine" — both are handled.
    /* An explicit price of zero means nothing was actually being sold —
       just narration, not a real deal — and rejects it outright rather
       than letting the haggle-band logic below silently invent a
       non-zero price for it (which used to charge the player for a
       purchase nobody intended to make). A missing/unspecified price
       still falls back to the item's normal value. */
    if (Number(price) === 0 && String(price) !== '') {
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

    /* Check whether the villager actually holds the item before
       checking whether it has a price — otherwise a villager who does
       sell beer, but is out of stock, would incorrectly report not
       dealing in beer at all. */
    if (act === 'buy') {
      const short = asked.filter(id => count(id) < 1);
      if (short.length) {
        const names = short.map(id => LG.ITEMS[id].en).join(' or ');
        return refuse('The traveller does not actually have ' + names + ' to give you.',
                      'You have no ' + names + ' to hand over.');
      }
    }

    /* An item needed for the errand chain can't be sold to a villager
       for plain coins — without this, e.g. the pie the baker is waiting
       for could be sold to the innkeeper, breaking the chain with no way
       to recover it short of buying it back at her price. Trading (via
       doTrade, a different code path) still works normally — that's how
       the chain is supposed to move.

       The refusal note only states what the till did. It used to also
       claim the traveller was "carrying it for somebody," which is a
       fact this villager has no way of actually knowing. */
    if (act === 'buy') {
      const spoken = asked.filter(neededForChain);
      if (spoken.length) {
        const names = spoken.map(id => LG.ITEMS[id].en).join(' and ');
        return refuse('The ' + names + ' did not change hands: that is not one you buy off them.',
                      d.name + ' will not buy the ' + names + ' — it is part of the errand.');
      }
    }

    if (!priced.length) {
      const names = asked.map(id => LG.ITEMS[id].en).join(' and ');
      const theirs = asked.filter(id => priceFrom(d.sells, d.sellsTags, id, 1) > 0);
      return theirs.length
        ? refuse('That is not one you sold them, so there is nothing to refund.',
                 d.name + ' did not sell you that ' + LG.ITEMS[theirs[0]].en + '.')
        : refuse('You do not deal in ' + names + ', and said so.',
                 d.name + ' does not deal in ' + names + '.');
    }

    const base = priced.reduce((n, w) => n + w.base, 0);
    let cost = Math.round(Number(price));
    if (!isFinite(cost) || cost < 0) cost = base;

    // Clamps price to a reasonable haggle range (not a scam); when the
    // clamp actually changes the price, that's logged so the player sees
    // a number that wasn't spoken in the conversation. A refund is never
    // haggled — it returns the exact price paid.
    const refunding = priced.every(w => w.refund);
    const asking = cost;
    cost = refunding
      ? Math.min(cost, base)                                   // never more than was paid
      : Math.max(Math.ceil(base * 0.4), Math.min(Math.ceil(base * 2.5), cost));

    const names = priced.map(w => LG.ITEMS[w.id].full).join(' and ');

    /* Guards against one sale being processed twice. A villager could
       set "action": "sell" on the turn they merely agreed to a price
       ("two coins and it's yours" — a bargain being struck, not goods
       actually changing hands), then set it again on the very next turn
       when the player held out coins in response — resulting in the item
       being sold and paid for twice. Prompting the model to only use
       "sell" once goods actually change hands helps but relies on model
       judgment; this check is a hard guarantee: an identical item, from
       the same villager, on the very next turn after already being sold
       and paid for, is rejected as a duplicate. A later repeat (e.g. the
       next day) is allowed — wanting a second knife later is ordinary.
       The rejection is recorded in the till, not silently absorbed as a
       second payment. */
    if (act === 'sell') {
      const last = npc.till[npc.till.length - 1];
      if (last && !last.failed && last.act === 'sell' && last.names === names &&
          (npc.turns || 0) - (last.turn || 0) <= 1) {
        return refuse('You had already handed over ' + names + ' and been paid for it, ' +
                      'so nothing changed hands this time.',
                      d.name + ' had already sold you ' + names + ' — nothing changed hands.');
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
        /* The villager needs to actually hold the item now (unless it
           was a refund reversing a prior sale) — without this, a bought
           item would simply vanish from the game's state: the coin
           changed hands but the item itself didn't appear anywhere the
           villager could see, so they kept saying they had none. */
        else npc.stock[w.id] = (npc.stock[w.id] || 0) + 1;
      });
      give('coins', cost);
    }

    if (asking !== cost) log('¤ ' + d.name + ' said ' + asking + ', the going rate is ' + cost + '.');
    const dealKey = act === 'sell' ? 'buy' : refunding ? 'refund' : 'handOver';
    const ids = priced.map(w => w.id);
    txnLog('¤', dealKey, { items: itemsPhrase(ids, settings.lang), name: nameOrEmoji(npc), cost: cost },
                          { items: itemsPhrase(ids, 'en'), name: displayName(npc), cost: cost });

    /* What the villager's prompt sees (via the till) has to match what
       the game actually did — otherwise the model does its own
       arithmetic from an inconsistent memory and drifts (e.g. quoting
       six, being paid five, then claiming the player has three left). */
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

    /* Notes describing this deal are marked spent (struck through) in
       the notebook UI rather than removed — a note that vanishes reads
       as a bug and loses the record of who told the player. This
       function does nothing to the notes list directly; `factSpent`
       reads the completed trade state live and the notebook UI checks it.

       Separately, the villager's own facts about the deal are removed
       here (see `ofThisDeal` below) — a different question from
       `factSpent`. `factSpent` answers "is this true of the world,"
       which is what the *player's* notebook needs; this answers "did
       *this villager* personally just do this," which only this
       villager's own facts should reflect. Without this distinction, a
       villager could be told an item changed hands because someone else
       traded it, which isn't information they actually have. A
       villager's facts are dealt once at the start of the game and
       never automatically retired, so without this removal, a villager
       who traded away a teapot would keep stating "I have a teapot" and
       the terms for parting with it, even after handing it over. Only
       this villager's own copy of the fact is removed — anyone else who
       was told the same fact still believes it until someone tells them
       otherwise, same as nobody automatically learns an item is gone
       just because someone else took it. `remember` below (a plain
       memory entry, not a chain fact) is how that news can then spread
       through conversation. */
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
    /* Records both sides of the exchange in the till. A trade used to
       only record a memory like "the traveller brought me a bowl of
       rice," omitting what was given back — so the villager kept trying
       to complete an exchange that had already happened, and would
       repeat the "trade" action. */
    npc.till = npc.till || [];
    npc.till.push({ act: 'trade', names: gave, gaveBack: got, coins: 0, asked: 0,
                    at: LG.time.clock() });

    if ((plan.roles[npc.def.id] || {}).link === 0) win();
    renderHUD();
    // Save immediately -- losing chain progress to a closed tab before the next autosave isn't acceptable.
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

    LG.time.dayLength = Math.max(1, Number(settings.dayMinutes) || 6) * 60 * 1000;
    /* A previously-visited village resumes exactly where it was left; a
       new village is only generated on first-ever arrival. `resume`
       restores the local save immediately and checks the log server's
       copy asynchronously in the background, so a missing or slow server
       never blocks startup — same tradeoff adoptEnv makes below. */
    if (!LG.save.resume(log)) newVillage(null, true);

    LG.dialogue.init();
    wireUI();
    resize();
    window.addEventListener('resize', resize);

    if (settings.apiKey) { gated = false; LG.llm.probe(llmConfig()); }
    else { openSettings(true); }
    showChrome();
    loadVoices();
    requestAnimationFrame(loop);
    adoptEnv();
  }

  /* Fetches API keys from the log server's .env, if it's running.

     The settings panel normally requires the player to paste a key,
     since a plain web page can't read a local file. The log server can,
     though, so if it's running with a .env configured, this can populate
     the key automatically and skip that step. Called after startup
     rather than blocking on it, so a missing or slow server never delays
     the game -- the settings gate stays up regardless, and closes itself
     automatically if a key arrives. */
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
    if (env.provider === 'anthropic' || env.provider === 'openrouter') settings.provider = env.provider;
    const key = settings.provider === 'openrouter' ? env.openrouterKey : env.anthropicKey;
    let got = [];
    if (key) { settings.apiKey = key; got.push('the model key'); }
    if (env.ttsKey) { settings.ttsKey = env.ttsKey; settings.voices = true; got.push('a voice key'); }
    if (env.model) settings.model = env.model;
    if (env.helper) settings.helper = env.helper;
    if (env.lang && LG.LANGUAGES[env.lang]) settings.lang = env.lang;
    if (env.level && LG.LEVELS[env.level]) settings.level = env.level;
    if (!got.length && was.lang === settings.lang && was.level === settings.level) return;

    fromEnv = true;
    saveSettings();
    /* The village is generated from language + difficulty, so changing
       either normally means regenerating it -- fine, since nothing has
       happened yet in a fresh session. Except when a village was already
       resumed from a save: that's an in-progress playthrough, and .env
       settings arriving late shouldn't discard it. In that case, keep
       the resumed village's own language/difficulty instead. */
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

  /* Generates a fresh errand chain and resets all state that depends on it. */
  function newVillage(seed, quiet) {
    plan = LG.chain.generate({ level: settings.level, seed: seed || null });

    /* A new village rolls a fresh calendar too: a random day of the
       year, with whatever weather that day has. The hour of arrival is
       NOT randomized, though -- arriving at 3am in the dark with no one
       around is a poor way to start a game. */
    LG.time.start();

    state.inv = { coins: 10 };          // a little money to be going on with
    state.notes = []; state.deeds = []; state.won = false; state.board = [];

    /* The player arrives by train. The platform is at the far east end
       of the high street, so the walk into the village covers its full
       length -- arriving somewhere nobody is expecting them. */
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

    document.getElementById('seed').textContent = plan.seed;
    renderHUD();
    logLines.length = 0;
    log(quiet ? 'Use WASD or the arrow keys to walk. Press E next to someone to talk.'
              : 'A new village, in ' + LG.time.season().name.toLowerCase() +
                '. Nobody has told you anything yet.');
    /* Saved immediately rather than waiting for the next autosave, so
       closing the tab within the first ~20 seconds doesn't bring back
       the old village on reload. */
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
  }

  /* --------------------------------------------------------------- input */
  function wireUI() {
    window.addEventListener('keydown', e => {
      if (uiBlocked()) return;
      const dir = moveDir(e);
      if (dir) { held[dir] = true; if (e.code !== 'KeyW' && e.code !== 'KeyA' &&
                 e.code !== 'KeyS' && e.code !== 'KeyD') e.preventDefault(); }
      if (isInteract(e)) { e.preventDefault(); interact(); }
      if (isCancel(e)) closePanels();
    });
    window.addEventListener('keyup', e => {
      const dir = moveDir(e);
      if (dir) held[dir] = false;
    });
    window.addEventListener('blur', () => { for (const k in held) held[k] = false; });

    /* A sign's English gloss is click-to-reveal, same as a notebook
       note -- so any canvas click must first be tested against whatever
       signs are currently on screen, before being handled as anything
       else. */
    const toWorld = e => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) + cam.x, y: (e.clientY - r.top) + cam.y };
    };
    canvas.addEventListener('click', e => {
      if (uiBlocked()) return;
      const p = toWorld(e);
      W.hitSign(p.x, p.y);
    });
    canvas.addEventListener('mousemove', e => {
      const p = toWorld(e);
      canvas.style.cursor = (!uiBlocked() && W.overSign(p.x, p.y)) ? 'pointer' : 'default';
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
    document.getElementById('setNew').onclick = () => {
      document.getElementById('settings').classList.remove('open');
      newVillage();
    };
    document.getElementById('setTtsTest').onclick = testVoices;
    document.getElementById('setForget').onclick = () => {
      LG.save.forget();
      log('\u00a4 The saved village has been forgotten. This one goes on until you start another.');
      showSaveNote();
    };
    document.getElementById('setSave').onclick = submitSettings;
    document.getElementById('setProvider').onchange = () => { refreshModelList(); refreshHelperList(); };
    document.getElementById('setModel').onchange = syncModelBox;
    document.getElementById('setHelper').onchange = syncHelperBox;
  }

  /* Whether there's a real playthrough worth saving. Before the
     settings gate is passed, the village visible behind it is only a
     decorative backdrop for the title screen -- saving it would
     overwrite a real save with a village nobody has actually played. */
  function saving() { return !gated && !!plan; }

  function panelOpen() { return !!document.querySelector('.panel.open'); }
  function uiBlocked() { return gated || panelOpen() || LG.dialogue.isOpen(); }
  function closePanels() {
    if (gated) return;   // Escape does not close the front-door settings panel
    document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  }

  async function submitSettings() {
    const btn = document.getElementById('setSave');
    const err = document.getElementById('setError');
    const next = {
      lang: document.getElementById('setLang').value,
      level: document.getElementById('setLevel').value,
      provider: document.getElementById('setProvider').value,
      apiKey: document.getElementById('setKey').value.trim(),
      model: readModel() || settings.model,
      helper: readHelper(),
      showTranslation: document.getElementById('setTrans').checked,
      npcChatter: document.getElementById('setChatter').checked,
      voices: document.getElementById('setVoices').checked,
      ttsKey: document.getElementById('setTtsKey').value.trim(),
      voiceSpeed: document.getElementById('setSpeed').value,
      voiceQuality: document.getElementById('setQuality').value,
      dayMinutes: Number(document.getElementById('setDayLength').value) || 6
    };
    err.textContent = '';

    // Skip re-validating the key when the provider/key/model haven't changed.
    const stamp = next.provider + '|' + next.apiKey + '|' + next.model;
    if (stamp !== lastValidated) {
      btn.disabled = true;
      btn.textContent = 'Checking your key…';
      try {
        await LG.llm.validate({ provider: next.provider, apiKey: next.apiKey, model: next.model });
        lastValidated = stamp;
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
        btn.textContent = gateMode ? 'Enter the village' : 'Save';
        return;
      }
      btn.disabled = false;
    }

    const levelChanged = next.level !== settings.level;
    if (next.dayMinutes !== settings.dayMinutes) {
      LG.time.dayLength = Math.max(1, next.dayMinutes) * 60 * 1000;
    }
    const voiceChanged = next.voices !== settings.voices || next.ttsKey !== settings.ttsKey
                      || next.voiceQuality !== settings.voiceQuality;
    Object.assign(settings, next);
    saveSettings();
    // Structured-output support depends on the provider/model pair -- re-probe on any settings change.
    LG.llm.probe(llmConfig());
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

    if (voiceChanged) { LG.tts.stop(); loadVoices(); }

    if (gateMode) {
      gated = false;
      gateMode = false;
      showChrome();
      /* Passing through the front door used to always roll a new
         village -- correct on a first visit, but wrong when resuming a
         save: the player would return to their saved village, type in
         their key, and watch it get replaced. A changed difficulty is a
         genuinely different village, so that still rolls a new one. */
      if (LG.save.resumed && !levelChanged) LG.save.write();
      else newVillage(null, true);
      document.getElementById('help').classList.add('open');
    } else if (levelChanged) {
      log('A different sort of errand, then.');
      newVillage();
    } else {
      log('The villagers now speak ' + LG.LANGUAGES[settings.lang].name + '.');
    }
  }

  /* Tests the ElevenLabs key without leaving the settings panel, and
     shows the specific error returned -- a 401 from ElevenLabs indicates
     which of key/permission/key-type was the problem. */
  async function testVoices() {
    const box = document.getElementById('ttsResult');
    const btn = document.getElementById('setTtsTest');
    const key = document.getElementById('setTtsKey').value.trim();
    if (!key) { box.className = 'bad'; box.textContent = 'Paste a key first.'; return; }
    btn.disabled = true; btn.textContent = 'Asking ElevenLabs…';
    box.className = ''; box.textContent = '';
    const ok = await LG.tts.load({ key });
    btn.disabled = false; btn.textContent = 'Test this key';
    box.className = ok ? 'good' : 'bad';
    box.textContent = '';
    const head = document.createElement('div');
    head.textContent = LG.tts.error;
    box.appendChild(head);
    if (!ok) return;

    LG.NPCS.forEach(n => {
      const id = LG.tts.voices[n.id];
      const v = id && LG.tts.info(id);
      const row = document.createElement('div');
      row.className = 'castrow';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'replay';
      play.textContent = '▶';
      play.title = 'Hear this voice';
      play.disabled = !(v && (v.preview_url || v.previewUrl));
      play.onclick = () => LG.tts.preview(id);
      row.appendChild(play);
      const who = document.createElement('span');
      who.innerHTML = '<b>' + n.name + '</b> — ' +
        escapeHTML((v && v.name) || id || 'no voice') +
        (v && v.category ? ' <i>(' + escapeHTML(v.category) + ')</i>' : '');
      row.appendChild(who);
      box.appendChild(row);
    });
  }

  /* Casting villager voices takes one API request -- done here, while
     the player is likely reading the help panel, rather than waiting
     until they first talk to a villager. */
  function loadVoices() {
    if (!settings.voices || !settings.ttsKey) return;
    LG.tts.load(ttsConfig()).then(ok => {
      if (ok) log('🔊 The villagers have found their voices.');
      else log('🔊 No voices: ' + LG.tts.error);
    });
  }

  /* Hides the HUD while gated -- it's just visual noise behind the title screen. */
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
    document.getElementById('setProvider').value = settings.provider;
    document.getElementById('setKey').value = settings.apiKey;
    // Shows where the key came from, so a pre-filled field isn't a mystery to the player.
    const note = document.getElementById('setKeyNote');
    if (note) {
      note.textContent = fromEnv ? 'filled from .env — type over it to change it for this session' : '';
      note.style.display = fromEnv ? '' : 'none';
    }
    document.getElementById('setTrans').checked = settings.showTranslation;
    document.getElementById('setChatter').checked = settings.npcChatter;
    document.getElementById('setVoices').checked = settings.voices;
    document.getElementById('setTtsKey').value = settings.ttsKey;
    document.getElementById('setSpeed').value = settings.voiceSpeed;
    document.getElementById('setQuality').value = settings.voiceQuality;
    document.getElementById('setDayLength').value = String(settings.dayMinutes || 6);
    refreshModelList();
    refreshHelperList();
    showSaveNote();
    s.classList.add('open');
  }

  /* Displays the current save status in one line. Autosaving is
     silent by design (a message every 20 seconds would be noisy) --
     this is the only place that tells the player their progress is
     being saved, and where. */
  function showSaveNote() {
    const note = document.getElementById('setSaveNote');
    const btn = document.getElementById('setForget');
    if (!note || !btn) return;
    const have = LG.save.has();
    btn.disabled = !have;
    if (!have) { note.textContent = 'Nothing saved yet — the village is written down every few seconds once you are in it.'; return; }
    const when = LG.save.lastAt
      ? 'last written ' + new Date(LG.save.lastAt).toLocaleTimeString()
      : 'kept from an earlier session';
    note.textContent = 'This village is saved in this browser (' + when +
      ')' + (LG.save.onServer ? ' and in saves/village.json' : '') + '.';
  }

  /* "Other" reveals a free-text box, so a model newer than this
     picker's hardcoded list can still be used without editing the
     source. */
  function readModel() {
    const sel = document.getElementById('setModel');
    if (sel.value !== 'other') return sel.value;
    return document.getElementById('setModelCustom').value.trim();
  }

  function readHelper() {
    const sel = document.getElementById('setHelper');
    if (sel.value !== 'other') return sel.value;
    return document.getElementById('setHelperCustom').value.trim();
  }

  function refreshHelperList() {
    const prov = document.getElementById('setProvider').value;
    const sel = document.getElementById('setHelper');
    const list = LG.llm.HELPERS[prov] || [];
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + '<option value="other">Other — type an id below</option>';
    const known = list.some(m => m.id === settings.helper);
    sel.value = settings.helper && !known ? 'other' : (settings.helper || (list[0] && list[0].id) || 'other');
    document.getElementById('setHelperCustom').value = known ? '' : settings.helper;
    syncHelperBox();
  }

  function syncHelperBox() {
    const other = document.getElementById('setHelper').value === 'other';
    document.getElementById('setHelperCustom').style.display = other ? '' : 'none';
  }

  function refreshModelList() {
    const prov = document.getElementById('setProvider').value;
    const sel = document.getElementById('setModel');
    const list = LG.llm.MODELS[prov] || [];
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + '<option value="other">Other — type an id below</option>';
    const known = list.some(m => m.id === settings.model);
    sel.value = settings.model && !known ? 'other' : (settings.model || (list[0] && list[0].id) || 'other');
    document.getElementById('setModelCustom').value = known ? '' : settings.model;
    syncModelBox();
    document.getElementById('keyHint').textContent = prov === 'anthropic'
      ? 'From console.anthropic.com. Sent straight from your browser to api.anthropic.com.'
      : 'From openrouter.ai/keys.';
  }

  function syncModelBox() {
    const other = document.getElementById('setModel').value === 'other';
    document.getElementById('setModelCustom').style.display = other ? '' : 'none';
  }

  function interact() {
    if (nearby) { LG.dialogue.open(nearby); return; }
    if (beast && !beast.caught && dist(player, beast) < TILE * 1.4) catchBeast();
    else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.4) pickUp();
    else if (nearBoard()) openBoard();
  }

  /* Whether the terminal (chain-ending) item has been collected --
     tracked as a one-way, once-ever flag. Trading it away afterward
     doesn't put it back where it was lying. */
  function haveTerminal() {
    return !!((worldItem && worldItem.taken) || (beast && beast.caught));
  }

  /* Has this fact already been resolved by the world state?

     Previously this check was implemented three separate times, each
     covering only one case: `learn` had its own logic that only knew
     about the world-item location fact; `doTrade` had inline logic that
     only knew about its own link and just deleted the note; picking up
     the terminal item had a third, separate flag. As a result, a
     villager could state a want that had already been fulfilled (e.g.
     the goal item already delivered) and it would still show in the
     notebook as an active lead, since whichever completion path had
     actually happened wasn't checked by the note-writing code.

     Now there's one function used everywhere, reading from two sources
     that are both guaranteed one-way: `haveTerminal` is explicitly
     once-ever, and a completed trade (`tradeDone`) never reverts. That
     one-wayness is what makes this check safe to rely on globally. */
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

  /* The noticeboard has no NPC/actor to measure distance from -- just a
     ground rectangle, the same one villagers are sent to. */
  function nearBoard() { return nearRect(player, LG.BOARD_SPOT, 1); }

  /* Reuses world.js's rectangle-proximity check. */
  const nearRect = W.nearRect;

  /* Adds a memory entry for `npc`.

     This is the only entry point for anything a villager comes to
     believe, so every memory carries the same two fields: when it was
     learned (`at`) and who told them (`from`, null for something they
     witnessed themselves). No memory is inherently more authoritative
     than another -- a chain fact dealt at game start and a rumor picked
     up on the green are structurally the same kind of entry, only
     distinguished by recency and source.

     Memories used to be stored as bare strings, with no way to compare
     two of them. A villager could end up holding two contradictory bare
     strings (e.g. "X is looking for shoes" and "X received shoes") with
     no way to determine which was more current -- they could only notice
     the contradiction, not resolve it. Dating and sourcing every entry
     fixes that.

     Note: below (noticeItemGone) covers the one fact in the errand that
     can become false during play -- an item lying in the world getting
     picked up. Since chain facts are only dealt once, at game start,
     without that separate handling a villager could keep directing
     people to an item's location long after it's gone. Walking there
     and finding nothing is what corrects that (see noticeItemGone). */
  function remember(npc, text, from) {
    if (!text || typeof text !== 'string' || text.length < 3) return false;
    npc.memory = npc.memory || [];
    if (npc.memory.some(m => (m && m.text) === text)) return false;
    npc.memory.push({ at: LG.time.clock(), text: text, from: from || null });
    if (npc.memory.length > 24) npc.memory.shift();
    return true;
  }

  /* Records when/from-whom a chain fact was learned, same as `remember`
     does for memories. Facts dealt at game start are left unstamped,
     which is what makes them read as something the villager has simply
     always known. */
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
    /* States only what the villager directly observed. An earlier
       version said "somebody has had it away" -- implying a theft they
       didn't actually witness, which would then get repeated as
       established fact. This version only states that they looked and
       found nothing; any interpretation of that is left to the model. */
    const t = plan.terminal;
    const line = t.isBeast
      ? 'You went ' + t.placeText + ' yourself and ' + t.beastName + ' was not there.'
      : 'You went ' + t.placeText + ' yourself and there was no ' +
        LG.ITEMS[t.item].en + ' there.';
    remember(n, line);                       // seen with their own eyes: no source to name
    think(n, 'finds nothing there', t.placeText);
  }
  /* Trading hours and counter-proximity checks now live in LG.view,
     alongside everything else a villager can observe about their own
     state. */

  /* Resolves what price (if any) this villager would sell/buy `id` at
     -- checks their explicit wares list first, then their general trade
     category tags. Returns 0 if they wouldn't deal in it at all. */
  function priceFrom(list, tags, id, factor) {
    const ware = (list || []).find(w => w.i === id);
    if (ware) return ware.p;
    const it = LG.ITEMS[id];
    if (it && tags && tags.some(t => (it.tags || []).indexOf(t) !== -1)) {
      return Math.max(1, Math.round(LG.priceOf(id) * (factor || 1)));
    }
    return 0;
  }

  /* Where a villager goes is a decision made by the helper model from
     their own goal and memory, not a dice roll -- this function just
     supplies the options and records their choice. So e.g. the baker
     opens the bakery because she's the baker, and a villager looking for
     a saw walks toward wherever she last heard one was. */
  const DECIDE_COOL = 25;

  /* Logs each villager decision with its stated reason to the console.
     Without this, there was no way to tell from the outside whether a
     villager's movement decision was reasoned or effectively random.
     Tagged in the villager's own color so a busy village stays readable.
     `LG.game.thoughts = false` disables this. */
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
  /* Builds the list of everywhere a villager could plausibly walk to,
     including toward other villagers they can see.

     A villager knowing that someone holds an item they want is only
     actionable if there's a way to go find that person -- without
     visible villagers being included as destinations, a model reasoned
     that a target's home "isn't a listed place I can go" and simply
     stood on the green hoping they'd show up instead. So anyone
     currently visible is also a valid destination. */
  function placesFor(n) {
    const out = [{ name: 'home', rect: n.def.home, note: 'your own place' }];
    if (n.work) {
      // Uses the actual building name as the option label -- a
      // literal "your work" option caused villagers to reason aloud
      // about what and where "your work" was, rather than recognizing it.
      const label = n.workBuilding ? n.workBuilding.label : (n.def.job || 'your work');
      out.push({ name: label, rect: n.work, note: 'where you work' });
    }
    out.push({ name: 'the village green', rect: LG.GREEN, note: 'where people gather' });
    out.push({ name: 'the noticeboard', rect: LG.BOARD_SPOT,
               note: 'where anyone may pin up a note for the village to read' });
    /* Only these two far-off destinations are offered, not every
       glade in the forest -- offering all six clearings to every
       villager would spread them too thin to ever find, and a location
       nobody can be reliably found at is one an errand can silently
       fail at. One entry point into the woods and one exit from the
       village is enough for either to plausibly be where someone is. */
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
    return out;
  }

  /* Returns a small area beside `o` so "go find them" walks the player
     next to that villager, not exactly onto their own tile. */
  function besideThem(o) {
    return { x: Math.max(0, o.tx - 2), y: Math.max(0, o.ty - 2), w: 5, h: 5 };
  }

  function decideWhereToGo(n, green) {
    const opts = placesFor(n);
    const done = () => { n.deciding = false; n.decideCool = DECIDE_COOL; };
    if (n.decideCool > 0) { n.deciding = false; return false; }   // rate limit -- decided too recently
    think(n, 'wonders where to be', LG.view.where(n) + ', ' + LG.time.phase().name);
    /* Uses the same LG.view assembly the player-facing prompt uses, so
       the villager deciding where to walk is reasoning from the same
       state the player will actually meet when they arrive. Passing
       `held` (their full known-facts list) here used to be missing --
       without it, a villager could be told rice was for sale nearby and
       have no way to act on that knowledge when deciding where to walk,
       since "what they know" and "what they decide" were reading from
       different, disconnected data. */
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
      /* Matches the model's chosen destination string leniently.
         Giving the model the exact valid strings reduces mismatches but
         doesn't eliminate them -- "village green" vs "the village green"
         shouldn't leave a villager stuck with no destination. */
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
      n.wantsGo = want.rect;
      n.why = res.why || '';
      // A "go after X" decision means any resulting conversation with X wasn't a chance encounter.
      n.wentAfter = want.after || null;
      think(n, '\u2192 ' + want.name, n.why);
    }).catch(() => { done(); think(n, 'could not decide', 'the call failed'); });
    return true;
  }

  /* Whether the player is close enough to overhear this conversation
     -- only affects whether it's logged; the conversation itself happens
     regardless. */
  function canOverhear(a, b) {
    return dist(player, a) < TILE * 11 || dist(player, b) < TILE * 11;
  }

  /* Starts a conversation between two villagers who've met. Nothing
     about what will be said is pre-decided -- each has their own goal,
     memory, and current weather/situation, and what they each take away
     is determined afterward.

     Both villagers' state is snapshotted once here (via LG.view.of),
     rather than re-read live on every turn of the conversation. A
     conversation reflects the two people as they were when it started;
     re-reading live state partway through would let their state change
     out from under an already-running exchange. */
  function villagerTalk(a, b) {
    if (!settings.apiKey) return false;
    const va = LG.view.of(a, 'chat'), vb = LG.view.of(b, 'chat');
    /* Whether either villager came looking for the other, resolved
       once here (and cleared via LG.view.arrived) rather than read live
       from a flag. The flag used to be set when a villager set off and
       never cleared, so a villager who'd once deliberately sought out
       another would keep greeting them with "I came looking for you" on
       every subsequent, unrelated encounter that day. */
    va.sought = va.errand.after === vb.id;
    vb.sought = vb.errand.after === va.id;
    LG.view.arrived(a); LG.view.arrived(b);
    LG.dialogue.overheard(a, b, { a: va, b: vb });
    return true;
  }

  /* ------------------------------------------------------------- the board
     A villager who chose to walk to the noticeboard (see `placesFor`)
     may post something there -- what, if anything, isn't decided in
     advance; it doesn't have to relate to their own errand at all.
     Declining to post is a valid, expected outcome (same latitude
     "remember" has in a player conversation), and this isn't even called
     on every arrival -- only when the villager hasn't posted recently. */
  const BOARD_MAX = 6;
  function maybePostNotice(n) {
    if (!settings.apiKey || !settings.npcChatter) return;
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

    // Self-reported "revealed" facts are verified against the actual
    // notice text, same as a villager's own self-reported reveals in
    // dialogue -- a model will flag a fact just for using a related word,
    // not only for actually stating it.
    const claimed = Array.isArray(res.revealed)
      ? res.revealed.map(id => String(id).replace(/[^\w]/g, ''))
                     .filter(id => plan.facts[id] && n.facts.indexOf(id) !== -1)
      : [];
    if (!claimed.length) return;
    const candidates = claimed.map(id => ({ id, text: plan.facts[id].text }));
    const L = LG.LANGUAGES[settings.lang];
    LG.llm.judge(llmConfig(), text, entry.translation, candidates, { langName: L.name })
      .then(confirmed => { confirmed.forEach(c => entry.factIds.push(c.id)); })
      .catch(() => {});
  }

  /* Called when the player opens the noticeboard. Facts from confirmed
     notices are added to the notebook here, at read time -- not when
     they were originally posted, since a notice only reaches the
     player's notebook once they've actually gone and read it, matching
     how spoken facts work. `learn` is passed no source villager here: a
     pinned notice is a fixed, standalone artifact, true independent of
     whether its writer would still personally affirm it. */
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
      const hide = settings.showTranslation ? '' : ' hidden-tr';
      // A notice always shows the poster's real name, unlike a nametag
      // or spoken dialogue -- it's a public, written document, and a
      // noticeboard that couldn't identify its own postings would defeat the point.
      const who = entry.name;
      return '<div class="notice"><span class="who">' + escapeHTML(who) + '</span>' +
             '<span class="heard" lang="' + L.tag + '">' + escapeHTML(entry.text) + '</span>' +
             (entry.roman && L.romanize ? '<span class="roman" lang="' + L.romanTag + '">' +
               escapeHTML(entry.roman) + '</span>' : '') +
             (entry.translation ? '<span class="gloss' + hide + '" lang="en" title="click to read">' +
               escapeHTML(entry.translation) + '</span>' : '') +
             '</div>';
    });
    box.innerHTML = rows.length ? rows.join('')
      : '<div class="notice muted">Nothing pinned up yet.</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  /* ---------------------------------------------------------------- loop */
  function movePlayer(dt) {
    if (uiBlocked()) return;
    let dx = 0, dy = 0;
    if (held.left) dx -= 1;
    if (held.right) dx += 1;
    if (held.up) dy -= 1;
    if (held.down) dy += 1;
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy) || 1;
    const speed = 132;
    const nx = player.px + (dx / len) * speed * dt;
    const ny = player.py + (dy / len) * speed * dt;
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

  function update(dt) {
    if (saving()) LG.save.tick(dt);
    if (LG.time.tick(dt)) log('🗓 ' + LG.time.season().name + ', day ' + LG.time.dayOfSeason() + '.');
    const el = document.getElementById('clock');
    if (el) el.textContent = LG.time.label();

    movePlayer(dt);

    for (const n of npcs) {
      const walking = !!(n.route && n.route.length);
      A.routine(n, dt, LG.GREEN, settings.apiKey && settings.npcChatter ? decideWhereToGo : null);
      if (n.wasWalking && !walking) {
        think(n, 'arrives', LG.view.where(n) + (n.why ? ' — ' + n.why : ''));
        if (n.patch === LG.BOARD_SPOT) maybePostNotice(n);
      }
      n.wasWalking = walking;
      A.walk(n, dt, 34);
      noticeItemGone(n);
      if (n.bubbleT > 0) n.bubbleT -= dt;
      if (n.boardCool > 0) n.boardCool -= dt;
    }
    if (settings.npcChatter) {
      LG.dialogue.chatTick(dt);
      A.meet(npcs, dt, log, LG.dialogue.chatterLine, villagerTalk);
    }

    if (beast) {
      if (beast.following) {
        if (dist(player, beast) > TILE * 1.1) {
          beast.tx = player.tx; beast.ty = player.ty;
          A.stepTowards(beast, 118, dt);
        }
      } else {
        A.wander(beast, dt, beast.home, 26);
        if (!beast.caught && !uiBlocked() && dist(player, beast) < TILE * 0.8) catchBeast();
      }
    }
    if (worldItem && !worldItem.taken && !uiBlocked() && dist(player, worldItem) < TILE * 0.7) pickUp();

    nearby = null;
    let best = TILE * 1.6;
    for (const n of npcs) {
      const d = dist(player, n);
      if (d < best) { best = d; nearby = n; }
    }

    const hint = document.getElementById('hint');
    if (uiBlocked()) {
      hint.classList.remove('show');
    } else if (nearby) {
      hint.textContent = 'Press E to talk to ' + displayName(nearby);
      hint.classList.add('show');
    } else if (beast && !beast.caught && dist(player, beast) < TILE * 1.8) {
      hint.textContent = 'Press E to pick up ' + beast.name;
      hint.classList.add('show');
    } else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.8) {
      hint.textContent = 'Press E to pick it up';
      hint.classList.add('show');
    } else if (nearBoard()) {
      hint.textContent = 'Press E to read the noticeboard';
      hint.classList.add('show');
    } else {
      hint.classList.remove('show');
    }

    cam.x = clamp(player.px - vw / 2, 0, W.W * TILE - vw);
    cam.y = clamp(player.py - vh / 2, 0, W.H * TILE - vh);
    if (W.W * TILE < vw) cam.x = (W.W * TILE - vw) / 2;
    if (W.H * TILE < vh) cam.y = (W.H * TILE - vh) / 2;
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

  function draw() {
    ctx.fillStyle = '#3f6b3a';
    ctx.fillRect(0, 0, vw, vh);
    ctx.save();
    /* Camera offset is rounded to whole *device* pixels, not CSS
       pixels -- the canvas is scaled by dpr, so at a fractional dpr
       (125%/150% display scaling is common), an offset that's only a
       whole CSS pixel can still land a tile edge on a fractional device
       pixel. That gives adjacent ground tiles each their own antialiased
       edge instead of sharing one crisp seam, visible as a faint lattice
       of lines over the terrain. */
    ctx.translate(-Math.round(cam.x * dpr) / dpr, -Math.round(cam.y * dpr) / dpr);

    const room = W.buildingUnder(player);

    W.drawGround(ctx, cam, vw, vh);
    W.drawBuildings(ctx, room, cam, vw, vh);
    W.drawSigns(ctx, cam, vw, vh, settings.lang, settings.showTranslation);
    drawWorldItem();

    /* A villager inside a building the player isn't in is not drawn --
       the player can see into whatever room they're standing in (that's
       what the roof-lifting effect is for), but not through another
       building's walls, so e.g. the baker at her oven is genuinely
       unreachable-looking until the player actually goes inside. */
    const drawables = npcs.filter(a => {
      const r = W.buildingUnder(a);
      return !r || r === room;
    });
    if (beast) { const r = W.buildingUnder(beast); if (!r || r === room) drawables.push(beast); }
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
    LG.sky.draw(ctx, vw, vh, W.roofRects(cam, vw, vh, dpr));

    const g = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.42,
                                       vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(20,14,8,.30)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
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
           _moveDir: moveDir, _isInteract: isInteract,
           canOverhear, logSpeech, think,
           factText: id => (plan && plan.facts[id]) ? plan.facts[id].text : null,
           set thoughts(v) { thoughts = !!v; },
           get thoughts() { return thoughts; },
           _debugPlayerAt: (x, y) => { player.px = x; player.py = y; },
           // one turn of the world by hand, for poking at it from the console
           // (and for tests, which cannot rely on requestAnimationFrame)
           _debugTick: dt => update(dt || 1 / 60),
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
