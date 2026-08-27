/* game.js — state, the main loop, input, the notebook, and settings. */
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

  // No key, no village. `gated` freezes input until the front door is passed.
  let gated = true, gateMode = false, lastValidated = '';
  let fromEnv = false;             // the keys were handed to us, not typed

  const state = { inv: {}, notes: [], deeds: [], won: false, board: [] };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0, dpr = 1;
  let player, npcs = [], beast = null, worldItem = null;
  let whereFact = null;             // the fact saying where the world thing is lying
  let chainNeeds = {};              // items the errand cannot be finished without
  /* Physical keys, not characters. e.key is whatever the layout produces — on a
     Russian keyboard WASD types цфыв and E types у — so movement and interaction
     read e.code, and fall back to e.key only for anything that lacks it. */
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

  /* Names are unknown until a villager actually tells you theirs — the same
     rule the notebook already runs on for everything else a villager knows,
     just applied to the one thing about them that used to be free. Every
     place the game would otherwise print `npc.def.name` in front of the
     player goes through here instead. What the model itself is told — its
     own name, in its own system prompt — is untouched: this is only ever
     about what the *player* has been told, and only by asking. `nameKnown`
     is set the moment a villager's own reply states it — see the check in
     dialogue.js — never by a fact arriving from anyone else, however
     reliable, because that is not this villager telling you their name. */
  function displayName(n) {
    return (n.nameKnown && n.def.name) || n.def.job;
  }
  /* For a line written *in the village's language*, where an English job
     description would read as a word dropped in from nowhere. The emoji
     already marks every character on screen — see drawCharacter — so it
     reads the same way there: someone you can place, but not yet name. */
  function nameOrEmoji(n) {
    return (n.nameKnown && n.def.name) || n.def.emoji;
  }

  /* A short line the game itself narrates about a deal — "you hand over the
     rope" — written in the language the village speaks rather than English.
     See LG.TXN. `native`/`english` are the same template's placeholders filled
     in each language; the English fill doubles as the gloss underneath,
     click-to-reveal like everything else the notebook shows. */
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
     The player only knows what somebody has actually told them. Villagers
     report which facts they revealed; those are what land here.

     Not everything a villager can tell you belongs there, though. `opinion`
     facts — the gossip chain.js hands out so the village has something to
     talk about — are real, checkable, learnable facts the same as any errand
     fact, but they are not the errand: writing "Yuri thinks Mira is stingy"
     into the notebook next to "Mira has the rope" makes the one page that is
     supposed to say what to do next into a page you have to sift. */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (plan.facts[factId].type === 'opinion') return;   // gossip, not the errand
    if (hasNote(factId)) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    /* A note records that you were told something, and nothing else. Whether it
       is still worth acting on is not stored here, because a stored answer is a
       thing that can be stored wrongly — being told where the thing is when it
       is already in your pocket used to arrive as a live lead, and being told
       about a link you had already traded still did. It is read off the world at
       render time instead, so there is no way to write a note that claims to be
       live when it is not. */
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

  /* Overhearing two villagers.

     They are talking to each other, in their own language — there is no English
     anywhere in that exchange, so there is none in the log either. What you get
     is the line as spoken, with furigana or a romanisation the same as anywhere
     else. The English is there to check yourself against, blurred until you ask
     for it, and it stays blurred even with translations switched on: a villager
     explaining something to you is a lesson, but eavesdropping is a test, and
     handing over the answer makes overhearing a way to skip the language. */
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

  /* Everything the errand runs on: what each villager wants, what each hands
     over, the prize at the end and the thing lying out in the world. Worked out
     once with the village rather than per sale, since it cannot change. */
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

  /* A sale, of one thing or of several — and its reverse.

     The villager decides a sale has happened; this makes it real, or says why
     it did not. Their price stands as long as it is not wild, because the
     haggling is the point.

     A villager will happily say "beer and wine, that's six", so `item` takes a
     list and `price` is the total for the lot. It used to be a single tag, which
     rang a two-item sale up as one item at the two-item price: you paid for the
     round and got the beer.

     They will also take back what they sold you. Their `buys` list is what they
     deal in as a trade — the innkeeper buys fish and meat — and does not include
     their own stock, so a refund on a beer she poured you five minutes ago found
     no price and quietly did nothing while she said the coins were on their way.
     What they sold you is remembered, and comes back at what you actually paid. */
  function commerce(npc, act, itemId, price) {
    const d = npc.def;
    const coins = n => n + (n === 1 ? ' coin' : ' coins');

    npc.sold = npc.sold || {};                 // index: what they can take back, at what price
    npc.till = npc.till || [];                 // the record they actually get to read
    npc.stock = npc.stock || {};               // what they are actually holding

    /* Shut for the night. This used to be a bare `return false` before the till
       existed, which is to say the sale failed in silence: the villager had
       already described handing over the tea and taking the two coins, and
       nothing in the game or the conversation ever said otherwise. */
    if (!LG.view.open()) {
      return refuse('It is the middle of the night and you are not trading, so nothing changed hands.',
                    d.name + ' is not trading at this hour — nothing changed hands.');
    }

    /* A refusal has to reach the villager. Left to narrate unaided they will
       describe the refund as done, and then be baffled when you offer the beer
       again — they have no way of knowing the till disagreed with them. */
    function refuse(note, shown) {
      npc.till.push({ failed: true, note: note });
      log('¤ ' + (shown || note));
      renderHUD();
      return false;
    }

    // a list, or "beer, wine" written out as one string — both turn up
    /* Nothing is exchanged for nothing. An explicit price of zero is not a
       haggle, it is a villager narrating rather than dealing — and the band below
       would quietly invent a coin for it, which is how a shell got taken off the
       traveller for a purchase nobody meant to make. A missing price still falls
       back to what the thing is worth. */
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
      // Something they bought earlier is theirs to sell on, whether or not it is
      // the sort of thing they usually deal in.
      if (act === 'sell') {
        const own = npc.stock[id] > 0 ? Math.max(1, Math.round(LG.priceOf(id))) : 0;
        return { id: id, base: priceFrom(d.sells, d.sellsTags, id, 1) || own, fromStock: own > 0 };
      }
      const owed = back(id);                       // returning something they sold you
      return owed ? { id: id, base: owed.price, refund: true }
                  : { id: id, base: priceFrom(d.buys, d.buysTags, id, 0.5) };
    }).filter(w => w.base > 0);

    /* Whether they have it comes before whether it has a price, or a villager
       who plainly sells beer ends up saying she does not deal in beer when what
       is actually missing is the beer. */
    if (act === 'buy') {
      const short = asked.filter(id => count(id) < 1);
      if (short.length) {
        const names = short.map(id => LG.ITEMS[id].en).join(' or ');
        return refuse('The traveller does not actually have ' + names + ' to give you.',
                      'You have no ' + names + ' to hand over.');
      }
    }

    /* Nobody buys a link of the chain off you for coins. You could sell the pie
       the baker is waiting for to the innkeeper for three coins, and short of
       buying it back off her — at her price, with the coins she just gave you —
       the errand was over with no way to tell that it was. A trade is a
       different thing and still works: that is how the chain is meant to move.

       The note says what the till did and stops there. It used to say the
       traveller was carrying it for somebody and to tell them they would need
       it, which is a line written for the villager and a fact about the
       traveller's business that this villager has no way of knowing. */
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

    // A haggle, not a fleecing — but when the band does bite, the player is
    // charged a number nobody in the conversation said, so it is said out loud.
    // A refund is not a haggle: it is the money back, exactly.
    const refunding = priced.every(w => w.refund);
    const asking = cost;
    cost = refunding
      ? Math.min(cost, base)                                   // never more than was paid
      : Math.max(Math.ceil(base * 0.4), Math.min(Math.ceil(base * 2.5), cost));

    const names = priced.map(w => LG.ITEMS[w.id].full).join(' and ');

    /* One transaction, rung up twice. Tomas agreed a knife for two coins and
       flagged the sale on the turn he agreed it — "you give me two coins, the
       knife is yours", which is a bargain being struck, not goods crossing a
       counter. The traveller then did the obvious thing and held out the coins,
       and the sale went through a second time: two knives, four coins, and a
       villager who could not work out where the second knife had come from.

       The prompt asks for "sell" at the moment goods change hands and not while
       the two of you are still discussing it, and that is worth asking for, but
       it is a matter of the model's judgement about its own last sentence. This
       is not: the same goods, from the same villager, on the turn straight after
       they were already handed over and paid for, is one sale being counted
       twice. A later repeat is left alone — wanting a second knife tomorrow is an
       ordinary thing to want. The refusal goes in the till where they can read
       it, rather than the traveller quietly paying twice. */
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
        /* They are holding it now. Without this the goods simply evaporated: the
           apple left the traveller's pocket, a coin came back, and the villager
           who had just bought it went on saying she had no apples — which was
           true of everything she could see. */
        else npc.stock[w.id] = (npc.stock[w.id] || 0) + 1;
      });
      give('coins', cost);
    }

    if (asking !== cost) log('¤ ' + d.name + ' said ' + asking + ', the going rate is ' + cost + '.');
    const dealKey = act === 'sell' ? 'buy' : refunding ? 'refund' : 'handOver';
    const ids = priced.map(w => w.id);
    txnLog('¤', dealKey, { items: itemsPhrase(ids, settings.lang), name: nameOrEmoji(npc), cost: cost },
                          { items: itemsPhrase(ids, 'en'), name: displayName(npc), cost: cost });

    /* What the villager remembers has to be what the game actually did, or they
       do their own arithmetic from a half-memory and it drifts — quoting six,
       being paid five, and insisting next turn that you have three left. */
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

    /* The notes that described this deal are spent, and say so by being struck
       through rather than by vanishing — the same argument the note about where
       something was lying already made: a line that disappears reads as a bug,
       and you lose the record of who told you. Nothing is done to them here;
       `factSpent` can see the completed trade and the notebook reads it. */

    /* And the villager stops believing it too — but on their own rule, not the
       notebook's. `factSpent` asks whether a thing is true of the world, which is
       what the player's notebook is entitled to know; this asks only what this
       villager just did with their own hands. They are not the same question,
       and answering the second with the first would tell a villager the axe had
       been picked up because somebody else picked it up. Their facts were
       dealt once at the start and nothing ever took one back, so Wren went on
       holding "Wren has a teapot" and "Wren will only part with it for a pig"
       after handing the teapot over for the pig — and said both out loud, to the
       traveller and to the village. What retires is only this villager's copy:
       anyone else who was told it still believes it until somebody tells them
       otherwise, the same way nobody who never walks to the graveyard finds out
       the axe has gone. The memory line is how it can travel. */
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
    /* Into the till, both sides of it. A trade used to leave a memory saying only
       "the traveller brought me a bowl of rice", which never mentioned the shell
       going back the other way — so the villager went on trying to finish an
       exchange that was already finished, and encoded the attempt as an action. */
    npc.till = npc.till || [];
    npc.till.push({ act: 'trade', names: gave, gaveBack: got, coins: 0, asked: 0,
                    at: LG.time.clock() });

    if ((plan.roles[npc.def.id] || {}).link === 0) win();
    renderHUD();
    // a link of the chain is not something to lose to a closed tab
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
    /* A village you have already been to comes back as it was; only a first
       arrival is rolled. `resume` puts the local copy back at once and asks the
       log server for its own in the background, so a missing or slow server
       delays nothing — the same bargain adoptEnv makes below. */
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

  /* Keys from .env, by way of the log server.

     The game was built to ask for a key at the door because a web page cannot
     read a file off your disk. A server can, and there is one here now, so if it
     is running and has a .env it hands the keys over and the door is already
     open. This is asked for after the game has started rather than before, so a
     missing or slow server delays nothing: the gate is up either way, and it
     comes down by itself if an answer arrives. */
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
    /* The village is built out of the language and the difficulty, so a change
       to either means starting it again — nothing has happened yet in any case.
       Unless something has: a resumed village is a village you were in the
       middle of, and .env arriving late is no reason to throw it away. Its own
       language and difficulty came back with it, so they are what the settings
       now say. */
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

  /* Roll a fresh errand chain and reset everything that depends on it. */
  function newVillage(seed, quiet) {
    plan = LG.chain.generate({ level: settings.level, seed: seed || null });

    /* A new village is a new arrival, so the calendar is rolled with it: you
       turn up on a random day of the year and take whatever weather that day
       has. The hour is not rolled — arriving at three in the morning, in the
       dark, with nobody out of doors, is nobody's idea of a start. */
    LG.time.start();

    state.inv = { coins: 10 };          // a little money to be going on with
    state.notes = []; state.deeds = []; state.won = false; state.board = [];

    /* You arrive by train. The platform is the far east end of the high
       street, so the first thing you do is walk the length of it into a
       village where nobody is expecting you. */
    const p = W.nearestOpen(LG.START.x, LG.START.y);
    player = { px: p.x * TILE + TILE / 2, py: p.y * TILE + TILE / 2, dir: 'left',
               tx: p.x, ty: p.y, bubble: null, bubbleT: 0 };
    npcs = LG.NPCS.map(d => A.makeNPC(d, plan.npcFacts[d.id]));
    // Everyone needs somewhere to work, and somewhere with a roof to bolt to.
    const publics = ['Inn', 'Village Hall', 'Chapel']
      .map(l => W.buildingByLabel(l)).filter(Boolean);
    npcs.forEach((n, i) => {
      const b = n.def.workplace ? W.buildingByLabel(n.def.workplace) : null;
      n.work = b ? b.inside : (n.def.workRect || n.def.home);
      n.workBuilding = b;
      const refuge = b || publics[i % Math.max(1, publics.length)];
      n.shelter = refuge ? refuge.inside : n.def.home;
    });

    /* Petra is nosy and nothing happens in the village without her knowing
       about it, so a stranger stepping off the train is the most interesting
       thing to happen all week. She meets every arrival at the platform, the
       same way any villager who goes looking for the traveller does (see
       placesFor and followPlayer) — she just starts out already having
       decided to, rather than getting there by asking the model. */
    const petra = npcs.find(n => n.def.id === 'petra');
    if (petra) {
      const spot = W.nearestOpen(p.x - 5, p.y + 1);
      petra.tx = spot.x; petra.ty = spot.y;
      petra.px = spot.x * TILE + TILE / 2; petra.py = spot.y * TILE + TILE / 2;
      petra.followingPlayer = true;
      petra.wentAfter = 'player';
      petra.why = 'a traveller has just got off the train, and nobody has told them anything about the village yet';
    }

    // the thing at the end of the chain, out in the world somewhere
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
    /* Written down at once rather than at the next autosave, so that closing the
       tab in the first twenty seconds does not bring the old village back. */
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

    /* A sign's English gloss is click-to-reveal, the same as a note in the
       notebook — so a click on the canvas has to be tested against whatever
       signs are actually on screen before it is allowed to mean anything
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

  /* Whether there is anything worth writing down. Behind the front door the
     village is only a backdrop for the title screen — saving it would overwrite
     a real one with a village nobody has played. */
  function saving() { return !gated && !!plan; }

  function panelOpen() { return !!document.querySelector('.panel.open'); }
  function uiBlocked() { return gated || panelOpen() || LG.dialogue.isOpen(); }
  function closePanels() {
    if (gated) return;   // the front door does not take Escape for an answer
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

    // Only spend a round trip when the credentials actually changed.
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
    // whether these models will take a schema is a fact about this pair; ask again
    LG.llm.probe(llmConfig());
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

    if (voiceChanged) { LG.tts.stop(); loadVoices(); }

    if (gateMode) {
      gated = false;
      gateMode = false;
      showChrome();
      /* The front door used to roll a village on the way through, which is right
         for a first visit and wrong for a save: you would come back to the
         village you left, type your key, and watch it be replaced. A different
         difficulty is a different village and still rolls one. */
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

  /* Try the key without leaving the settings panel, and show exactly what came
     back — a 401 from ElevenLabs says which of key/permission/kind it was. */
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

  /* Casting the villagers takes one request; do it while the player is reading
     the help panel rather than when they first say hello. */
  function loadVoices() {
    if (!settings.voices || !settings.ttsKey) return;
    LG.tts.load(ttsConfig()).then(ok => {
      if (ok) log('🔊 The villagers have found their voices.');
      else log('🔊 No voices: ' + LG.tts.error);
    });
  }

  /* the HUD is noise behind the title screen */
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
    // where the key came from, so a field you did not fill in is not a mystery
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

  /* What the saved village is, in one line. The autosave is silent by design —
     a message every twenty seconds would be noise — so this is the only place
     that says out loud that the game is being kept, and where. */
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

  /* "Other" reveals a free-text box, so a model newer than this picker can still
     be used without editing the source. */
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

  /* Someone who came looking for the traveller has something to say, and says
     it first — the same courtesy `villagerTalk` already gives two villagers
     who run into each other on purpose (see `sought` there). `wentAfter` is
     read and discharged here, once, rather than left for the conversation to
     ask about again later — see LG.view.arrived. */
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

  /* Whether the thing at the end of the chain has been collected — once, ever.
     Trading it on afterwards does not put it back where it was lying. */
  function haveTerminal() {
    return !!((worldItem && worldItem.taken) || (beast && beast.caught));
  }

  /* Has the thing this fact describes already happened?

     There were three answers to that and none of them was this one. `learn` had
     a line of its own that knew only about the thing lying in the world;
     `doTrade` had a second, written inline, that knew only about its own link
     and deleted the note outright; picking the terminal item up had a third that
     ticked. So a villager could tell you "Yuri is looking for a pair of shoes"
     after you had given Yuri the shoes, and it went in the notebook as a live
     lead, because the one path that writes notes could not see the one kind of
     resolution that had happened.

     One predicate now, and both things it reads are one-way: `haveTerminal` is
     explicitly once-ever, and a completed trade stays completed. That is what
     makes the next part safe. */
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

  /* The noticeboard has no actor to measure a distance from, only a patch of
     ground — the same rectangle villagers are sent to. */
  function nearBoard() { return nearRect(player, LG.BOARD_SPOT, 1); }

  /* Tile geometry lives in world.js with the rest of it. */
  const nearRect = W.nearRect;

  /* The one fact in the errand that can stop being true while you play: the
     thing lying out in the world gets picked up. Facts are dealt once, at the
     start, so without this a villager who was told it was down by the pond goes
     on sending people to the pond for the rest of the session. Walk to the spot
     and find nothing, and they stop saying it — and remember why, so they can
     tell you and each other. Nobody who never goes there ever finds out. */
  /* Everything a villager comes to believe goes through here, so it all carries
     the same two things: when they came by it, and who from. Nothing in the
     village is known better than anything else — a chain fact dealt at the start
     and a rumour picked up on the green are the same kind of object, and the
     only thing that separates them is how fresh they are and who said so. `from`
     is left off for what they saw themselves.

     Memories used to be bare strings. A string cannot be weighed against another
     string, and a villager asked to reconcile two of them has nothing to reason
     with; Mira held "Yuri is looking for shoes" and "the traveller gave Yuri
     shoes" at the same time, said out loud that the two did not fit, and had no
     way to tell which was older. */
  function remember(npc, text, from) {
    if (!text || typeof text !== 'string' || text.length < 3) return false;
    npc.memory = npc.memory || [];
    if (npc.memory.some(m => (m && m.text) === text)) return false;
    npc.memory.push({ at: LG.time.clock(), text: text, from: from || null });
    if (npc.memory.length > 24) npc.memory.shift();
    return true;
  }

  /* A fact arriving from somebody else is dated and attributed the same way. The
     ones dealt at the start carry nothing, which is what makes them read as
     something you have simply always known. */
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
    /* What they saw, and only that. "Somebody has had it away" was the first
       version, which hands them a theft they did not witness and would go into
       the next conversation as something they know. They looked, and it was not
       there; what they make of that is theirs. */
    const t = plan.terminal;
    const line = t.isBeast
      ? 'You went ' + t.placeText + ' yourself and ' + t.beastName + ' was not there.'
      : 'You went ' + t.placeText + ' yourself and there was no ' +
        LG.ITEMS[t.item].en + ' there.';
    remember(n, line);                       // seen with their own eyes: no source to name
    think(n, 'finds nothing there', t.placeText);
  }
  /* Trading hours and standing-at-the-counter now live with everything else a
     villager can see about themselves — see LG.view. */

  /* What this villager will sell, explicit wares first then anything their trade
     covers. Returns the price, or 0 if they would not sell it at all. */
  function priceFrom(list, tags, id, factor) {
    const ware = (list || []).find(w => w.i === id);
    if (ware) return ware.p;
    const it = LG.ITEMS[id];
    if (it && tags && tags.some(t => (it.tags || []).indexOf(t) !== -1)) {
      return Math.max(1, Math.round(LG.priceOf(id) * (factor || 1)));
    }
    return 0;
  }

  /* Where a villager goes is theirs to decide, not a dice roll — this hands them
     the options and files whatever they choose. The choice is made by the helper
     model from their own goal and memory, so the baker opens up because she is
     the baker and the woman looking for a saw goes where she heard there is one. */
  const DECIDE_COOL = 25;

  /* Villagers think out loud into the console. Every decision comes back with a
     reason and nothing was doing anything with it, which made the difference
     between a villager reasoning and a villager rolling dice invisible from the
     outside. Tagged in the villager's own colour so a busy village stays
     readable. `LG.game.thoughts = false` turns it off. */
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
  /* Everywhere a villager could sensibly go, including after other people.

     Knowing that Mira has the pie is worth nothing if there is no way to go and
     find Mira — Boris worked that out the hard way, reasoned that "Mira's home is
     not listed as a place I can go", and settled for standing on the green
     hoping she would turn up. So whoever they can see is a destination too. */
  function placesFor(n) {
    const out = [{ name: 'home', rect: n.def.home, note: 'your own place' }];
    if (n.work) {
      // "your work" was a literal option name, and it made villagers wonder aloud
      // what and where their work was. Name the place.
      const label = n.workBuilding ? n.workBuilding.label : (n.def.job || 'your work');
      out.push({ name: label, rect: n.work, note: 'where you work' });
    }
    out.push({ name: 'the village green', rect: LG.GREEN, note: 'where people gather' });
    out.push({ name: 'the noticeboard', rect: LG.BOARD_SPOT,
               note: 'where anyone may pin up a note for the village to read' });
    /* The two edges of the map worth walking to. Not every glade in the woods
       — thirteen villagers each given six clearings to choose between would
       empty the village out, and a place nobody can be found in is a place
       the errand goes to die. One way into the trees and one way out of the
       village is enough for either to be somewhere a person might actually
       be. */
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
    /* The traveller is a destination too, on the same terms as anyone else —
       seen and named, not a fixture of the map. Without this a villager could
       want to catch up with the traveller and have no way to say so, the same
       gap Boris hit over Mira above. `after: 'player'` is picked up in
       decideWhereToGo and turns into an actual chase, not a walk to wherever
       they happened to be standing when asked — see `followingPlayer`. */
    if (LG.view.near(n, player, LG.view.SIGHT)) {
      out.push({ name: 'after you', rect: besideThem(player),
                 note: 'the traveller, wherever they get to', after: 'player' });
    }
    return out;
  }

  /* A patch of ground next to someone, so "go after Mira" means standing where
     she is rather than occupying her exactly. */
  function besideThem(o) {
    return { x: Math.max(0, o.tx - 2), y: Math.max(0, o.ty - 2), w: 5, h: 5 };
  }

  function decideWhereToGo(n, green) {
    const opts = placesFor(n);
    const done = () => { n.deciding = false; n.decideCool = DECIDE_COOL; };
    if (n.decideCool > 0) { n.deciding = false; return false; }   // asked too recently
    think(n, 'wonders where to be', LG.view.where(n) + ', ' + LG.time.phase().name);
    /* Everything they can see about themselves comes from one place now, so
       that the villager choosing where to stand is the same villager the player
       will meet when they get there. `heard` is the half that used to be missing:
       without it a villager could learn that rice was for sale two minutes away
       and have no way to act on it — the whole village once spent an afternoon
       discussing a bowl of rice that was on offer the entire time, because what
       they knew and what they decided were separate channels. */
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
      /* Match forgivingly. Being told the exact strings cuts the failure rate but
         does not end it, and "village green" for "the village green" should not
         leave someone standing in the road. */
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
        // Chasing the traveller is not a walk to wherever they stood when
        // asked \u2014 see followPlayer. `wantsGo` is left unset so a decision
        // made later, once the chase is over, does not find a stale rect
        // here waiting to be acted on.
        n.followingPlayer = true;
        n.wentAfter = 'player';
      } else {
        n.wantsGo = want.rect;
        // "after Mira" is a decision about a person, and the conversation
        // that follows should know it was not a coincidence
        n.wentAfter = want.after || null;
      }
      think(n, '\u2192 ' + want.name, n.why);
    }).catch(() => { done(); think(n, 'could not decide', 'the call failed'); });
    return true;
  }

  /* Close enough to make out what they are saying? Only decides whether it goes
     in the log — the conversation happens either way. */
  function canOverhear(a, b) {
    return dist(player, a) < TILE * 11 || dist(player, b) < TILE * 11;
  }

  /* They have met and stopped to talk. Nothing is decided about what will be
     said — they have their own business, their own memories, and whatever the
     weather is doing. What either of them keeps is settled afterwards.

     Both of them are photographed here, once, rather than handed to the
     conversation as a bundle of callbacks it can ask again on every turn. A
     conversation is about the two people who started it: reading their state
     afresh four lines in meant it could change underneath the exchange. */
  function villagerTalk(a, b) {
    if (!settings.apiKey) return false;
    const va = LG.view.of(a, 'chat'), vb = LG.view.of(b, 'chat');
    /* Whether either of them came looking for the other, settled before the
       first line and spent in the asking. It used to be read live from a flag
       that was set when they set off and never cleared, so a villager who once
       walked over to Mira greeted her with "I came looking for you" every time
       the two of them met for the rest of the day. */
    va.sought = va.errand.after === vb.id;
    vb.sought = vb.errand.after === va.id;
    LG.view.arrived(a); LG.view.arrived(b);
    LG.dialogue.overheard(a, b, { a: va, b: vb });
    return true;
  }

  /* ------------------------------------------------------------- the board
     A villager who chose to come here (see `placesFor`) is given the chance to
     pin something up, and nothing is decided about what — it does not have to
     be their own errand, or an errand at all. Wanting to say nothing is a
     perfectly good answer, the same latitude "remember" gets in a player
     conversation, so this does not fire on every arrival either: only when
     they have not just posted. */
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

    // Nominated, then fact-checked — the same rule a villager's own report of
    // what they told the player is held to, and for the same reason: a
    // villager will flag a fact because it used the word, not because it
    // actually said the thing.
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

  /* The player reads what is currently pinned up. Facts a confirmed notice
     states are learned here, not when they were posted — a note only reaches
     the player's notebook once they have actually gone and read it, the same
     as anything a villager says. `learn` is passed no source villager: a
     pinned notice is a fixed thing on a board, true regardless of whether its
     writer would still say it. */
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
      // A notice is signed with the poster's real name outright, unlike a
      // nametag or a line of spoken dialogue — a pinned note is a public,
      // written thing, and a village that could not name its own notices
      // would not be much of a noticeboard.
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

  /* Chasing the traveller, once a villager has decided to. A real route,
     re-plotted every couple of seconds rather than once — the traveller
     moves, so a path laid against where they stood a moment ago is already
     stale, but re-running A* every frame is needless work for a target that
     has not moved far. Routed rather than a straight line so that "after
     you" respects the same walls and doors everything else does: a villager
     is only ever placed on a tile A* actually returned, never wherever the
     traveller happens to be standing pixel-for-pixel.

     Nobody chases forever. A villager who cannot close the gap for a while —
     the traveller kept walking, or ducked somewhere awkward to reach — gives
     it up as something that can wait, the same way any other plan a villager
     can no longer act on gets dropped rather than pursued to the letter. */
  const CATCH_UP = TILE * 1.6;             // matches the "who is nearby" hint radius
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
    if (LG.time.tick(dt)) log('🗓 ' + LG.time.season().name + ', day ' + LG.time.dayOfSeason() + '.');
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
        // `patch` is stale while chasing the traveller — the last place they
        // had actually decided to go, not where the chase just ended — so it
        // is not read as "arrived at the noticeboard" here.
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
    /* Rounded to whole *device* pixels, not CSS pixels: the canvas is scaled by
       dpr, so at a fractional dpr (125%/150% display scaling is common) a
       camera offset that is merely a whole CSS pixel can still land tile edges
       on a fractional device pixel. Adjacent ground tiles then each get their
       own antialiased edge instead of sharing one crisp seam, which prints the
       tile grid as a lattice of faint lines over the terrain. */
    ctx.translate(-Math.round(cam.x * dpr) / dpr, -Math.round(cam.y * dpr) / dpr);

    const room = W.buildingUnder(player);

    W.drawGround(ctx, cam, vw, vh);
    W.drawBuildings(ctx, room, cam, vw, vh);
    W.drawSigns(ctx, cam, vw, vh, settings.lang, settings.showTranslation);
    drawWorldItem();

    /* A villager under a roof is out of sight. You can see into the room you are
       standing in — that is what lifting the roof is for — but not through
       someone else's walls, so the baker at her oven is genuinely away until you
       go in after her. */
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
        // The role badge (the emoji) is always visible — what is withheld is
        // the name, not what they do for a living.
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
