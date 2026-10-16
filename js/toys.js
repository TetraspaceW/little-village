/* toys.js — the things in the pockets that are for playing with: the die,
   which rolls a d20 in a panel of its own; the ball, which is put down and
   kicked about by walking into it; and the kite, which goes up only on a
   windy day out of doors and trails along after you.

   pockets.js decides when one is used (`roll`, `ball`, `kite`); whether a
   toy is out of the pockets is ledger state (`out`), so handing it over
   puts it away. Where the ball and kite are, and how they move, is kept
   here and isn't saved: a toy that was out is back in the pockets after a
   reload. game.js calls `update` once a frame after moving the traveller,
   and `drawGround`/`drawSky` in the world's own coordinates. */
window.LG = window.LG || {};

LG.toys = (function () {
  const L = LG.ledger, W = LG.world, TILE = W.TILE, settings = LG.config.settings;
  const state = L.state;
  const SIGHT = 12;                    // tiles: how far off a villager sees the kite go up

  const say = (id, key, native, english) => L.txn(LG.ITEMS[id].icon, key, native || {}, english || {});

  /* --------------------------------------------------------------- the die */
  const D20 = 20;
  let rolling = false;

  /* A d20 seen face on: the hexagon of its outline, the triangle facing
     you with the number on it, and the edges between. */
  const HEX = [[50, 3], [91, 26.5], [91, 73.5], [50, 97], [9, 73.5], [9, 26.5]];
  const TRI = [[50, 24], [77, 70], [23, 70]];
  const EDGES = [[0, 0], [0, 1], [0, 5], [1, 1], [1, 2], [1, 3], [2, 3], [2, 4], [2, 5]];
  function faceSVG(n) {
    const lang = LG.config.language(), text = LG.numeral(n, settings.lang);
    const pts = a => a.map(p => p.join(',')).join(' ');
    // Toki pona counts in words (luka luka luka tu), two to a line to fit the face.
    const words = text.split(' '), lines = [];
    for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(' '));
    // Roughly how wide each line is in ems: a Chinese numeral is square, a digit or a letter about half that.
    const ems = l => Array.from(l).reduce((w, ch) => w + (/[\u3000-\u9fff]/.test(ch) ? 1 : 0.58), 0);
    const size = Math.min(22, 34 / Math.max.apply(null, lines.map(ems)));
    const y0 = 56 - (lines.length - 1) * size * 0.55 + size * 0.35;
    return '<svg viewBox="0 0 100 100" class="d20" role="img" aria-label="' + n + '">' +
      '<polygon class="d20-side" points="' + pts(HEX) + '"/>' +
      '<polygon class="d20-face" points="' + pts(TRI) + '"/>' +
      EDGES.map(([t, h]) => '<line x1="' + TRI[t][0] + '" y1="' + TRI[t][1] +
                            '" x2="' + HEX[h][0] + '" y2="' + HEX[h][1] + '"/>').join('') +
      '<text lang="' + lang.tag + '" x="50" text-anchor="middle" font-size="' + size.toFixed(1) + '">' +
      lines.map((l, i) => '<tspan x="50" y="' + (y0 + i * size * 1.1).toFixed(1) + '">' +
                          LG.text.escapeHTML(l) + '</tspan>').join('') +
      '</text></svg>';
  }
  function show(n, turn) {
    const box = document.getElementById('diceFace');
    box.innerHTML = faceSVG(n);
    box.style.transform = 'rotate(' + (turn || 0) + 'deg)';
  }

  function openDice() {
    const panel = document.getElementById('dice');
    document.getElementById('diceClose').onclick = () => panel.classList.remove('open');
    document.getElementById('diceRoll').onclick = () => roll();
    if (!rolling) show(D20);
    panel.classList.add('open');
  }

  /* Tumbles through a dozen faces, slowing, then lands on the roll and
     says it. Returns the roll; `settle` is for the tests, which don't wait. */
  function roll(settle) {
    if (rolling) return 0;
    const n = 1 + Math.floor(Math.random() * D20);
    const button = document.getElementById('diceRoll');
    const land = () => {
      rolling = false; button.disabled = false;
      show(n, 0);
      say('dice', 'roll', { n: LG.numeral(n, settings.lang) }, { n: String(n) });
    };
    if (settle) { land(); return n; }
    rolling = true; button.disabled = true;
    let k = 0;
    const tumble = () => {
      if (++k > 12) return land();
      show(1 + Math.floor(Math.random() * D20), (Math.random() - 0.5) * 160);
      setTimeout(tumble, 30 + k * k * 3);
    };
    tumble();
    return n;
  }

  /* ------------------------------------------------------------- the ball
     The ball is a circle of radius R rolling on the tiles. It moves in
     steps of at most STEP pixels, one axis at a time, and an axis that
     would put it into a wall is reversed and loses half its speed there
     instead of moving: so it never ends up inside a wall to be pushed
     back out, which is what makes a ball judder. A bounce too slow to
     see is no bounce. */
  const R = 6, STEP = 3;
  const KICK = 330;                   // px/s, before the runner's own speed is added
  const BOUNCE = 0.5, DEAD = 28;      // keep half the speed off a wall; slower than DEAD stops
  const FRICTION = 1.6;               // per second, as an exponential decay
  const FOOT = 8;                     // px: the traveller's feet, from their middle
  const KICK_COOL = 0.2;              // s before the same ball can be kicked again
  const ball = { px: 0, py: 0, vx: 0, vy: 0, spin: 0, cool: 0 };

  function blocked(x, y) {
    for (const [ox, oy] of [[-R, -R], [R, -R], [-R, R], [R, R]])
      if (W.isSolid(Math.floor((x + ox) / TILE), Math.floor((y + oy) / TILE))) return true;
    return false;
  }
  const ballOut = () => !!state.out.ball && L.count('ball') > 0;

  // At the traveller's feet, a little ahead of them, or as close as there's room for.
  function putDown(me) {
    const ahead = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[me.dir] || [0, 1];
    for (const d of [18, 12, 6, 0]) {
      const x = me.px + ahead[0] * d, y = me.py + FOOT + ahead[1] * d;
      if (!blocked(x, y)) { Object.assign(ball, { px: x, py: y, vx: 0, vy: 0, cool: KICK_COOL }); return true; }
    }
    return false;
  }
  function nearBall(me) {
    return ballOut() && Math.hypot(ball.px - me.px, ball.py - me.py - FOOT) < TILE * 1.4;
  }

  /* Puts the ball down, or picks it back up from beside you. */
  function useBall() {
    const me = LG.village.player;
    if (!me) return false;
    if (ballOut()) {
      if (!nearBall(me)) { L.log('The ball is over there. Walk over to it to pick it up.'); return false; }
      delete state.out.ball;
      say('ball', 'ballUp');
    } else {
      if (!putDown(me)) { L.log('There is no room to put the ball down here.'); return false; }
      state.out.ball = true;
      say('ball', 'ballDown');
    }
    L.render();
    return true;
  }

  /* Walking into the ball kicks it the way you're walking. Only a walk
     towards it counts, and not again for KICK_COOL, so the ball can't be
     kicked twice in a frame or caught between your feet and a wall: the
     part of a kick that would go into a wall it's touching is dropped, so
     a ball against a wall slides along it or stays put. */
  function kick(me) {
    const speed = Math.hypot(me.vx || 0, me.vy || 0);
    if (!speed || ball.cool > 0) return;
    const fx = me.px, fy = me.py + FOOT, dx = ball.px - fx, dy = ball.py - fy;
    if (Math.hypot(dx, dy) > R + FOOT) return;
    let ux = me.vx / speed, uy = me.vy / speed;
    if (dx * ux + dy * uy < 0) return;                     // walking away from it
    if (ux && blocked(ball.px + Math.sign(ux) * 2, ball.py)) ux = 0;
    if (uy && blocked(ball.px, ball.py + Math.sign(uy) * 2)) uy = 0;
    if (!ux && !uy) return;
    const len = Math.hypot(ux, uy), v = KICK + speed * 0.5;
    ux /= len; uy /= len;
    if (ball.vx * ux + ball.vy * uy >= v) return;          // already going that way, faster
    ball.vx = ux * v; ball.vy = uy * v;
    ball.cool = KICK_COOL;
  }

  function roll1(dt) {
    const speed = Math.hypot(ball.vx, ball.vy);
    if (!speed) return;
    const n = Math.ceil(speed * dt / STEP), h = dt / n;
    for (let i = 0; i < n; i++) {
      const nx = ball.px + ball.vx * h;
      if (blocked(nx, ball.py)) ball.vx = Math.abs(ball.vx * BOUNCE) < DEAD ? 0 : -ball.vx * BOUNCE;
      else ball.px = nx;
      const ny = ball.py + ball.vy * h;
      if (blocked(ball.px, ny)) ball.vy = Math.abs(ball.vy * BOUNCE) < DEAD ? 0 : -ball.vy * BOUNCE;
      else ball.py = ny;
    }
    const keep = Math.exp(-FRICTION * dt);
    ball.vx *= keep; ball.vy *= keep;
    if (Math.hypot(ball.vx, ball.vy) < DEAD / 2) ball.vx = ball.vy = 0;
    ball.spin += (ball.vx >= 0 ? 1 : -1) * Math.hypot(ball.vx, ball.vy) * dt / R;
  }

  /* -------------------------------------------------------------- the kite
     It goes up only in a wind (see `wind` on LG.time.WEATHER) and out of
     doors. While it's up it hangs downwind and above you on a spring, so
     it lags behind when you set off and swings round after you; it comes
     down by itself when the wind drops or you go in. */
  const WINDY = 1.5;
  const kite = { x: 0, y: 0, vx: 0, vy: 0, t: 0 };
  const kiteUp = () => !!state.out.kite && L.count('kite') > 0;
  const windy = () => ((LG.time.info && LG.time.info.wind) || 0) >= WINDY;
  const hand = me => ({ x: me.px + 7, y: me.py - 14 });

  function useKite() {
    const me = LG.village.player;
    if (!me) return false;
    if (kiteUp()) { delete state.out.kite; say('kite', 'kiteIn'); L.render(); return true; }
    if (W.buildingUnder(me)) { L.log('There is no flying a kite indoors.'); return false; }
    if (!windy()) { L.log('There isn\'t the wind for a kite today.'); return false; }
    const h = hand(me);
    Object.assign(kite, { x: h.x, y: h.y, vx: 0, vy: 0, t: 0 });
    state.out.kite = true;
    say('kite', 'kiteUp');
    LG.village.npcs.filter(n => !W.buildingUnder(n) && Math.hypot(n.px - me.px, n.py - me.py) < SIGHT * TILE)
      .forEach(n => LG.actors.remember(n, 'You saw the traveller flying a kite.'));
    L.render();
    return true;
  }

  function fly(me, dt) {
    if (W.buildingUnder(me)) { delete state.out.kite; say('kite', 'kiteIn'); L.render(); return; }
    if (!windy()) { delete state.out.kite; say('kite', 'kiteFalls'); L.render(); return; }
    kite.t += dt;
    const h = hand(me);
    const tx = h.x + 70 + Math.sin(kite.t * 1.3) * 12, ty = h.y - 110 + Math.cos(kite.t * 0.9) * 8;
    kite.vx += (6 * (tx - kite.x) - 3 * kite.vx) * dt;
    kite.vy += (6 * (ty - kite.y) - 3 * kite.vy) * dt;
    kite.x += kite.vx * dt; kite.y += kite.vy * dt;
  }

  /* ---------------------------------------------------------- each frame */
  function update(dt) {
    const me = LG.village.player;
    if (!me) return;
    if (ballOut()) {
      if (ball.cool > 0) ball.cool -= dt;
      kick(me);
      roll1(dt);
    }
    if (kiteUp()) fly(me, dt);
  }

  // Seen like anyone else: not inside a building you aren't in.
  function drawGround(ctx, room) {
    if (!ballOut()) return;
    const inside = W.buildingUnder({ px: ball.px, py: ball.py, tx: Math.floor(ball.px / TILE), ty: Math.floor(ball.py / TILE) });
    if (inside && inside !== room) return;
    ctx.save();
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(ball.px, ball.py + R - 1, R + 1, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = '#000';
    ctx.translate(ball.px, ball.py);
    ctx.rotate(ball.spin);
    ctx.font = (R * 2 + 3) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(LG.ITEMS.ball.icon, 0, 1);
    ctx.restore();
  }

  // The kite and its string, over everyone's heads.
  function drawSky(ctx) {
    if (!kiteUp()) return;
    const h = hand(LG.village.player);
    ctx.save();
    ctx.globalAlpha = 1; ctx.fillStyle = '#000';
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(h.x, h.y);
    ctx.quadraticCurveTo((h.x + kite.x) / 2 + 10, Math.max(h.y, kite.y) - 10, kite.x, kite.y + 10);
    ctx.stroke();
    ctx.translate(kite.x, kite.y);
    ctx.rotate(Math.max(-0.5, Math.min(0.5, kite.vx / 200)));
    ctx.font = '26px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(LG.ITEMS.kite.icon, 0, 0);
    ctx.restore();
  }

  return { openDice, roll, useBall, useKite, nearBall, update, drawGround, drawSky, windy,
           // for the tests: where the ball is, and putting it somewhere by hand
           _ball: ball, _kite: kite, _face: faceSVG, _blocked: blocked };
})();
