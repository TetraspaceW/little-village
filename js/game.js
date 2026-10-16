/* game.js — the main loop and drawing, input, the noticeboard, and the
   errand's own trades; it starts everything else up. The village itself
   lives in village.js, the player's record in ledger.js, coin sales in
   trade.js, the settings in config.js and their panel in settings-panel.js. */
window.LG = window.LG || {};

LG.game = (function () {
  const W = LG.world, A = LG.actors, TILE = 32;
  const { displayName, nameOrEmoji, remember, think } = A;
  const { escapeHTML } = LG.text;
  const { give, take, learn, log, txn } = LG.ledger;
  const renderHUD = LG.ledger.render;

  const C = LG.config, settings = C.settings;
  const P = LG.settingsPanel;

  const state = LG.ledger.state;

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
  /* The village itself lives in LG.village. These are this module's
     handles on it, for brevity in the loop and drawing code below; only
     adopt() rebinds them, straight after LG.village.create, so they can
     never point at a different village than LG.village does. */
  const V = LG.village;
  let plan = null, player = null, npcs = [], beast = null, worldItem = null;
  function adopt() { ({ plan, player, npcs, beast, worldItem } = V); }
  const { factSpent, noticeItemGone } = V;
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
    txn('✔', 'tradeReceive',
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
    C.load();
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d', { alpha: false });      // opaque: see draw()
    W.build();

    /* A saved village resumes where it was left; `resume` restores the
       local copy at once and checks the log server's in the background. */
    if (!LG.save.resume(log)) newVillage(null, true);

    LG.dialogue.init();
    P.init({ newVillage });
    wireUI();
    resize();
    window.addEventListener('resize', resize);
    trackViewport();

    P.start();
    requestAnimationFrame(loop);
  }

  /* Generates a fresh errand chain and resets all state that depends on it.
     `given` is a saved plan from LG.save.restore, which lays the rest of
     the save over the result and must not have the bare village saved
     over it first. */
  function newVillage(seed, quiet, given) {
    V.create(seed, settings.level, given);
    adopt();

    // A random day of the year, and its weather; always mid-morning, never 3am in the dark.
    LG.time.start();

    LG.ledger.begin(plan, factSpent);
    LG.trade.begin(plan);

    renderHUD();
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
      /* Escape is checked ahead of uiBlocked(), since what it closes is
         exactly what blocks the UI: an open panel first (it sits on
         top), else the conversation. Both close on Escape from anywhere,
         not only from inside the conversation's text box. */
      if (isCancel(e)) {
        if (panelOpen()) closePanels();
        else if (LG.dialogue.isOpen()) LG.dialogue.close();
        return;
      }
      if (uiBlocked()) return;
      const dir = moveDir(e);
      if (dir) { held[dir] = true; if (e.code !== 'KeyW' && e.code !== 'KeyA' &&
                 e.code !== 'KeyS' && e.code !== 'KeyD') e.preventDefault(); }
      if (isShift(e)) held.run = true;
      if (isInteract(e)) { e.preventDefault(); interact(); }
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
  }

  /* Before the settings gate is passed, the village behind it is a
     backdrop, and saving it would overwrite a real save. */
  function saving() { return !P.gated && !!plan; }

  function panelOpen() { return !!document.querySelector('.panel.open'); }
  function uiBlocked() { return P.gated || panelOpen() || LG.dialogue.isOpen(); }
  function closePanels() {
    if (P.gated) return;   // Escape does not close the front-door settings panel
    document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  }

  /* A villager who came looking for the player speaks first, as between
     two villagers (see villagerTalk). `wentAfter` is read and cleared
     here, once (LG.view.arrived). */
  function talkTo(n) {
    if (n.asleep) { aside(displayName(n) + ' is asleep.'); return; }
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

  /* Where a villager goes is decided from their goal and what they know
     (Jev or the helper model), not a dice roll; PHASE_TABLE in npc.js is
     the fallback. Asked at most once per DECIDE_COOL seconds. */
  const DECIDE_COOL = 25;

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
    LG.llm.intent(C.llm(), {
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
    const L = C.language();
    const lvl = LG.LEVELS[settings.level] || {};
    think(n, 'wonders whether to pin anything up', '');
    LG.llm.notice(C.llm(), {
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
    const L = C.language();
    LG.llm.judge(C.llm(), text, entry.translation, candidates, { who: n.def.name, langName: L.name })
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
    const L = C.language();
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
    // Someone awake within reach comes before someone asleep nearer by.
    for (const n of npcs) {
      const d = dist(player, n);
      if (d < best && !(nearby && !nearby.asleep && n.asleep)) { best = d; nearby = n; }
      else if (nearby && nearby.asleep && !n.asleep && d < REACH) { best = d; nearby = n; }
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
    } else if (nearby && nearby.asleep) {
      say = displayName(nearby) + ' is asleep';
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
    /* The layer covers the canvas, but it's cleared first anyway: a
       whole-canvas clear lets Firefox drop the last frame instead of
       keeping it to draw over. With the canvas opaque too, this copy fell
       from ~2.4 to ~1.4 ms a frame. The layer itself stays transparent:
       opaque, it gave Chrome a steady run of 11 ms frames, and Firefox
       subpixel-antialiased the sign lettering painted into it. */
    ctx.clearRect(0, 0, vw, vh);
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
        A.drawCharacter(ctx, a, { color: '#2f6fb0', skin: '#f2cba4', hair: '#2b2118', name: 'You', emoji: '🎒' }, dpr);
      } else if (a.isBeast) {
        A.drawCharacter(ctx, a, { name: a.caught ? '' : a.name }, dpr);
      } else {
        // The role emoji is always shown -- only the name is withheld until known.
        const look = {
          color: a.def.color, emoji: a.def.emoji, name: a.nameKnown ? a.def.name : '?',
          skin: '#f0c8a0', hair: '#3b2b20'
        };
        if (a.asleep) A.drawSleeper(ctx, a, look);
        else A.drawCharacter(ctx, a, look, dpr);
      }
    }
    for (const a of drawables) {
      if (a.bubble) A.drawBubble(ctx, a, C.language().fontStack, dpr);
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

  return { init,
           _moveDir: moveDir, _isInteract: isInteract, _tapAt: tapAt,
           get cam() { return cam; },
           _debugPlayerAt: (x, y) => {
             player.px = x; player.py = y;
             player.tx = (x / TILE) | 0; player.ty = (y / TILE) | 0;
           },
           // Bypasses the settings gate without a real API key -- for
           // console debugging and for tests, which need to get past it
           // to test anything behind it. Also un-hides the HUD (not just
           // clearing the gate flag), since the HUD stays hidden while
           // gated -- an invisible village would be a useless test result.
           _debugOpenTheDoor: () => P.openTheDoor(),
           // one turn of the world by hand, for poking at it from the console
           // (and for tests, which cannot rely on requestAnimationFrame)
           _debugTick: dt => update(dt || 1 / 60),
           // Re-runs the viewport measurement, for a test environment
           // with no real keyboard to open and no browser to fire a resize event.
           _debugViewport: () => { readInsets(); measureViewport(); },
           // Returns the resulting visible-canvas band (see seen()).
           _debugSeen: seen,
           doTrade, uiBlocked, newVillage,
           get saving() { return saving(); },
           get canvas() { return canvas; } };
})();

window.addEventListener('DOMContentLoaded', () => LG.game.init());
