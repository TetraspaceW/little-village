/* npc.js — the little guys: wandering, memory, gossip, and how they're drawn. */
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
      memory: [],                       // free-form things the player told them
      history: [],                      // recent dialogue turns with the player
      bubble: null, bubbleT: 0,
      gossipCool: 5 + Math.random() * 10,
      metPlayer: false, tradeDone: false
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
  function gossip(npcs, dt, log, chatterLine) {
    for (const a of npcs) a.gossipCool -= dt;
    for (let i = 0; i < npcs.length; i++) {
      for (let j = i + 1; j < npcs.length; j++) {
        const a = npcs[i], b = npcs[j];
        if (a.frozen || b.frozen || a.gossipCool > 0 || b.gossipCool > 0) continue;
        if (Math.hypot(a.px - b.px, a.py - b.py) > TILE * 2.2) continue;
        a.gossipCool = b.gossipCool = 22 + Math.random() * 25;
        const fromA = pickFact(a), fromB = pickFact(b);
        let said = false;
        if (fromA && b.facts.indexOf(fromA) === -1) { b.facts.push(fromA); said = true; }
        if (fromB && a.facts.indexOf(fromB) === -1) { a.facts.push(fromB); said = true; }
        if (said) {
          a.bubble = chatterLine(); a.bubbleT = 3.5;
          b.bubble = chatterLine(); b.bubbleT = 3.5;
          log(a.def.name + ' and ' + b.def.name + ' swapped news.');
        }
      }
    }
  }

  function pickFact(a) {
    if (!a.facts.length) return null;
    return a.facts[(Math.random() * a.facts.length) | 0];
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

  return { makeNPC, makeCreature, wander, stepTowards, gossip, drawCharacter, drawBubble, roundRect };
})();
