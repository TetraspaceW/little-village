/* npc.js — villager/creature state, movement, meetings, and rendering. */
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
      coins: 3 + ((Math.random() * 9) | 0),   // a purse of their own
      stock: {},                        // goods in hand, however they came by them
      history: [],                      // recent dialogue turns with the player
      bubble: null, bubbleT: 0,
      gossipCool: 5 + Math.random() * 10,
      metPlayer: false, tradeDone: false,
      /* Whether the player has actually been told this villager's name —
         see LG.game.displayName. Distinct from metPlayer: they can have
         talked without a name ever being exchanged. */
      nameKnown: false,
      patch: def.home,          // rectangle they currently wander within
      route: null,              // path currently being walked, if any
      routeCool: 4 + Math.random() * 20
    };
  }

  /* Creates an animal that wanders within its home patch until caught. */
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

  /* Decides where a villager should be and walks them there.

     The actual decision is made by the helper model (see LG.llm.intent).
     This function's job is only to notice a decision is due, request one,
     and execute the resulting walk. `decide` is injected by the caller
     (game.js) so this module doesn't depend on the API layer.

     A decision is only requested when something has actually changed
     (arrived, hour changed, weather changed, or learned a new fact) — a
     villager with no reason to move isn't asked, so idle villagers cost
     nothing. PHASE_TABLE below is the fallback used with no API key or on
     a failed call. */
  const PHASE_TABLE = {
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

  /* Builds a string key summarizing the villager's current situation; a
     change in this key is what triggers reconsidering their location (see
     routine() below). The last term is a periodic timer (RETHINK seconds)
     so villagers reconsider occasionally even with nothing else changed —
     without it, a villager who settled at midday would stay put until
     dusk regardless of anything else happening around them. */
  const RETHINK = 45;                             // seconds between periodic reconsiderations
  function situation(a) {
    return LG.time.phase().id + '|' + (LG.time.info.name || '') + '|' +
           (a.patch ? a.patch.x + ',' + a.patch.y : '-') + '|' + a.facts.length +
           '|' + Math.floor((a.lived || 0) / RETHINK);
  }

  function routine(a, dt, green, decide) {
    if (a.frozen) { a.route = null; return; }
    if (a.route && a.route.length) return;          // still walking a previous route

    a.lived = (a.lived || 0) + dt;
    a.routeCool -= dt;
    if (a.decideCool > 0) a.decideCool -= dt;
    if (a.routeCool > 0) return;

    const now = situation(a);
    if (a.thought === now && !a.wantsGo) return;    // situation() unchanged — nothing to do
    a.routeCool = 6 + Math.random() * 8;

    let want = a.wantsGo;                           // a decision that arrived asynchronously earlier
    if (want) { a.wantsGo = null; a.thought = now; }
    else if (a.deciding) {
      // An async decide() call may never resolve — don't let that freeze the
      // villager in place indefinitely; give up on it after 12s. Timed off
      // `lived`, which runs every tick: this branch only runs every
      // routeCool seconds, so adding `dt` here would take hours to get there.
      if (a.lived - (a.decideSince || 0) < 12) return;
      a.deciding = false;
    }
    else {
      a.thought = now;
      // Request a decision if possible; the result lands in a.wantsGo and
      // is picked up next tick. If decide() declines (rate-limited, no key,
      // etc.), fall back to the PHASE_TABLE dice roll immediately instead
      // of leaving the villager standing still.
      if (decide && decide(a, green)) { a.deciding = true; a.decideSince = a.lived; return; }
      want = byDice(a, green);
    }
    /* Picking the patch they already have only means "stay put" if
       they're actually standing in it. A route cut short (two villagers
       stopping to chat, the player talking to them, a chase, a reload)
       leaves `patch` pointing at where they were headed; without the
       inRect check, choosing that place again would leave them standing
       in the street for good, since wander() won't step outside it. */
    if (!want || (want === a.patch && W.inRect(a, want))) return;

    /* Find a walkable point inside the target patch — "open" tile isn't
       the same as "reachable": e.g. the woodcutter Ilya's home patch is in
       forest clearings, where roughly a third of tiles have no path in
       from outside. A single random-point attempt would regularly fail
       and leave him stuck. Retry a few random points before giving up. */
    let route = null;
    for (let tries = 0; tries < 8 && !route; tries++) {
      const cx = want.x + (Math.random() * want.w | 0);
      const cy = want.y + (Math.random() * want.h | 0);
      const spot = W.nearestOpen(cx, cy);
      const path = W.pathTo(a.tx, a.ty, spot.x, spot.y);
      if (path && path.length) route = path;
    }
    if (route) { a.route = route; a.patch = want; }
    // No reachable point found — clear `thought` so situation() is treated
    // as changed next tick, letting the villager try a different target
    // instead of getting stuck standing still.
    else a.thought = null;
  }

  /* Follows the current route if any; otherwise wanders within the current patch. */
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

  /* ------------------------------------------------------------- gossip */
  /* Makes two nearby idle villagers stop and talk to each other.

     There's no separate fact-transfer mechanic here — this function just
     triggers the conversation (via `onChat`, or a mimed bubble if no LLM
     call is available). What each villager takes away from the
     conversation is determined afterwards from what was actually said —
     see LG.llm.recall. So if the conversation happens to mention Ilya's
     dog, the other villager now knows about the dog; if it's just about
     the weather, nothing is retained. */
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
          log(LG.game.displayName(a) + ' and ' + LG.game.displayName(b) + ' stopped for a word.');
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

  /* A character is three layers: a shadow and a name tag that stay put,
     and between them a body that bobs. Each is painted by one of these,
     into a sprite (see drawCharacter) or, with no canvas for one, live. */
  function paintShadow(ctx, x, y) {
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(x, y + 12, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  function paintBody(ctx, a, opts, x, y) {
    if (a.isBeast) {
      // A halo behind the emoji so a creature reads clearly against grass,
      // dirt, or shadow — without one, small dark-colored animals all but
      // vanish into the green.
      ctx.fillStyle = 'rgba(253,246,232,.55)';
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill();

      // fillText draws an emoji at whatever alpha fillStyle last carried, not
      // just its color — left at the halo's .55 (or the shadow's .22 before
      // that), the animal itself came out translucent. Full alpha, opaque.
      ctx.fillStyle = '#000';
      ctx.font = '30px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(a.emoji, x, y + 11);
      return;
    }

    const c = opts.color;
    // body
    ctx.fillStyle = c;
    roundRect(ctx, x - 8, y - 6, 16, 18, 5); ctx.fill();
    // arms
    ctx.fillStyle = shade(c, -18);
    ctx.fillRect(x - 11, y - 3, 3, 10);
    ctx.fillRect(x + 8, y - 3, 3, 10);
    // head
    ctx.fillStyle = opts.skin || '#f0c8a0';
    ctx.beginPath(); ctx.arc(x, y - 13, 8.5, 0, Math.PI * 2); ctx.fill();
    // hair
    ctx.fillStyle = opts.hair || '#4a3728';
    ctx.beginPath();
    ctx.arc(x, y - 15, 8.5, Math.PI * (a.dir === 'up' ? 0 : 1), Math.PI * (a.dir === 'up' ? 2 : 2));
    ctx.fill();
    // eyes (not when facing away)
    if (a.dir !== 'up') {
      ctx.fillStyle = '#2b2118';
      const off = a.dir === 'left' ? -2 : a.dir === 'right' ? 2 : 0;
      ctx.beginPath(); ctx.arc(x - 3 + off, y - 12, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 3 + off, y - 12, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    // role badge
    if (opts.emoji) {
      ctx.font = '14px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(opts.emoji, x + 13, y - 16);
    }
  }

  // `top` is the tag's top edge: 38 px above a villager's anchor, 22 above an animal's.
  const TAG_FONT = '600 11px system-ui';
  function paintName(ctx, name, x, top) {
    ctx.font = TAG_FONT; ctx.textAlign = 'center';
    const w = ctx.measureText(name).width + 10;
    ctx.fillStyle = 'rgba(28,24,20,.6)';
    roundRect(ctx, x - w / 2, top, w, 15, 7); ctx.fill();
    ctx.fillStyle = '#fdf6e8';
    ctx.fillText(name, x, top + 11);
  }

  /* Characters and bubbles are stamped from sprites. Drawn live, a character
     was ~10 path fills and two text draws a frame and a bubble re-wrapped
     its text every frame: ~0.4 ms each for the village and four bubbles in
     Firefox. Bodies are shared by look and facing; a name tag or bubble
     belongs to its character and is repainted when its text changes.
     Painted at device resolution, and stamped one texel to a device pixel
     at whole device pixels (as in world.js). A body's bob is under a pixel,
     so it has a sprite per quarter of a device pixel down, painted that far
     into it; drawn smoothed at its fractional height instead, walking
     villagers cost half again as much. sprite() returns null with no
     canvas to paint into, and the caller paints live. */
  function sprite(w, h, ox, oy, d, paint) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * d); canvas.height = Math.ceil(h * d);
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g || typeof g.arc !== 'function') return null;
    g.setTransform(d, 0, 0, d, 0, 0);
    paint(g, ox, oy);
    return { canvas, w: canvas.width / d, h: canvas.height / d, ox, oy };
  }
  function snap(v, d) { return Math.round(v * d) / d; }
  function stamp(ctx, s, x, y, d) {
    ctx.drawImage(s.canvas, snap(x - s.ox, d), snap(y - s.oy, d), s.w, s.h);
  }

  // Body sprite boxes: width, height, and where the anchor sits. Room for the
  // emoji, as a badge's glyph or an animal's can overhang its nominal size.
  const BEAST_BOX = [52, 54, 26, 28], PERSON_BOX = [48, 54, 16, 37], BOB_STEPS = 4;
  const bodies = new Map(), tags = new WeakMap(), bubbles = new WeakMap();
  let bodiesDpr = 0, shadow = null;
  function bodySprite(a, opts, d, step) {
    if (d !== bodiesDpr) { bodies.clear(); shadow = null; bodiesDpr = d; }
    if (!shadow) shadow = sprite(24, 12, 12, -6, d, (g, x, y) => paintShadow(g, x, y));
    const key = (a.isBeast ? 'beast|' + a.emoji
                           : [opts.color, opts.skin, opts.hair, opts.emoji, a.dir].join('|')) + '|' + step;
    if (!bodies.has(key)) {
      const [w, h, ox, oy] = a.isBeast ? BEAST_BOX : PERSON_BOX, down = step / (BOB_STEPS * d);
      bodies.set(key, sprite(w, h, ox, oy, d, (g, x, y) => paintBody(g, a, opts, x, y + down)));
    }
    return shadow && bodies.get(key);
  }
  function tagSprite(ctx, a, name, d) {
    const key = name + '|' + d, had = tags.get(a);
    if (had && had.key === key) return had.s;
    ctx.font = TAG_FONT;
    const w = 2 * Math.ceil((ctx.measureText(name).width + 10) / 2) + 4;
    const s = sprite(w, 17, w / 2, 1, d, (g, x, top) => paintName(g, name, x, top));
    tags.set(a, { key, s });
    return s;
  }

  function drawCharacter(ctx, a, opts, dpr) {
    const x = a.px, y = a.py, name = opts && opts.name;
    const bob = a.frozen ? 0 : Math.sin(performance.now() / 220 + x) * 0.8;
    const top = y - (a.isBeast ? 22 : 38);
    // The body sprite's top edge in device pixels, split into a whole pixel and quarters.
    const edge = dpr ? (y + bob - (a.isBeast ? BEAST_BOX : PERSON_BOX)[3]) * dpr : 0;
    let row = Math.floor(edge), step = Math.round((edge - row) * BOB_STEPS);
    if (step === BOB_STEPS) { row++; step = 0; }
    const body = dpr ? bodySprite(a, opts, dpr, step) : null;
    const tag = body && name ? tagSprite(ctx, a, name, dpr) : null;
    if (!body || (name && !tag)) {
      paintShadow(ctx, x, y);
      paintBody(ctx, a, opts, x, y + bob);
      if (name) paintName(ctx, name, x, top);
      return;
    }
    stamp(ctx, shadow, x, y, dpr);
    ctx.drawImage(body.canvas, snap(x - body.ox, dpr), row / dpr, body.w, body.h);
    if (tag) stamp(ctx, tag, x, top, dpr);
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* Wraps a bubble's text to 190 px: its lines, and the bubble's size. */
  const LINE_H = 17;
  function bubbleLayout(ctx, text, font) {
    ctx.font = font;
    const maxW = 190;
    const words = text.split(/(\s+)/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if (ctx.measureText(line + w).width > maxW && line) { lines.push(line.trim()); line = w; }
      else line += w;
    }
    if (line.trim()) lines.push(line.trim());
    const bw = Math.min(maxW, Math.max.apply(null, lines.map(l => ctx.measureText(l).width))) + 18;
    return { lines, bw, bh: lines.length * LINE_H + 12 };
  }

  // The bubble's tail points at (x, y - 38).
  function paintBubble(ctx, L, font, x, y) {
    const bx = x - L.bw / 2, by = y - 46 - L.bh;
    ctx.fillStyle = '#fdf8ec';
    roundRect(ctx, bx, by, L.bw, L.bh, 9); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 6, by + L.bh); ctx.lineTo(x, by + L.bh + 8); ctx.lineTo(x + 6, by + L.bh);
    ctx.closePath(); ctx.fill();
    ctx.font = font; ctx.fillStyle = '#2b2118'; ctx.textAlign = 'center';
    L.lines.forEach((l, i) => ctx.fillText(l, x, by + 20 + i * LINE_H));
  }

  /* A sprite fades as one piece; drawn live, the text faded over an
     already-faded bubble. */
  function drawBubble(ctx, a, font, dpr) {
    if (!a.bubble || a.bubbleT <= 0) return;
    const f = '13px ' + (font || 'system-ui');
    let s = null;
    if (dpr) {
      const key = f + '\n' + a.bubble + '\n' + dpr, had = bubbles.get(a);
      if (had && had.key === key) s = had.s;
      else {
        const L = bubbleLayout(ctx, a.bubble, f), w = 2 * Math.ceil(L.bw / 2) + 2;
        s = sprite(w, L.bh + 10, w / 2, L.bh + 47, dpr, (g, x, y) => paintBubble(g, L, f, x, y));
        bubbles.set(a, { key, s });
      }
    }
    ctx.globalAlpha = Math.min(1, a.bubbleT);
    if (s) stamp(ctx, s, a.px, a.py, dpr);
    else paintBubble(ctx, bubbleLayout(ctx, a.bubble, f), f, a.px, a.py);
    ctx.globalAlpha = 1;
  }

  return { makeNPC, makeCreature, wander, walk, routine, stepTowards, meet, drawCharacter, drawBubble, roundRect };
})();
