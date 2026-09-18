/* game.js — core game state, main loop, input handling, notebook, and settings. */
window.LG = window.LG || {};

LG.game = (function () {
  const W = LG.world, A = LG.actors, TILE = 32;

  const settings = {
    lang: 'ru', level: 'beginner', autorun: false,
    provider: 'openrouter', apiKey: '', model: 'deepseek/deepseek-v4.1-flash', helper: '',
    // Only ever true under provider 'openrouter' -- see refreshJevRow.
    jevMovement: false,
    /* One key per provider, so switching provider and back doesn't lose
       the other one. `apiKey` is always the current provider's entry. */
    keys: { openrouter: '', logfare: '' },
    /* These four are no longer exposed as player-facing settings —
       villager gossip is always on, translations always start blurred
       (click to reveal), voices are always cast from the curated
       library, and speech speed always matches difficulty. Kept as
       fields since other code still reads settings.npcChatter etc.;
       loadSettings() below force-resets them on load so an old
       localStorage save with different values can't reintroduce the
       removed choice. */
    showTranslation: false, npcChatter: true,
    voices: false, ttsKey: '', voiceSpeed: 'auto', voiceQuality: 'curated'
  };

  // `gated` blocks input until settings (incl. API key) are confirmed via the front-door panel.
  let gated = true, gateMode = false, lastValidated = '';
  let fromEnv = false;             // true if keys came from the log server's .env, not typed by the user
  // The settings panel's unsaved key per provider, and which provider the key box is showing right now.
  let draftKeys = {}, keyProvider = '';

  const state = { inv: {}, notes: [], deeds: [], won: false, board: [] };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0, dpr = 1;
  /* The vignette gradient only depends on vw/vh, which only change on
     resize — cached here and rebuilt in resize(), instead of calling
     createRadialGradient() every frame. */
  let vignette = null;

  /* Caches the ground/buildings/signs layer to its own offscreen canvas
     and reuses it (a plain blit) instead of redrawing every frame — it
     only visually changes when the camera moves, the player enters/exits
     a roofed area, snow accumulation changes, or the display language
     changes. Everything else in a frame (character animation, weather,
     the vignette) still redraws every tick; only this layer is cached,
     and only invalidated when one of those specific things changes. */
  let groundCanvas = null, groundCtx = null;
  const groundSeen = { camX: NaN, camY: NaN, roomX: NaN, roomY: NaN, snow: -1, lang: '', trans: false };
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
  /* Three ways to trigger running, all read from `running()`: holding
     Shift (tracked per-frame via `held.run`, released the instant the
     key is), a touch gesture (double-tap the ground and hold the second
     finger down — implemented entirely in LG.touch, which already
     tracks every active finger, and polled via `runHeld`), or the
     `autorun` setting, which bypasses the gesture requirement entirely
     rather than replacing it — Shift and double-tap-hold both still
     work independently even with autorun on. A phone has no way to hold
     a key without the same thumb that's steering the joystick covering
     it, which is why touch needs its own separate gesture. */
  function running() { return settings.autorun || held.run || LG.touch.runHeld; }
  /* Shared "close enough" distance, consolidated from three call sites
     that each independently hardcoded TILE * 1.6 (one with a comment
     claiming it matched the other two): the hint/E-key interaction
     range, how close a chasing villager stops, and the tap-to-talk range. */
  const REACH = TILE * 1.6;
  let last = 0, nearby = null;
  /* Holds a hint message the player specifically triggered (e.g. via a
     tap), so it persists past the current frame — the hint is otherwise
     recomputed from scratch every tick, which would erase a tap response
     before it could be read. */
  let nudge = '', nudgeT = 0;
  const logLines = [];

  /* ------------------------------------------------------------ settings */
  function loadSettings() {
    try {
      const raw = localStorage.getItem('lg-settings');
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    /* The Anthropic provider is gone. A save still pointing at it holds
       an Anthropic key and Claude model ids, neither of which means
       anything to OpenRouter -- drop them rather than send that key
       somewhere it was never meant for. */
    if (!LG.llm.MODELS[settings.provider]) {
      settings.provider = 'openrouter';
      settings.apiKey = '';
      settings.model = LG.llm.MODELS.openrouter[0].id;
      settings.helper = '';
    }
    // Keys used to be one field shared by every provider; file an old one under the provider it was saved with.
    settings.keys = Object.assign({ openrouter: '', logfare: '' }, settings.keys);
    if (settings.apiKey && !settings.keys[settings.provider]) settings.keys[settings.provider] = settings.apiKey;
    settings.apiKey = settings.keys[settings.provider] || '';
    // No longer configurable -- force these even if an old save has different values stored.
    settings.npcChatter = true;
    settings.showTranslation = false;
    settings.voiceQuality = 'curated';
    settings.voiceSpeed = 'auto';
  }
  function saveSettings() {
    try { localStorage.setItem('lg-settings', JSON.stringify(settings)); } catch (e) {}
  }
  function ttsConfig() {
    // Talking speed is always derived from difficulty, not separately configurable.
    const speed = (LG.LEVELS[settings.level] || {}).speed || 0.85;
    return { key: settings.ttsKey.trim(), speed: speed,
             lang: settings.lang, curatedOnly: settings.voiceQuality === 'curated' };
  }
  function llmConfig() {
    return { provider: settings.provider, apiKey: settings.apiKey.trim(),
             model: settings.model, helper: settings.helper,
             jevMovement: settings.jevMovement };
  }

  /* ---------------------------------------------------------- inventory */
  function count(id) { return state.inv[id] || 0; }
  function give(id, n) { state.inv[id] = (state.inv[id] || 0) + (n || 1); renderHUD(); }
  function take(id, n) {
    state.inv[id] = Math.max(0, (state.inv[id] || 0) - (n || 1));
    if (!state.inv[id]) delete state.inv[id];
    renderHUD();
  }
  /* `exclude` omits one item from the list entirely -- used for a
     caught animal following the player, which isn't really "in a
     pocket" and is described separately (see LG.view.companion). */
  function inventoryList(exclude) {
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0 && k !== exclude);
    if (!ks.length) return '';
    // Used only in the villager's prompt, so names items the way the rest of that prompt does -- see LG.itemSaid.
    return ks.map(k => LG.itemSaid(k, settings.lang, true) +
                       (state.inv[k] > 1 ? ' x' + state.inv[k] : '')).join(', ');
  }
  function itemLabel(id) { return LG.itemName(id, settings.lang); }

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
     reports are recorded here (see `learn` below).

     Not every learnable fact belongs here, though: `opinion` facts (the
     gossip chain.js generates so villagers have something to talk
     about) are real, checkable, learnable facts just like errand facts,
     but they aren't part of the errand. Including them would turn the
     one page meant to say "what to do next" into something the player
     has to sift through for the facts that actually matter. */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (plan.facts[factId].type === 'opinion') return;   // gossip, not the errand
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
      : '<div class="q muted">Nothing yet. Try asking around!</div>';
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
    trackViewport();

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

    /* Petra always greets a new arrival at the platform. This is scripted
       rather than left to the model (contrast with the ordinary
       "go find the player" behavior in placesFor/followPlayer) — she
       starts in the already-decided "following the player" state
       instead of arriving at it by an intent decision, since a village
       character established as knowing everyone's business would
       plausibly always meet a stranger immediately. */
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
    readInsets();       // a phone that turned has swapped notch for home bar

    vignette = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.42,
                                         vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(20,14,8,.30)');

    if (!groundCanvas) groundCanvas = document.createElement('canvas');
    groundCanvas.width = vw * dpr; groundCanvas.height = vh * dpr;
    groundCtx = groundCanvas.getContext('2d');
    groundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    groundCtx.imageSmoothingEnabled = false;
    groundSeen.camX = NaN;               // a resized canvas has nothing painted on it yet
  }

  /* ------------------------------------------------- what you can see of it
     The canvas is fixed to the page and always fills it, but on a phone
     the visible screen isn't necessarily the same size as the canvas.
     Two things reduce the actually-visible area:

       - The browser's visible window can be shorter than the page
         whenever the browser toolbar is showing, and it can scroll
         within that page. Opening the keyboard scrolls it down;
         closing the keyboard doesn't reliably scroll back up. The
         result is a visible strip missing part of the village off the
         top of the screen.
       - viewport-fit=cover requests the full screen, and on Android's
         edge-to-edge Chrome that includes the area under the nav
         buttons — so the edge of the canvas gets painted underneath
         them. env(safe-area-inset-*), read via #safe in the page, gives
         the size of that hidden margin.

     Drawing under both of these is intentional -- the village should
     fill the full screen, under the notch and behind the nav buttons.
     But *framing the camera* around both is wrong: the camera centers
     the player within the canvas, so near the bottom edge of the map
     (where the camera itself can't scroll further), the player and the
     bottom row of the village would end up hidden behind the nav
     buttons with no way to see them. So the camera instead centers on
     the actually-visible band, and the map's edges are clamped against
     that band rather than the canvas edges. On desktop, where the
     visible band equals the full canvas, this has no effect.

     The visible band stops updating while a keyboard is open -- the
     strip of screen above the keyboard shouldn't become the new camera
     frame for the ten seconds a dialogue is open -- and while the page
     is pinch-zoomed, since the camera re-centering under a zoomed,
     panned finger would itself be a bug. */
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

  /* Returns the currently-visible band, in canvas pixels. Any
     nonsensical measurement (e.g. taken before the first frame, or a
     window somehow taller than its own page) falls back to the full
     canvas -- the same result every browser without visualViewport
     support gets by default. */
  function seen() {
    let top = Math.max(0, seenTop, insets.top);
    let bottom = Math.min(vh, seenBottom, vh - insets.bottom);
    let left = Math.max(0, insets.left), right = Math.min(vw, vw - insets.right);
    if (!(bottom - top > 1)) { top = 0; bottom = vh; }
    if (!(right - left > 1)) { left = 0; right = vw; }
    return { top: top, bottom: bottom, left: left, right: right };
  }

  /* A phone's on-screen keyboard doesn't shrink the page -- it overlays
     a smaller visible window on top of it -- so a dialogue card sized to
     the full page would end up half-hidden behind the keyboard, with
     the text input itself out of view. `visualViewport` reports the
     actually-visible area; the overlays and HUD are laid out to that,
     while the canvas keeps filling the whole screen (scrolling the
     village up on every keyboard-open would be worse than the problem
     it solves -- see the camera handling above, which uses the same
     measurement differently).

     Two CSS classes (CRAMPED/TIGHT below) are derived from this same
     height measurement, not from which element has focus -- deriving
     layout from focus seemed natural but is wrong: tapping "Say it"
     removes focus from the input while the keyboard stays open, and a
     focus-based layout would spring back to its full-size layout in
     space that hadn't actually grown, pushing the composer off-screen.
     Height is what actually determines available space, so height is
     what drives the CSS classes.

     Browsers disagree on how they report this -- some shrink the page
     itself under an open keyboard, others just overlay a smaller
     visible window -- so both a fallback and multiple event listeners
     exist to handle whichever behavior a given browser has. */
  const CRAMPED = 460;             // below this height, trays lose their full size
  const TIGHT = 320;               // below this height, trays are hidden entirely

  /* Approximately one row of on-screen keyboard keys. A window
     size change smaller than this is treated as UI on top of the
     keyboard (e.g. a suggestion strip), not the keyboard itself opening
     or closing. */
  const KB_ROW = 96;
  /* How long an increase in visible height (short of the keyboard fully
     closing) must persist before it's trusted as real. A full
     predictive-text suggestion-strip cycle (word committed, strip
     disappears, next word starts, strip reappears) completes well
     within this window, so ordinary typing never triggers a false
     recovery. What this delay is actually guarding against is the
     keyboard's own opening animation: visualViewport is documented to
     report transient in-flight values during that animation, which can
     overshoot past the keyboard's final resting height before settling
     back to it. Without this delay, a card that latched onto one of
     those transient readings would be stuck slightly too short for the
     rest of the conversation -- short by whatever the overshoot was. */
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

  /* An IME keyboard doesn't have one fixed height. A Japanese flick
     keyboard's suggestion strip appears whenever there's something to
     suggest and disappears on committing a word, each toggle firing a
     one-row-tall visualViewport resize -- so a card pinned to the
     bottom of the visible window would otherwise hop up and down with
     every keystroke, right under the text being read. Chinese/Korean
     input methods and English autocorrect bars behave the same way.

     So the overlay height follows the window shrinking, but not
     immediately when it grows back: while the keyboard is open and a
     text input has focus, a height increase smaller than one keyboard
     row is assumed to be the suggestion strip toggling, and ignored.
     The card stays sized to the shortest (tallest-keyboard) state seen,
     costing one strip-row of space at the bottom in exchange for a card
     that doesn't visibly jump while typing.

     Focus is used only to detect "still typing" here -- it never
     triggers growing the layout. Losing focus (e.g. tapping "Say it",
     which on some phones blurs the input while the keyboard stays open)
     reverts to the real current measurement, which is still the short
     one, so the composer still can't be pushed off-screen the way it
     was under the old focus-based layout logic.

     This height-holding behavior only applies on touch: a desktop
     window resized while typing in the settings panel should update
     immediately.

     A height increase that isn't the strip toggling -- taller than the
     currently-held value, but still well short of fullH -- is treated
     with the same caution: not trusted immediately, in case it's the
     keyboard's own opening animation overshooting past its final
     resting height. It gets GROW_MS to prove it's stable before being
     accepted -- short enough to not read as a delay to the user, but
     comfortably longer than one animation overshoot's correction time. */
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
    /* Feeds the camera the raw height, not the held one -- the height
       hold above exists to keep the dialogue card from jumping while
       the player types, and the village visible behind that card isn't
       the thing being typed into. */
    if (!kbUp && !(vv && vv.scale > 1.01)) {
      seenTop = vv ? vv.offsetTop : 0;
      seenBottom = vv ? vv.offsetTop + raw : Infinity;
    }
    const b = document.body;
    if (b && b.classList) {
      const wasCramped = b.classList.contains('cramped');
      b.classList.toggle('cramped', h > 0 && h < CRAMPED);
      b.classList.toggle('tight', h > 0 && h < TIGHT);
      /* Android's back button (and some gesture-nav) can dismiss the
         keyboard without blurring the input that raised it -- the input
         stays focused, so anything keyed off focus (like the dialogue
         tray's collapse) would keep thinking the keyboard is still open.
         The visible height returning to normal is the one reliable
         signal that the keyboard actually closed, independent of
         whether the input itself noticed losing the keyboard -- so when
         that's observed, blur the input explicitly, matching what
         tapping the conversation area already does. Restricted to text
         inputs: the canvas can also hold focus (for keyboard-based
         play) and has nothing to lose by keeping it. A suggestion-strip
         dismissal can't trigger this path, since the height-holding
         logic above means `h` won't have actually changed for that case. */
      if (LG.touch.on && wasCramped && !b.classList.contains('cramped')) {
        const a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) a.blur();
      }
    }
  }
  /* Workaround for observed Firefox-on-Android behavior: after a text
     input gains focus and the keyboard is visibly open,
     visualViewport.height can keep reporting the pre-keyboard value for
     a moment, only correcting later in response to some unrelated event
     (a scroll, etc.) rather than firing its own resize event. Without
     this, the card would only catch up whenever that unrelated event
     happens to occur, rather than when the keyboard finishes opening.
     These extra re-checks after focus catch the correction proactively,
     so the card is at most a few hundred ms late instead of late by
     however long it takes something else to trigger a recheck.
     Harmless when the browser wasn't late to begin with -- a recheck
     that finds nothing changed just re-writes the same values. */
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

    /* A sign's English gloss is click-to-reveal, same as a notebook
       note -- so any canvas click must first be tested against whatever
       signs are currently on screen, before being handled as anything
       else. */
    const toWorld = e => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) + cam.x, y: (e.clientY - r.top) + cam.y };
    };
    /* Touch input's equivalent goes through LG.touch below, which
       suppresses the synthetic click event a tap also generates —
       without that, a tapped sign would register twice (once from the
       tap handler, once from the delayed synthetic click). The
       `LG.touch.on` check here is a backup guard against anything that
       fires a click event without a corresponding pointer. */
    canvas.addEventListener('click', e => {
      if (uiBlocked() || LG.touch.on) return;
      const p = toWorld(e);
      W.hitSign(p.x, p.y);
    });
    canvas.addEventListener('mousemove', e => {
      const p = toWorld(e);
      canvas.style.cursor = (!uiBlocked() && W.overSign(p.x, p.y)) ? 'pointer' : 'default';
    });
    LG.touch.init(canvas, { blocked: uiBlocked, tap: tapAt });

    /* The notebook and inventory boxes cover most of a phone screen —
       clicking/tapping their headings folds them down, so the village
       underneath is reachable without needing to look elsewhere first. */
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
    document.getElementById('setSave').onclick = submitSettings;
    document.getElementById('setProvider').onchange = () => { swapKeyField(); refreshModelList(); refreshHelperList(); refreshJevRow(); };
    document.getElementById('setModel').onchange = syncModelBox;
    document.getElementById('setHelper').onchange = syncHelperBox;
  }

  /* Tucks away whatever is in the key box under the provider it was
     typed for, and shows the newly picked provider's key instead -- so
     a Logfare key survives a detour through OpenRouter and back. */
  function swapKeyField() {
    const field = document.getElementById('setKey');
    draftKeys[keyProvider] = field.value.trim();
    keyProvider = document.getElementById('setProvider').value;
    field.value = draftKeys[keyProvider] || '';
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
      model: readModel() || settings.model,
      helper: readHelper(),
      jevMovement: document.getElementById('setJevMovement').checked,
      // No longer player-configurable: gossip is always on, translations
      // always start blurred, voices are always curated, and speech
      // speed always matches difficulty.
      showTranslation: false,
      npcChatter: true,
      voices: document.getElementById('setVoices').checked,
      ttsKey: document.getElementById('setTtsKey').value.trim(),
      voiceSpeed: 'auto',
      voiceQuality: 'curated'
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
    } else if (forceNewVillage) {
      newVillage();
    } else {
      log('The villagers now speak ' + LG.LANGUAGES[settings.lang].name + '.');
    }
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
    document.getElementById('setJevMovement').checked = settings.jevMovement;
    refreshModelList();
    refreshHelperList();
    refreshJevRow();
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
    // Logfare has exactly one model and always picks it — nothing to override.
    const fixed = prov === 'logfare';
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + (fixed ? '' : '<option value="other">Other — type an id below</option>');
    sel.disabled = fixed;
    const known = list.some(m => m.id === settings.helper);
    sel.value = fixed ? list[0].id
              : settings.helper && !known ? 'other' : (settings.helper || (list[0] && list[0].id) || 'other');
    document.getElementById('setHelperCustom').value = fixed || known ? '' : settings.helper;
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
    // Logfare has exactly one model and always picks it — nothing to override.
    const fixed = prov === 'logfare';
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + (fixed ? '' : '<option value="other">Other — type an id below</option>');
    sel.disabled = fixed;
    const known = list.some(m => m.id === settings.model);
    sel.value = fixed ? list[0].id
              : settings.model && !known ? 'other' : (settings.model || (list[0] && list[0].id) || 'other');
    document.getElementById('setModelCustom').value = fixed || known ? '' : settings.model;
    syncModelBox();
    document.getElementById('keyHint').textContent = prov === 'logfare'
      ? 'From logfare.ai/register — free and instant, no email needed.'
      : 'From openrouter.ai/keys.';
  }

  function syncModelBox() {
    const other = document.getElementById('setModel').value === 'other';
    document.getElementById('setModelCustom').style.display = other ? '' : 'none';
  }

  /* Jev is only reachable over OpenRouter (see JEV_MODEL in llm.js), so
     the checkbox is disabled -- and forced off -- under any other
     provider, the same way setModel/setHelper get force-fixed under
     Logfare above. */
  function refreshJevRow() {
    const box = document.getElementById('setJevMovement');
    box.disabled = document.getElementById('setProvider').value !== 'openrouter';
    if (box.disabled) box.checked = false;
  }

  /* A villager who sought out the player speaks first when the
     conversation starts, matching the same rule `villagerTalk` applies
     to two villagers who deliberately meet (see `sought` there).
     `wentAfter` is read and cleared here exactly once, rather than left
     for the conversation to re-check later — see LG.view.arrived. */
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
  /* Pressing E interacts with whatever's directly in front of the
     player; a tap instead directly names a target, so the two need
     separate handling. Both respect the same interaction range, though
     — tapping a distant villager across the green doesn't start a
     conversation any more than pressing E at them would — and an
     out-of-range tap gives feedback (see `aside` below) rather than
     doing nothing, since a tap with no visible response reads as a
     broken control rather than as "too far away". */

  /* A villager's sprite is ~16px wide but a fingertip covers closer to
     40px, so tap hit-testing pads well beyond the drawn sprite bounds.
     Where two padded areas overlap, whichever target's center is
     nearest wins. */
  const TAP_PAD = 14;
  function tapPick(wx, wy) {
    /* Only on-screen entities are tappable. A villager occluded by
       another building's wall isn't drawn (see the roof-hiding logic in
       draw()), so a tap there would otherwise target something invisible. */
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

  /* `sx`/`sy` are canvas-relative tap coordinates; adding the camera
     offset converts them to world/village coordinates. */
  function tapAt(sx, sy) {
    if (uiBlocked()) return;
    const wx = sx + cam.x, wy = sy + cam.y;
    // A tap on a signboard is consumed there, not also treated as a tap on the ground beneath it.
    if (W.hitSign(wx, wy)) return;

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

    /* The noticeboard is a ground area, not a drawn sprite, so it's hit
       by checking the tapped tile directly rather than a bounding box
       around an image. */
    const spot = { tx: (wx / TILE) | 0, ty: (wy / TILE) | 0 };
    if (nearRect(spot, LG.BOARD_SPOT, 0)) {
      if (nearBoard()) openBoard();
      else aside('Walk over to the noticeboard to read it.');
    }
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
    let workLabel = null;
    if (n.work) {
      // Uses the actual building name as the option label -- a literal
      // "your work" option caused villagers to reason aloud about what
      // and where "your work" was, rather than recognizing it. A
      // villager with no workplace building falls back to `job`, which
      // reads fine as a place ("the miner") for most villagers, but
      // Petra's job is a description rather than a location, so
      // `def.workLabel` lets a villager like her override it explicitly.
      workLabel = n.workBuilding ? n.workBuilding.label : (n.def.workLabel || n.def.job || 'your work');
      out.push({ name: workLabel, rect: n.work, note: 'where you work' });
    }
    // Avoid listing the green twice under two different names, for a villager (Petra) whose workplace is the green itself.
    if (workLabel !== 'the village green') {
      out.push({ name: 'the village green', rect: LG.GREEN, note: 'where people gather' });
    }
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
    /* The player is offered as a destination too, under the same
       visibility rule as any other villager, rather than being a fixed
       part of the map. Without this, a villager wanting to reach the
       player would have no way to express that — the same gap
       placesFor's roster addition (above) fixes for other villagers.
       `after: 'player'` is read by decideWhereToGo and produces an
       actual pursuit (see `followingPlayer`) rather than a one-time walk
       to wherever the player happened to be standing when asked. */
    if (LG.view.near(n, player, LG.view.SIGHT)) {
      out.push({ name: 'after you', rect: besideThem(player),
                 note: 'the traveller, wherever they get to', after: 'player' });
    }
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
      n.why = res.why || '';
      if (want.after === 'player') {
        // Pursuing the player is an ongoing chase (see followPlayer),
        // not a one-time walk to wherever they were standing when this
        // decision was made -- `wantsGo` is deliberately left unset so a
        // later decision (once the chase ends) won't find a stale
        // target rect still waiting to be acted on.
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
  const WALK_SPEED = 132, RUN_SPEED = 210;
  /* Keyboard and joystick input add into the same dx/dy pair, so both
     can be used simultaneously (e.g. a bluetooth keyboard alongside a
     touchscreen) rather than requiring an exclusive input mode. Keyboard
     input is digital (each direction contributes a full 1); the
     joystick's magnitude already reflects how far it's pushed. Only
     normalizing when the combined length exceeds 1 preserves full-speed
     keyboard diagonals while still letting a half-pushed joystick move
     at half speed. Running multiplies the same speed cap for both input
     types, rather than the joystick needing its own separate speed
     scaling. */
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

  /* Handles a villager actively chasing the player. Uses a real
     pathfinding route, re-plotted every couple of seconds rather than
     continuously -- the player keeps moving, so a route toward their old
     position quickly goes stale, but re-running A* every frame would be
     wasted work while the target hasn't moved far. Uses pathfinding
     rather than a straight line so the chase respects walls and doors
     like normal movement does: a villager only ever occupies a tile A*
     actually returned, never the player's exact pixel position.

     The chase times out rather than continuing indefinitely -- if a
     villager can't close the distance for a while (player kept moving,
     or reached somewhere hard to path to), the chase is abandoned, same
     as any other villager plan that becomes unachievable gets dropped
     rather than pursued forever. */
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
    // Game time is paused while a dialogue is open, so a long
    // conversation doesn't burn in-game hours or change the weather mid-chat.
    if (!LG.dialogue.isOpen() && LG.time.tick(dt))
      log('🗓 ' + LG.time.season().name + ', day ' + LG.time.dayOfSeason() + '.');
    const el = document.getElementById('clock');
    if (el) el.textContent = LG.time.label();

    movePlayer(dt);

    for (const n of npcs) {
      const wasFollowing = n.followingPlayer;
      const walking = wasFollowing ? followPlayer(n, dt) : !!(n.route && n.route.length);
      if (!wasFollowing)
        A.routine(n, dt, LG.GREEN, settings.apiKey && settings.npcChatter ? decideWhereToGo : null);
      if (n.wasWalking && !walking) {
        think(n, 'arrives', LG.view.where(n) + (n.why ? ' — ' + n.why : ''));
        // `patch` still reflects wherever the villager last decided to
        // go, not where a chase just ended -- so it's excluded here to
        // avoid misreading a chase's end as "arrived at the noticeboard".
        if (!wasFollowing && n.patch === LG.BOARD_SPOT) maybePostNotice(n);
      }
      n.wasWalking = walking;
      if (!wasFollowing) A.walk(n, dt, 34);
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
        // Catching the animal requires an explicit action (see
        // interact()/tapPick) -- just walking within reach must not
        // auto-catch it the way picking up a dropped item does. The hint
        // text already tells the player to press E.
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
    /* On touch, the hint just names what's nearby, since the action is
       simply tapping what's visible -- no key to name. On keyboard, it
       needs to say which key to press. */
    const tap = LG.touch.on;
    if (uiBlocked()) {
      hint.classList.remove('show');
    } else if (nudgeT > 0) {
      hint.textContent = nudge;
      hint.classList.add('show');
    } else if (nearby) {
      hint.textContent = tap ? 'Tap ' + displayName(nearby) + ' to talk'
                             : 'Press E to talk to ' + displayName(nearby);
      hint.classList.add('show');
    } else if (beast && !beast.caught && dist(player, beast) < TILE * 1.8) {
      hint.textContent = (tap ? 'Tap to pick up ' : 'Press E to pick up ') + beast.name;
      hint.classList.add('show');
    } else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.8) {
      hint.textContent = tap ? 'Tap to pick it up' : 'Press E to pick it up';
      hint.classList.add('show');
    } else if (nearBoard()) {
      hint.textContent = tap ? 'Tap the noticeboard to read it'
                             : 'Press E to read the noticeboard';
      hint.classList.add('show');
    } else {
      hint.classList.remove('show');
    }

    /* Camera is centered on the middle of the visible band (see seen()),
       not the middle of the full canvas, and clamped so the map edge
       aligns with the edge of the visible area rather than the canvas
       edge -- this keeps map corners from being hidden under browser
       chrome or on-screen phone controls. When the whole canvas is
       visible (any desktop window), the visible band equals the canvas,
       so this reduces to the original simple centering/clamping. */
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

  /* Rounds the camera offset to whole *device* pixels, not CSS pixels
     -- the canvas is scaled by dpr, so at a fractional dpr (125%/150%
     display scaling is common), an offset that's only a whole CSS pixel
     can still land a tile edge on a fractional device pixel, giving
     adjacent ground tiles their own antialiased edges instead of a
     shared crisp seam (visible as a faint lattice over the terrain).
     Both draw() and paintGroundLayer() call this, so the cached ground
     layer stays aligned with where a live translate would place it. */
  function roundedCam() {
    return { x: Math.round(cam.x * dpr) / dpr, y: Math.round(cam.y * dpr) / dpr };
  }

  function paintGroundLayer(room) {
    const g = groundCtx, c = roundedCam();
    g.fillStyle = '#3f6b3a';
    g.fillRect(0, 0, vw, vh);
    g.save();
    g.translate(-c.x, -c.y);
    W.drawGround(g, cam, vw, vh, dpr);
    W.drawBuildings(g, room, cam, vw, vh);
    W.drawSigns(g, cam, vw, vh, settings.lang, settings.showTranslation, dpr);
    g.restore();
  }

  /* Repaints the cached ground layer only when something visible in it
     has actually changed: camera position, entering/exiting a roofed
     area, snow depth advancing a bucket (bucketed the same way world.js
     does -- see readSnow() there), or a sign's language/reveal state.
     Otherwise draw() just blits the existing cached layer unchanged. */
  function refreshGroundLayer(room) {
    const c = roundedCam();
    const snow = Math.round((LG.time && typeof LG.time.snow === 'number' ? LG.time.snow : 0) * 400);
    const roomX = room ? room.x : -1, roomY = room ? room.y : -1;
    if (c.x === groundSeen.camX && c.y === groundSeen.camY &&
        roomX === groundSeen.roomX && roomY === groundSeen.roomY &&
        snow === groundSeen.snow && settings.lang === groundSeen.lang &&
        settings.showTranslation === groundSeen.trans) return;
    groundSeen.camX = c.x; groundSeen.camY = c.y; groundSeen.roomX = roomX; groundSeen.roomY = roomY;
    groundSeen.snow = snow; groundSeen.lang = settings.lang; groundSeen.trans = settings.showTranslation;
    paintGroundLayer(room);
  }

  function draw() {
    const room = W.buildingUnder(player);
    refreshGroundLayer(room);
    ctx.drawImage(groundCanvas, 0, 0, vw, vh);

    ctx.save();
    const c = roundedCam();
    ctx.translate(-c.x, -c.y);

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
    LG.sky.draw(ctx, vw, vh, W.roofRects(cam, vw, vh, dpr), dpr);

    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, vw, vh);

    // Drawn on top of the weather and vignette layers -- it's a UI control, not part of the scenery.
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
           // Bypasses the settings gate without a real API key -- for
           // console debugging and for tests, which need to get past it
           // to test anything behind it. Also un-hides the HUD (not just
           // clearing the gate flag), since the HUD stays hidden while
           // gated -- an invisible village would be a useless test result.
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
