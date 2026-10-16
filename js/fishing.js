/* fishing.js — a fishing rod at the water's edge.

   Stand on the bank with a rod and press E (or tap the water) to cast: a
   float lands on the water a tile or two out and sits there. Sooner or
   later something takes the bait and the float is pulled under — pull
   back (E again, or a tap) while it's under and you land whatever it
   was. Pull back too soon and there's nothing on the hook; leave it too
   long and it gets away. Before the real bite the float may shiver once
   or twice as something nibbles, and pulling on a nibble is too soon.
   Walking off, frozen water, or handing over the rod reels the line in.

   What bites is LG.CATCHES (data.js): how common each thing is, which
   hour it's about at, and how long it holds the float under — the rare
   ones let go quickest. A catch goes into the pockets like anything else,
   and any villager out of doors close enough to see remembers it.

   The line lives only here and isn't saved: a reload finds you with the
   rod in your pockets and nothing in the water. game.js owns the keys,
   taps, hint and the frame; it asks this module what's going on. */
window.LG = window.LG || {};

LG.fishing = (function () {
  const L = LG.ledger, W = LG.world, TILE = W.TILE, settings = LG.config.settings;
  const ROD = 'fishing_rod';
  const CAST = 2;                  // tiles from where you stand to water you can cast into
  const THROW = 2.6;               // tiles out the float tries to land
  const SEEN = 10;                 // tiles: how far off a villager sees what you land
  const WAIT = [3, 11];            // seconds before anything takes the bait
  const NIBBLE = 0.45;             // seconds a nibble shakes the float
  const DRIFT = 6;                 // px you can shift your feet before the line comes in
  const ICE = 0.5;                 // how much ice (see LG.world.iced) stops a cast

  /* The line in the water, or null: the tile and spot the float is on,
     where you stood to cast, and what it's doing — 'wait', 'nibble' or
     'bite' — with `t` seconds left of that. */
  let line = null;

  const between = (a, b) => a + Math.random() * (b - a);
  const me = () => LG.village.player;
  const label = id => LG.itemName(id, settings.lang);

  /* ---------------------------------------------------------- the bank */
  function frozen() { return W.iced() > ICE; }
  /* The nearest open water within a cast of where the traveller stands,
     or null. Out of doors only; there's no water indoors anyway. */
  function waterNear() { return waterAt(CAST, 0); }
  /* The water tile within `r` tiles whose distance from the traveller is
     closest to `aim` tiles. */
  function waterAt(r, aim) {
    const p = me();
    if (!p || W.buildingUnder(p)) return null;
    let best = null, near = Infinity;
    for (let y = p.ty - r; y <= p.ty + r; y++) for (let x = p.tx - r; x <= p.tx + r; x++) {
      if (W.get(x, y) !== W.T.WATER) continue;
      const d = Math.abs(Math.hypot((x + 0.5) * TILE - p.px, (y + 0.5) * TILE - p.py) - aim * TILE);
      if (d < near) { near = d; best = { x, y }; }
    }
    return best;
  }
  /* Why a cast can't be made right now, or '' if it can: 'line' (one is
     already out), 'rod' (none in your pockets), 'far' (no water within
     reach) or 'ice'. */
  function stopped() {
    if (line) return 'line';
    if (L.count(ROD) < 1) return 'rod';
    if (!waterNear()) return 'far';
    if (frozen()) return 'ice';
    return '';
  }
  const canCast = () => !stopped();
  function isWater(tx, ty) { return W.get(tx, ty) === W.T.WATER; }

  /* -------------------------------------------------------- the line */
  function cast() {
    if (!canCast()) return false;
    // A couple of tiles out from the bank, not at your feet.
    const p = me(), w = waterAt(CAST + 2, THROW);
    line = { tx: w.x, ty: w.y,
             x: (w.x + between(0.3, 0.7)) * TILE, y: (w.y + between(0.35, 0.75)) * TILE,
             fromX: p.px, fromY: p.py,
             phase: 'wait', t: between(WAIT[0], WAIT[1]),
             nibbles: (Math.random() * 3) | 0, fish: null };
    L.txn('🎣', 'cast', {}, {});
    return true;
  }

  /* Something about at this hour, weighted by how common it is. */
  function pick(rnd) {
    const r = rnd || Math.random;
    const hour = LG.time.isNight() ? 'night' : 'day';
    const pool = LG.CATCHES.filter(c => !c.when || c.when === hour);
    let roll = r() * pool.reduce((n, c) => n + c.weight, 0);
    for (const c of pool) { roll -= c.weight; if (roll < 0) return c; }
    return pool[pool.length - 1];
  }

  function reelIn(quiet) {
    if (!line) return;
    line = null;
    if (!quiet) L.txn('🎣', 'reelIn', {}, {});
  }

  /* One step of the line. `paused` (a conversation or panel is open) holds
     everything where it is, so nothing bites while you can't see it. */
  function tick(dt, paused) {
    if (!line) return;
    const p = me();
    if (!p || L.count(ROD) < 1 || frozen() ||
        Math.hypot(p.px - line.fromX, p.py - line.fromY) > DRIFT) { reelIn(); return; }
    if (paused) return;
    line.t -= dt;
    if (line.t > 0) return;
    if (line.phase === 'wait' && line.nibbles > 0) {
      line.nibbles--;
      line.phase = 'nibble'; line.t = NIBBLE;
    } else if (line.phase === 'wait') {
      line.fish = pick();
      line.phase = 'bite'; line.t = line.fish.bite;
    } else if (line.phase === 'nibble') {
      line.phase = 'wait'; line.t = between(0.8, 3.2);
    } else {                                        // left it under too long
      line = null;
      L.txn('💨', 'gotAway', {}, {});
    }
  }

  /* Pulls the rod back. Lands the catch if the float is under, else comes
     up empty. Returns whether there was a line to pull. */
  function pull() {
    if (!line) return false;
    const was = line;
    line = null;
    if (was.phase === 'bite') land(was.fish.id);
    else L.txn('🎣', 'tooSoon', {}, {});
    return true;
  }

  /* Anyone out of doors near enough to see it remembers what came out of
     the water; it's theirs to bring up. */
  function land(id) {
    const it = LG.ITEMS[id], p = me();
    L.give(id, 1);
    L.txn(it.icon, 'landed', { item: label(id) }, { item: it.full });
    LG.village.npcs.filter(n => !W.buildingUnder(n) && Math.hypot(n.px - p.px, n.py - p.py) < SEEN * TILE)
      .forEach(n => LG.actors.remember(n, 'You watched the traveller pull ' + it.full + ' out of the water with a fishing rod.'));
  }

  /* ---------------------------------------------------------- drawing
     The rod in the traveller's hands and the line out to the float, drawn
     over the characters in world coordinates. The float bobs while it
     waits, shivers on a nibble, and is dragged under, ringed with
     ripples, on a bite. */
  function draw(ctx) {
    if (!line) return;
    const p = me(), now = performance.now() / 1000;
    let fx = line.x, fy = line.y + Math.sin(now * 2.2) * 1.2, under = 0;
    if (line.phase === 'nibble') fx += Math.sin(now * 60) * 2;
    if (line.phase === 'bite') { under = 1; fy = line.y + 4; }

    // The rod: from the hands, held up and out toward the float.
    const hx = p.px + (fx >= p.px ? 6 : -6), hy = p.py - 12;
    const ang = Math.atan2(fy - hy, fx - hx);
    const tipX = hx + Math.cos(ang) * 22, tipY = hy + Math.sin(ang) * 22 - 14;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7a4e26'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tipX, tipY); ctx.stroke();

    // The line, sagging a little toward the water.
    ctx.strokeStyle = 'rgba(245,245,240,.8)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.quadraticCurveTo((tipX + fx) / 2, Math.max(tipY, fy) + 6, fx, fy - 3);
    ctx.stroke();

    if (under) {
      const r = (now * 1.6) % 1;
      [r, (r + 0.5) % 1].forEach(k => {
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.7 * (1 - k)).toFixed(3) + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(fx, fy, 4 + k * 12, 2 + k * 5, 0, 0, Math.PI * 2); ctx.stroke();
      });
    }
    // The float: red over white, or just the tip of it once it's pulled under.
    ctx.globalAlpha = under ? 0.55 : 1;
    ctx.fillStyle = '#f4f1ea';
    ctx.beginPath(); ctx.arc(fx, fy, 3.5, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#d63a2f';
    ctx.beginPath(); ctx.arc(fx, fy, 3.5, Math.PI, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  return { out: () => !!line, canCast, stopped, isWater, cast, pull, tick, draw, pick,
           get phase() { return line ? line.phase : null; },
           // for the tests: skip to the next thing the float does
           _debugSkip: () => { if (line) line.t = 0; },
           _debugNibbles: n => { if (line) line.nibbles = n; } };
})();
