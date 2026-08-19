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

  const state = { inv: {}, notes: [], deeds: [], won: false };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0;
  let player, npcs = [], beast = null, worldItem = null;
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
  function saveClock() {
    try { localStorage.setItem('lg-clock', JSON.stringify({ day: LG.time.day, frac: LG.time.frac })); }
    catch (e) {}
  }
  function loadClock() {
    try {
      const raw = localStorage.getItem('lg-clock');
      if (raw) { const c = JSON.parse(raw); return c; }
    } catch (e) {}
    return null;
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

  /* ------------------------------------------------------------ notebook
     The player only knows what somebody has actually told them. Villagers
     report which facts they revealed; those are what land here. */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (hasNote(factId)) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    state.notes.push({ id: factId, text: note || plan.facts[factId].text, ruby: ruby || null });
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
               '<span class="heard"' + (ruby && L.furigana ? ' style="line-height:2"' : '') +
               '>' + heard + '</span>';
    if (roman && L.romanize) html += '<span class="roman">' + escapeHTML(roman) + '</span>';
    if (gloss) html += '<span class="gloss hidden-tr" title="click to read">' +
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
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0 && k !== 'coins');
    inv.innerHTML = ks.length
      ? ks.map(k => '<span class="pill" title="' + LG.ITEMS[k].en + '">' + LG.ITEMS[k].icon +
          ' ' + escapeHTML(itemLabel(k)) + (state.inv[k] > 1 ? ' ×' + state.inv[k] : '') + '</span>').join('')
      : '<span class="muted">empty pockets</span>';

    const nb = document.getElementById('notebook');
    const L = LG.LANGUAGES[settings.lang];
    const rows = state.deeds.map(d => '<div class="q done">✔ ' + escapeHTML(d) + '</div>')
      .concat(state.notes.map(n => {
        const heard = (n.ruby && L.furigana) ? LG.dialogue.rubyHTML(n.ruby) : escapeHTML(n.text);
        const gloss = plan.facts[n.id].text;
        const hide = settings.showTranslation ? '' : ' hidden-tr';
        return '<div class="q"><span class="heard"' +
               (L.furigana && n.ruby ? ' style="line-height:2"' : '') + '>• ' + heard + '</span>' +
               '<span class="gloss' + hide + '" title="' + escapeHTML(gloss) + '">' +
               escapeHTML(gloss) + '</span></div>';
      }));
    nb.innerHTML = rows.length ? rows.join('')
      : '<div class="q muted">Nothing yet. Ask around — somebody here wants something.</div>';
    Array.prototype.forEach.call(nb.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  /* --------------------------------------------------------------- shops
     The villager decides a sale has happened; this makes it real. Their price
     stands as long as it is not wild, because the haggling is the point. */
  function commerce(npc, act, itemId, price) {
    const d = npc.def;
    if (!atWork(npc)) return false;
    const id = String(itemId || '').replace(/[^\w]/g, '');
    if (!LG.ITEMS[id] || id === 'coins') return false;
    const base = act === 'sell'
      ? priceFrom(d.sells, d.sellsTags, id, 1)
      : priceFrom(d.buys, d.buysTags, id, 0.5);
    if (!base) return false;

    let cost = Math.round(Number(price));
    if (!isFinite(cost) || cost < 0) cost = base;
    cost = Math.max(Math.ceil(base * 0.4), Math.min(Math.ceil(base * 2.5), cost));  // a haggle, not a fleecing

    if (act === 'sell') {
      if (count('coins') < cost) return false;
      take('coins', cost);
      give(id, 1);
      log('\u00a4 Bought ' + LG.ITEMS[id].full + ' from ' + d.name + ' for ' + cost + '.');
    } else {
      if (count(id) < 1) return false;
      take(id, 1);
      give('coins', cost);
      log('\u00a4 Sold ' + LG.ITEMS[id].full + ' to ' + d.name + ' for ' + cost + '.');
    }
    npc.memory.push('The traveller ' + (act === 'sell' ? 'bought ' : 'sold me ') + LG.ITEMS[id].en + '.');
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
    state.deeds.push('Gave ' + npc.def.name + ' ' + gave + ', got ' + got + '.');
    log('✔ ' + npc.def.name + ' hands over ' + got + '.');

    // whichever note described this deal is now spent
    state.notes = state.notes.filter(n => {
      const f = plan.facts[n.id];
      return !(f && f.link === (plan.roles[npc.def.id] || {}).link && f.type !== 'opinion');
    });

    if (beast && trade.wants === beast.item) {
      beast.following = false;
      beast.home = npc.def.home;
      beast.tx = npc.tx; beast.ty = npc.ty;
    }
    // the village notices
    npc.memory.push('The traveller brought me ' + gave + '.');

    if ((plan.roles[npc.def.id] || {}).link === 0) win();
    renderHUD();
  }

  function win() {
    state.won = true;
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

    newVillage(null, true);

    LG.time.dayLength = Math.max(1, Number(settings.dayMinutes) || 6) * 60 * 1000;
    const saved = loadClock();
    LG.time.start(saved && saved.day, saved && saved.frac);

    LG.dialogue.init();
    wireUI();
    resize();
    window.addEventListener('resize', resize);

    if (settings.apiKey) { gated = false; }
    else { openSettings(true); }
    showChrome();
    loadVoices();
    requestAnimationFrame(loop);
  }

  /* Roll a fresh errand chain and reset everything that depends on it. */
  function newVillage(seed, quiet) {
    plan = LG.chain.generate({ level: settings.level, seed: seed || null });

    state.inv = { coins: 10 };          // a little money to be going on with
    state.notes = []; state.deeds = []; state.won = false;

    const p = W.nearestOpen(23, 20);
    player = { px: p.x * TILE + TILE / 2, py: p.y * TILE + TILE / 2, dir: 'down',
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

    // the thing at the end of the chain, out in the world somewhere
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
              : 'A new village. Nobody has told you anything yet.');
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
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

    document.getElementById('btnSettings').onclick = () => openSettings(false);
    document.getElementById('btnHelp').onclick = () =>
      document.getElementById('help').classList.toggle('open');
    document.getElementById('helpClose').onclick = () =>
      document.getElementById('help').classList.remove('open');
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
    document.getElementById('setSave').onclick = submitSettings;
    document.getElementById('setProvider').onchange = () => { refreshModelList(); refreshHelperList(); };
    document.getElementById('setHelper').onchange = syncHelperBox;
  }

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
      model: document.getElementById('setModel').value || settings.model,
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
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

    if (voiceChanged) { LG.tts.stop(); loadVoices(); }

    if (gateMode) {
      gated = false;
      gateMode = false;
      showChrome();
      newVillage(null, true);
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
    document.getElementById('setTrans').checked = settings.showTranslation;
    document.getElementById('setChatter').checked = settings.npcChatter;
    document.getElementById('setVoices').checked = settings.voices;
    document.getElementById('setTtsKey').value = settings.ttsKey;
    document.getElementById('setSpeed').value = settings.voiceSpeed;
    document.getElementById('setQuality').value = settings.voiceQuality;
    document.getElementById('setDayLength').value = String(settings.dayMinutes || 6);
    refreshModelList();
    document.getElementById('setModel').value = settings.model;
    refreshHelperList();
    s.classList.add('open');
  }

  /* "Other" reveals a free-text box, so a model newer than this picker can still
     be used without editing the source. */
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
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('');
    document.getElementById('keyHint').textContent = prov === 'anthropic'
      ? 'From console.anthropic.com. Sent straight from your browser to api.anthropic.com.'
      : 'From openrouter.ai/keys.';
  }

  function interact() {
    if (nearby) { LG.dialogue.open(nearby); return; }
    if (beast && !beast.caught && dist(player, beast) < TILE * 1.4) catchBeast();
    else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.4) pickUp();
  }

  /* a note about where something was is no use once it is in your pocket */
  function retireWhereNote() {
    state.notes = state.notes.filter(n => plan.facts[n.id].type !== 'where');
    renderHUD();
  }

  function catchBeast() {
    beast.caught = true; beast.following = true;
    give(beast.item);
    retireWhereNote();
    log(beast.emoji + ' ' + beast.name + ' lets you pick ' + (Math.random() < 0.5 ? 'her' : 'him') + ' up.');
  }
  function pickUp() {
    worldItem.taken = true;
    give(worldItem.item);
    retireWhereNote();
    log(LG.ITEMS[worldItem.item].icon + ' You pick up ' + LG.ITEMS[worldItem.item].full + '.');
  }

  function dist(a, b) { return Math.hypot(a.px - b.px, a.py - b.py); }

  function inRect(a, r) {
    return r && a.tx >= r.x && a.tx < r.x + r.w && a.ty >= r.y && a.ty < r.y + r.h;
  }
  /* Somebody's trade goes with them: the baker will sell you bread on the street
     as readily as across her counter. Only the small hours close the shop. */
  function atWork(n) { return !LG.time.isNight(); }
  /* Whether they are physically at their workplace — flavour, and a fuller stock. */
  function behindTheCounter(n) { return inRect(n, n.work); }

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

  /* Close enough to make out what they are saying? Only decides whether it goes
     in the log — the conversation happens either way. */
  function canOverhear(a, b) {
    return dist(player, a) < TILE * 11 || dist(player, b) < TILE * 11;
  }

  /* Villagers talk to each other wherever they are; this only supplies the news
     being passed. `factId` is the piece of gossip actually changing hands. */
  function villagerTalk(a, b, fromA, fromB) {
    if (!settings.apiKey) return false;
    const text = id => (id && plan.facts[id]) ? plan.facts[id].text : null;
    const aNews = text(fromA), bNews = text(fromB);
    if (!aNews && !bNews) return false;
    /* Whatever else they are each carrying, in case the talk wanders there. A
       villager's own opinion is stored as "Mira thinks Wren talks too much",
       which reads absurdly when you hand it back to Mira — she does not think
       about herself in the third person. */
    const own = (n, text) =>
      text.indexOf(n.def.name + ' thinks ') === 0
        ? 'You think ' + text.slice((n.def.name + ' thinks ').length)
        : text;
    const rest = (n, skip) => n.facts
      .filter(id => id !== skip && plan.facts[id])
      .slice(0, 2)
      .map(id => own(n, plan.facts[id].text))
      .join(' ');
    LG.dialogue.overheard(a, b, {
      aNews: aNews, bNews: bNews,
      aExtra: rest(a, fromA), bExtra: rest(b, fromB)
    });
    return true;
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

  let clockSave = 0;
  function update(dt) {
    if (LG.time.tick(dt)) log('🗓 ' + LG.time.season().name + ', day ' + LG.time.dayOfSeason() + '.');
    clockSave += dt;
    if (clockSave > 10) { clockSave = 0; saveClock(); }
    const el = document.getElementById('clock');
    if (el) el.textContent = LG.time.label();

    movePlayer(dt);

    for (const n of npcs) {
      A.routine(n, dt, LG.GREEN);
      A.walk(n, dt, 34);
      if (n.bubbleT > 0) n.bubbleT -= dt;
    }
    if (settings.npcChatter) {
      LG.dialogue.chatTick(dt);
      A.gossip(npcs, dt, log, LG.dialogue.chatterLine, villagerTalk);
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
      hint.textContent = 'Press E to talk to ' + nearby.def.name;
      hint.classList.add('show');
    } else if (beast && !beast.caught && dist(player, beast) < TILE * 1.8) {
      hint.textContent = 'Press E to pick up ' + beast.name;
      hint.classList.add('show');
    } else if (worldItem && !worldItem.taken && dist(player, worldItem) < TILE * 1.8) {
      hint.textContent = 'Press E to pick it up';
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
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

    const room = W.buildingUnder(player);

    W.drawGround(ctx, cam, vw, vh);
    W.drawBuildings(ctx, room);
    W.drawLabels(ctx);
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
        A.drawCharacter(ctx, a, {
          color: a.def.color, emoji: a.def.emoji, name: a.def.name,
          skin: '#f0c8a0', hair: '#3b2b20'
        });
      }
    }
    for (const a of drawables) {
      if (a.bubble) A.drawBubble(ctx, a, LG.LANGUAGES[settings.lang].fontStack);
    }

    ctx.restore();
    LG.sky.draw(ctx, vw, vh, W.roofRects(cam, vw, vh));

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
           atWork, behindTheCounter,
           _moveDir: moveDir, _isInteract: isInteract,
           canOverhear, logSpeech,
           _debugPlayerAt: (x, y) => { player.px = x; player.py = y; },
           inventoryList, doTrade, commerce, renderHUD, openSettings, uiBlocked, newVillage,
           get plan() { return plan; },
           get npcs() { return npcs; },
           get canvas() { return canvas; } };
})();

window.addEventListener('DOMContentLoaded', () => LG.game.init());
