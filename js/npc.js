/* npc.js — the little guys: wandering, memory, meeting, and how they're drawn. */
window.LG = window.LG || {};

LG.actors = (function () {
  const W = LG.world, TILE = 32;

  function makeNPC(def, factIds) {
    const spot = W.nearestOpen(def.x, def.y);
    return {
      id: def.id, def,
      px: spot.x * TILE + TILE / 2, py: spot.y * TILE + TILE / 2,
      tx: spot.x, ty: spot.y,
      dir: 'down', frozen: false, pauseT: 1 + Math.random() * 2,
      facts: (factIds || []).slice(),   // ids of things they know (see chain.js)
      memory: [],                       // what they have picked up, from anyone
      history: [],                      // recent dialogue turns with the player
      bubble: null, bubbleT: 0,
      gossipCool: 5 + Math.random() * 10,
      metPlayer: false, tradeDone: false,
      patch: def.home,          // the rectangle they are pottering about in
      route: null,              // a path being walked to somewhere else
      routeCool: 4 + Math.random() * 20
    };
  }

  /* An animal that wanders its patch until somebody picks it up. */
  function makeCreature(spec) {
    const home = spec.home;
    const spot = W.nearestOpen(home.x + (home.w >> 1), home.y + (home.h >> 1));
    return {
      id: 'beast', isBeast: true, item: spec.item, name: spec.name, emoji: spec.emoji,
      px: spot.x * TILE + TILE / 2, py: spot.y * TILE + TILE / 2,
      tx: spot.x, ty: spot.y, dir: 'down', pauseT: 1,
      following: false, caught: false, bubble: null, bubbleT: 0, home
    };
  }

  /* ------------------------------------------------------------ movement */
  function stepTowards(a, speed, dt) {
    const gx = a.tx * TILE + TILE / 2, gy = a.ty * TILE + TILE / 2;
    const dx = gx - a.px, dy = gy - a.py;
    const d = Math.hypot(dx, dy);
    if (d < 1.5) { a.px = gx; a.py = gy; return true; }
    const step = Math.min(d, speed * dt);
    a.px += (dx / d) * step; a.py += (dy / d) * step;
    if (Math.abs(dx) > Math.abs(dy)) a.dir = dx > 0 ? 'right' : 'left';
    else a.dir = dy > 0 ? 'down' : 'up';
    return false;
  }

  /* Villagers keep their own hours: out and about on the green by day, back to
     their own patch at night, and a slow drift between the two in between. */
  /* Where the villager decides to be.

     The decision belongs to the helper model — see LG.llm.intent for why. This
     function's job is to notice that a decision is due, ask for one, and walk
     there. `decide` is supplied by the game so this file stays free of the API.

     A decision is due when something has actually changed: they got where they
     were going, the hour turned, the weather broke, or they learned something.
     A villager with no reason to move does not get asked, and so costs nothing. */
  const PHASE_TABLE = {                 // the fallback, for no key and failed calls
    dawn:      { work: 0.2, green: 0.1 },
    morning:   { work: 0.6, green: 0.3 },
    midday:    { work: 0.4, green: 0.5 },
    afternoon: { work: 0.5, green: 0.4 },
    dusk:      { work: 0.2, green: 0.2 },
    night:     { work: 0.0, green: 0.0 }
  };

  function byDice(a, green) {
    const t = PHASE_TABLE[LG.time.phase().id] || PHASE_TABLE.night;
    if (LG.time.info.indoors) {
      return (a.work && a.workBuilding && Math.random() < 0.6) ? a.work : (a.shelter || a.def.home);
    }
    const r = Math.random();
    if (a.work && r < t.work) return a.work;
    if (r < t.work + t.green) return green;
    return a.def.home;
  }

  /* What has to be true for the world to be worth reconsidering. The last term
     is just the passage of time: people finish what they came to do and think
     again. Without it a villager who settles at midday stands there until dusk,
     and a village where nobody ever changes their mind within an hour is dead. */
  const RETHINK = 45;                             // seconds before it is worth another look
  function situation(a) {
    return LG.time.phase().id + '|' + (LG.time.info.name || '') + '|' +
           (a.patch ? a.patch.x + ',' + a.patch.y : '-') + '|' + a.facts.length +
           '|' + Math.floor((a.lived || 0) / RETHINK);
  }

  function routine(a, dt, green, decide) {
    if (a.frozen) { a.route = null; return; }
    if (a.route && a.route.length) return;          // already on their way

    a.lived = (a.lived || 0) + dt;
    a.routeCool -= dt;
    if (a.decideCool > 0) a.decideCool -= dt;
    if (a.routeCool > 0) return;

    const now = situation(a);
    if (a.thought === now && !a.wantsGo) return;    // nothing has changed; stay put
    a.routeCool = 6 + Math.random() * 8;

    let want = a.wantsGo;                           // a decision that arrived earlier
    if (want) { a.wantsGo = null; a.thought = now; }
    else if (a.deciding) {
      // A call that never comes back must not freeze someone mid-street forever.
      a.deciding += dt;
      if (a.deciding < 12) return;
      a.deciding = false;
    }
    else {
      a.thought = now;
      // If they can be asked, ask; the answer lands in a.wantsGo and they walk
      // next tick. If they were asked too recently, the table covers the gap
      // rather than leaving them standing in the road.
      if (decide && decide(a, green)) { a.deciding = 0.0001; return; }
      want = byDice(a, green);
    }
    if (!want || want === a.patch) return;

    const cx = want.x + (Math.random() * want.w | 0);
    const cy = want.y + (Math.random() * want.h | 0);
    const spot = W.nearestOpen(cx, cy);
    const path = W.pathTo(a.tx, a.ty, spot.x, spot.y);
    if (path && path.length) { a.route = path; a.patch = want; }
    // No way through — forget having thought about it, so they try again rather
    // than standing in the road for the rest of the day.
    else a.thought = null;
  }

  /* Follow a route if we are on one, otherwise potter about the current patch. */
  function walk(a, dt, speed) {
    if (a.frozen) return;
    if (a.route && a.route.length) {
      const step = a.route[0];
      a.tx = step.x; a.ty = step.y;
      if (stepTowards(a, speed, dt)) a.route.shift();
      return;
    }
    a.route = null;
    wander(a, dt, a.patch, speed);
  }

  function wander(a, dt, area, speed) {
    if (a.frozen) return;
    const arrived = stepTowards(a, speed, dt);
    if (!arrived) return;
    a.pauseT -= dt;
    if (a.pauseT > 0) return;
    a.pauseT = 0.6 + Math.random() * 2.6;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = a.tx + dx, ny = a.ty + dy;
      if (area && (nx < area.x || ny < area.y || nx >= area.x + area.w || ny >= area.y + area.h)) continue;
      if (W.isWalkable(nx, ny)) { a.tx = nx; a.ty = ny; return; }
    }
  }

  /* ------------------------------------------------------------- gossip
     Two nearby idle NPCs swap one fact each. This is free (no model call),
     so the village's knowledge really does spread by word of mouth. */
  /* Two villagers run into each other and stop to talk.

     There is no gossip mechanic. Nothing is picked to be transferred and nothing
     changes hands here: they simply talk, and what either of them takes away is
     worked out afterwards from what was actually said — see LG.llm.recall. Ilya
     knows he has a dog; if the dog comes up, whoever he was talking to now knows
     about the dog, and if instead he talks about his back then that is what they
     remember. A conversation that turns out to be nothing but weather leaves
     nothing behind, which is right. */
  function meet(npcs, dt, log, chatterLine, onChat) {
    for (const a of npcs) a.gossipCool -= dt;
    for (let i = 0; i < npcs.length; i++) {
      for (let j = i + 1; j < npcs.length; j++) {
        const a = npcs[i], b = npcs[j];
        if (a.frozen || b.frozen || a.gossipCool > 0 || b.gossipCool > 0) continue;
        if (a.chatting || b.chatting) continue;
        if (Math.hypot(a.px - b.px, a.py - b.py) > TILE * 2.2) continue;
        a.gossipCool = b.gossipCool = 22 + Math.random() * 25;
        a.pauseT = b.pauseT = 4 + Math.random() * 3;      // stop and talk
        a.route = b.route = null;
        faceEachOther(a, b);
        const spoken = onChat && onChat(a, b);
        if (!spoken) {                                     // no key: they mime it
          a.bubble = chatterLine(); a.bubbleT = 5;
          b.bubble = chatterLine(); b.bubbleT = 5;
          log(a.def.name + ' and ' + b.def.name + ' stopped for a word.');
        }
      }
    }
  }

  function faceEachOther(a, b) {
    const dx = b.px - a.px, dy = b.py - a.py;
    if (Math.abs(dx) > Math.abs(dy)) {
      a.dir = dx > 0 ? 'right' : 'left';
      b.dir = dx > 0 ? 'left' : 'right';
    } else {
      a.dir = dy > 0 ? 'down' : 'up';
      b.dir = dy > 0 ? 'up' : 'down';
    }
  }

  /* ------------------------------------------------------------- drawing */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCharacter(ctx, a, opts) {
    const x = a.px, y = a.py;
    const bob = a.frozen ? 0 : Math.sin(performance.now() / 220 + x) * 0.8;

    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(x, y + 12, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill();

    if (a.isBeast) {
      ctx.font = '24px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(a.emoji, x, y + 10 + bob);
      if (opts && opts.name) {
        ctx.font = '600 11px system-ui';
        const w = ctx.measureText(opts.name).width + 10;
        ctx.fillStyle = 'rgba(28,24,20,.6)';
        roundRect(ctx, x - w / 2, y - 22, w, 15, 7); ctx.fill();
        ctx.fillStyle = '#fdf6e8';
        ctx.fillText(opts.name, x, y - 11);
      }
      return;
    }

    const c = opts.color;
    // body
    ctx.fillStyle = c;
    roundRect(ctx, x - 8, y - 6 + bob, 16, 18, 5); ctx.fill();
    // arms
    ctx.fillStyle = shade(c, -18);
    ctx.fillRect(x - 11, y - 3 + bob, 3, 10);
    ctx.fillRect(x + 8, y - 3 + bob, 3, 10);
    // head
    ctx.fillStyle = opts.skin || '#f0c8a0';
    ctx.beginPath(); ctx.arc(x, y - 13 + bob, 8.5, 0, Math.PI * 2); ctx.fill();
    // hair
    ctx.fillStyle = opts.hair || '#4a3728';
    ctx.beginPath();
    ctx.arc(x, y - 15 + bob, 8.5, Math.PI * (a.dir === 'up' ? 0 : 1), Math.PI * (a.dir === 'up' ? 2 : 2));
    ctx.fill();
    // eyes (not when facing away)
    if (a.dir !== 'up') {
      ctx.fillStyle = '#2b2118';
      const off = a.dir === 'left' ? -2 : a.dir === 'right' ? 2 : 0;
      ctx.beginPath(); ctx.arc(x - 3 + off, y - 12 + bob, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 3 + off, y - 12 + bob, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    // role badge
    if (opts.emoji) {
      ctx.font = '14px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(opts.emoji, x + 13, y - 16 + bob);
    }
    // name
    if (opts.name) {
      ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
      const w = ctx.measureText(opts.name).width + 10;
      ctx.fillStyle = 'rgba(28,24,20,.6)';
      roundRect(ctx, x - w / 2, y - 38, w, 15, 7); ctx.fill();
      ctx.fillStyle = '#fdf6e8';
      ctx.fillText(opts.name, x, y - 27);
    }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawBubble(ctx, a, font) {
    if (!a.bubble || a.bubbleT <= 0) return;
    const text = a.bubble;
    ctx.font = '13px ' + (font || 'system-ui');
    const maxW = 190;
    const words = text.split(/(\s+)/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if (ctx.measureText(line + w).width > maxW && line) { lines.push(line.trim()); line = w; }
      else line += w;
    }
    if (line.trim()) lines.push(line.trim());
    const lh = 17;
    const bw = Math.min(maxW, Math.max.apply(null, lines.map(l => ctx.measureText(l).width))) + 18;
    const bh = lines.length * lh + 12;
    const bx = a.px - bw / 2, by = a.py - 46 - bh;
    const alpha = Math.min(1, a.bubbleT);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fdf8ec';
    roundRect(ctx, bx, by, bw, bh, 9); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(a.px - 6, by + bh); ctx.lineTo(a.px, by + bh + 8); ctx.lineTo(a.px + 6, by + bh);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2b2118'; ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, a.px, by + 20 + i * lh));
    ctx.globalAlpha = 1;
  }

  return { makeNPC, makeCreature, wander, walk, routine, stepTowards, meet, drawCharacter, drawBubble, roundRect };
})();
