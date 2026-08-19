/* game.js — state, the main loop, input, the notebook, and settings. */
window.LG = window.LG || {};

LG.game = (function () {
  const W = LG.world, A = LG.actors, TILE = 32;

  const settings = {
    lang: 'ru', level: 'beginner',
    provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5',
    showTranslation: true, npcChatter: true
  };

  // No key, no village. `gated` freezes input until the front door is passed.
  let gated = true, gateMode = false, lastValidated = '';

  const state = { inv: {}, notes: [], deeds: [], won: false };

  let plan = null;                 // the generated errand chain (chain.js)
  let canvas, ctx, cam = { x: 0, y: 0 }, vw = 0, vh = 0;
  let player, npcs = [], beast = null, worldItem = null;
  const keys = {};
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
  function llmConfig() {
    return { provider: settings.provider, apiKey: settings.apiKey.trim(), model: settings.model };
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
  function learn(factId, fromNpc) {
    if (!plan || !plan.facts[factId]) return;
    if (state.notes.indexOf(factId) !== -1) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    state.notes.push(factId);
    log('📓 ' + plan.facts[factId].text);
    renderHUD();
  }

  /* ----------------------------------------------------------------- log */
  function log(msg) {
    logLines.push(msg);
    if (logLines.length > 5) logLines.shift();
    document.getElementById('log').innerHTML =
      logLines.map(l => '<div>' + escapeHTML(l) + '</div>').join('');
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ----------------------------------------------------------------- HUD */
  function renderHUD() {
    const inv = document.getElementById('inv');
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0);
    inv.innerHTML = ks.length
      ? ks.map(k => '<span class="pill" title="' + LG.ITEMS[k].en + '">' + LG.ITEMS[k].icon +
          ' ' + escapeHTML(itemLabel(k)) + (state.inv[k] > 1 ? ' ×' + state.inv[k] : '') + '</span>').join('')
      : '<span class="muted">empty pockets</span>';

    const nb = document.getElementById('notebook');
    const rows = state.deeds.map(d => '<div class="q done">✔ ' + escapeHTML(d) + '</div>')
      .concat(state.notes.map(id => '<div class="q">• ' + escapeHTML(plan.facts[id].text) + '</div>'));
    nb.innerHTML = rows.length ? rows.join('')
      : '<div class="q muted">Nothing yet. Ask around — somebody here wants something.</div>';
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
    state.notes = state.notes.filter(id => {
      const f = plan.facts[id];
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

    LG.dialogue.init();
    wireUI();
    resize();
    window.addEventListener('resize', resize);

    if (settings.apiKey) { gated = false; }
    else { openSettings(true); }
    showChrome();
    requestAnimationFrame(loop);
  }

  /* Roll a fresh errand chain and reset everything that depends on it. */
  function newVillage(seed, quiet) {
    plan = LG.chain.generate({ level: settings.level, seed: seed || null });

    state.inv = {}; state.notes = []; state.deeds = []; state.won = false;

    const p = W.nearestOpen(23, 20);
    player = { px: p.x * TILE + TILE / 2, py: p.y * TILE + TILE / 2, dir: 'down',
               tx: p.x, ty: p.y, bubble: null, bubbleT: 0 };
    npcs = LG.NPCS.map(d => A.makeNPC(d, plan.npcFacts[d.id]));

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
      keys[e.key.toLowerCase()] = true;
      if (['arrowup','arrowdown','arrowleft','arrowright',' '].indexOf(e.key.toLowerCase()) !== -1) e.preventDefault();
      if (e.key.toLowerCase() === 'e' || e.key === ' ') interact();
      if (e.key === 'Escape') closePanels();
    });
    window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

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
    document.getElementById('setSave').onclick = submitSettings;
    document.getElementById('setProvider').onchange = refreshModelList;
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
      showTranslation: document.getElementById('setTrans').checked,
      npcChatter: document.getElementById('setChatter').checked
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
    Object.assign(settings, next);
    saveSettings();
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

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
    refreshModelList();
    document.getElementById('setModel').value = settings.model;
    s.classList.add('open');
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
    state.notes = state.notes.filter(id => plan.facts[id].type !== 'where');
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

  /* ---------------------------------------------------------------- loop */
  function movePlayer(dt) {
    if (uiBlocked()) return;
    let dx = 0, dy = 0;
    if (keys['a'] || keys['arrowleft']) dx -= 1;
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (keys['w'] || keys['arrowup']) dy -= 1;
    if (keys['s'] || keys['arrowdown']) dy += 1;
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
    movePlayer(dt);

    for (const n of npcs) {
      A.wander(n, dt, n.def.home, 34);
      if (n.bubbleT > 0) n.bubbleT -= dt;
    }
    if (settings.npcChatter) A.gossip(npcs, dt, log, LG.dialogue.chatterLine);

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

    W.drawGround(ctx, cam, vw, vh);
    W.drawBuildings(ctx);
    W.drawLabels(ctx);
    drawWorldItem();

    const drawables = npcs.slice();
    if (beast) drawables.push(beast);
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
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  return { init, settings, state, llmConfig, log, learn, give, take, count,
           inventoryList, doTrade, renderHUD, openSettings, uiBlocked, newVillage,
           get plan() { return plan; },
           get npcs() { return npcs; },
           get canvas() { return canvas; } };
})();

window.addEventListener('DOMContentLoaded', () => LG.game.init());
