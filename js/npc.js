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
      // Whether they've told the player their name (displayName below); talking isn't enough.
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

  /* Notices when a villager should decide where to be, asks, and walks them
     there. The decision is Jev's or the helper model's (LG.llm.intent),
     passed in as `decide` so this module doesn't depend on the API. It's
     asked only when their situation changes, so an idle villager costs
     nothing; PHASE_TABLE is the fallback with no key or a failed call. */
  const PHASE_TABLE = {
    dawn:      { work: 0.2, green: 0.1 },
    morning:   { work: 0.6, green: 0.3 },
    midday:    { work: 0.4, green: 0.5 },
    afternoon: { work: 0.5, green: 0.4 },
    dusk:      { work: 0.2, green: 0.2, bed: 0.3 },
    night:     { work: 0.0, green: 0.0, bed: 0.85 }
  };

  function byDice(a, green) {
    const t = PHASE_TABLE[LG.time.phase().id] || PHASE_TABLE.night;
    if (a.bed && Math.random() < (t.bed || 0)) return a.bed.rect;
    if (LG.time.info.indoors) {
      return (a.work && a.workBuilding && Math.random() < 0.6) ? a.work : (a.shelter || a.def.home);
    }
    const r = Math.random();
    if (a.work && r < t.work) return a.work;
    if (r < t.work + t.green) return green;
    return a.def.home;
  }

  /* A villager's situation as a key; a change is what makes them think
     again. The last term ticks every RETHINK seconds, or a villager settled
     at midday would stay put till dusk. */
  const RETHINK = 45;                             // seconds between periodic reconsiderations
  function situation(a) {
    return LG.time.phase().id + '|' + (LG.time.info.name || '') + '|' +
           (a.patch ? a.patch.x + ',' + a.patch.y : '-') + '|' + a.facts.length +
           '|' + Math.floor((a.lived || 0) / RETHINK);
  }

  /* Sleep. A villager at their own bed at night lies down, and gets up at
     first light. Nothing sends them there: their bed is one of the places
     they can choose (placesFor in game.js), and with no model the dice
     favour it at night (PHASE_TABLE.bed), the way rough weather favours
     a roof. A sleeper isn't asked where to go. Nothing about sleep is
     saved: whoever is on their bed at night when a village is reloaded
     lies straight back down. */
  function sleep(a) {
    const night = !!a.bed && LG.time.isNight();
    if (a.asleep && !night) {
      a.asleep = false;
      a.thought = null; a.wantsGo = null;         // up, and thinking about the day afresh
      a.routeCool = Math.random() * 6;            // not all at once
      think(a, 'wakes up', a.bed.label);
    }
    if (a.asleep) return true;
    if (!night || a.chatting || (a.route && a.route.length)) return false;
    if (a.tx !== a.bed.x || a.ty !== a.bed.y) return false;
    a.asleep = true;
    a.route = null; a.wantsGo = null; a.deciding = false;
    a.px = a.bed.x * TILE + TILE / 2; a.py = a.bed.y * TILE + TILE / 2;
    a.dir = 'down'; a.bubble = null; a.bubbleT = 0;
    think(a, 'goes to sleep', a.bed.label);
    return true;
  }

  function routine(a, dt, green, decide) {
    if (a.frozen) { a.route = null; return; }
    if (sleep(a)) return;
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
      // A decision that never comes is given up after 12s, timed off `lived`,
      // since this branch only runs every routeCool seconds.
      if (a.lived - (a.decideSince || 0) < 12) return;
      a.deciding = false;
    }
    else {
      a.thought = now;
      // Ask for a decision (it lands in a.wantsGo); if decide() declines, roll
      // the dice now rather than stand still.
      if (decide && decide(a, green)) { a.deciding = true; a.decideSince = a.lived; return; }
      want = byDice(a, green);
    }
    /* The patch they already have means "stay put" only if they're in it: a
       route cut short (a chat, the player, a chase, a reload) leaves
       `patch` where they were headed, and wander() won't leave it. */
    if (!want || (want === a.patch && W.inRect(a, want))) return;

    /* A few random points in the patch, since open isn't reachable: about a
       third of Ilya's clearing has no way in. */
    let route = null;
    for (let tries = 0; tries < 8 && !route; tries++) {
      const cx = want.x + (Math.random() * want.w | 0);
      const cy = want.y + (Math.random() * want.h | 0);
      const spot = W.nearestOpen(cx, cy);
      const path = W.pathTo(a.tx, a.ty, spot.x, spot.y);
      if (path && path.length) route = path;
    }
    if (route) { a.route = route; a.patch = want; }
    // Nowhere reachable: think again next tick, perhaps of somewhere else.
    else a.thought = null;
  }

  /* Follows the current route if any; otherwise wanders within the current patch. */
  function walk(a, dt, speed) {
    if (a.frozen || a.asleep) return;
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

  /* ---------------------------------------------------------- beliefs
     What a villager believes, and what the player has been told about
     them. Everything that changes a villager's memory goes through here,
     whichever module the news arrives from. */
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

     Note: noticeItemGone in village.js covers the one fact in the errand that
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

  /* Logs each villager decision with its stated reason to the console.
     Without this, there was no way to tell from the outside whether a
     villager's movement decision was reasoned or effectively random.
     Tagged in the villager's own color so a busy village stays readable.
     `LG.actors.thoughts = false` disables this; it's off anyway unless
     LG.consoleLog is on. */
  let thoughts = true;
  function think(n, what, detail) {
    // The log keeps these whether or not the console is printing them.
    if (LG.logbook) LG.logbook.note('villager', n.def ? n.def.name : '?', what,
      { detail: detail || '', where: n.px !== undefined ? LG.view.where(n) : '',
        clock: LG.time && LG.time.clock ? LG.time.clock() : '' });
    if (!LG.consoleLog || !thoughts || typeof console === 'undefined' || !console.log) return;
    const c = (n.def && n.def.color) || '#888';
    console.log('%c ' + (n.def ? n.def.name : '?') + ' %c ' + what +
                (detail ? '%c  ' + detail : ''),
      'background:' + c + ';color:#fff;border-radius:3px;font-weight:600',
      'color:inherit',
      'color:#888;font-style:italic');
  }

  /* ------------------------------------------------------------- gossip */
  /* Two idle villagers who meet stop and talk (`onChat`, or mimed bubbles
     with no key). What each takes away is worked out afterwards from what
     was said (LG.llm.recall); nothing is passed on here. */
  function meet(npcs, dt, log, chatterLine, onChat) {
    for (const a of npcs) a.gossipCool -= dt;
    for (let i = 0; i < npcs.length; i++) {
      for (let j = i + 1; j < npcs.length; j++) {
        const a = npcs[i], b = npcs[j];
        if (a.frozen || b.frozen || a.gossipCool > 0 || b.gossipCool > 0) continue;
        if (a.chatting || b.chatting) continue;
        if (a.asleep || b.asleep) continue;
        if (Math.hypot(a.px - b.px, a.py - b.py) > TILE * 2.2) continue;
        /* Holds them apart while they talk; a spoken conversation resets
           it again once it's over (LG.dialogue), so the rest starts then. */
        a.gossipCool = b.gossipCool = gossipRest();
        a.pauseT = b.pauseT = 4 + Math.random() * 3;      // stop and talk
        a.route = b.route = null;
        faceEachOther(a, b);
        const spoken = onChat && onChat(a, b);
        if (!spoken) {                                     // no key: they mime it
          a.bubble = chatterLine(); a.bubbleT = 5;
          b.bubble = chatterLine(); b.bubbleT = 5;
          log(displayName(a) + ' and ' + displayName(b) + ' stopped for a word.');
        }
      }
    }
  }

  /* Seconds a villager waits before stopping for another word. */
  function gossipRest() { return 40 + Math.random() * 40; }

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
      // A halo, or a small dark animal vanishes into the grass.
      ctx.fillStyle = 'rgba(253,246,232,.55)';
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill();

      // An emoji is drawn at the alpha fillStyle last carried: reset, or the animal is translucent.
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

  /* A villager asleep: head on the pillow, the rest under a blanket of
     their own colour, and a z drifting up. Drawn live, since only the
     room the player is standing in shows anyone sleeping. Lines up with
     the bed drawn in world.js (drawFurniture). */
  function drawSleeper(ctx, a, opts) {
    const x = a.px, top = a.ty * TILE;
    ctx.fillStyle = opts.color;
    roundRect(ctx, x - 12, top + 19, 24, 33, 4); ctx.fill();
    ctx.fillStyle = shade(opts.color, 24);
    ctx.fillRect(x - 12, top + 19, 24, 4);           // the turned-down hem
    ctx.fillStyle = opts.skin || '#f0c8a0';
    ctx.beginPath(); ctx.arc(x, top + 13, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = opts.hair || '#4a3728';
    ctx.beginPath(); ctx.arc(x, top + 11, 7, Math.PI, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2b2118'; ctx.lineWidth = 1;   // eyes shut
    ctx.beginPath();
    ctx.moveTo(x - 4.5, top + 14); ctx.lineTo(x - 1.5, top + 14);
    ctx.moveTo(x + 1.5, top + 14); ctx.lineTo(x + 4.5, top + 14);
    ctx.stroke();
    const t = (performance.now() / 1000 + a.px / 97) % 3;
    ctx.globalAlpha = Math.max(0, 1 - t / 3);
    ctx.font = '600 12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#3a2e1f';
    ctx.fillText('z', x + 12 + t * 3, top + 4 - t * 6);
    ctx.globalAlpha = 1;
    if (opts.emoji) {                                 // the role badge, as when awake
      ctx.font = '12px system-ui'; ctx.fillStyle = '#000';
      ctx.fillText(opts.emoji, x - 14, top + 2);
    }
    if (opts.name) paintName(ctx, opts.name, x, top - 30);
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

  /* ---------------------------------------------------------- speech bubbles
     A bubble breaks at spaces, and between any two CJK characters, since
     Chinese and Japanese don't space their words. Closing punctuation stays
     with the character before it and opening brackets with the one after,
     and a run too long for a line on its own is broken where it fills one. */
  const BUBBLE_W = 190;
  const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const CLOSES = /[\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\uff09\u300d\u300f\u3011\u3015\u3009\u300b\u2019\u201d\u2026\u30fc\u30fb,.!?:;)\]}]/;
  const OPENS = /[\u300c\u300e\uff08\u3010\u3014\u3008\u300a\u2018\u201c(\[{]/;
  function tokens(text) {
    const out = [];                            // [text, kind], kind one of 'space', 'cjk', 'word'
    for (const ch of Array.from(text)) {
      const last = out[out.length - 1];
      const kind = /\s/.test(ch) ? 'space' : CJK.test(ch) ? 'cjk' : 'word';
      const joins = last && (kind === 'space'
        ? last[1] === 'space'
        : last[1] !== 'space' && (CLOSES.test(ch) || OPENS.test(last[0].slice(-1)) ||
                                  (kind === 'word' && last[1] === 'word')));
      if (joins) last[0] += ch;
      else out.push([ch, kind]);
    }
    return out;
  }
  function wrap(ctx, text) {
    const lines = [];
    let line = '';
    for (const [t, kind] of tokens(text)) {
      if (line && ctx.measureText(line + t).width > BUBBLE_W) {
        lines.push(line.trim());
        line = kind === 'space' ? '' : t;
      } else line += t;
      let chars = Array.from(line);
      while (chars.length > 1 && ctx.measureText(line).width > BUBBLE_W) {
        let n = chars.length - 1;
        while (n > 1 && ctx.measureText(chars.slice(0, n).join('')).width > BUBBLE_W) n--;
        lines.push(chars.slice(0, n).join(''));
        chars = chars.slice(n); line = chars.join('');
      }
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }

  // A bubble's lines (see wrap) and its size.
  const LINE_H = 17;
  function bubbleLayout(ctx, text, font) {
    ctx.font = font;
    const lines = wrap(ctx, text);
    const bw = Math.min(BUBBLE_W, Math.max.apply(null, lines.map(l => ctx.measureText(l).width))) + 18;
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

  return { makeNPC, makeCreature, wander, walk, routine, stepTowards, meet, gossipRest,
           drawCharacter, drawSleeper, drawBubble, roundRect,
           displayName, nameOrEmoji, remember, noteFactSource, think,
           set thoughts(v) { thoughts = !!v; },
           get thoughts() { return thoughts; },
           _wrap: wrap };
})();
