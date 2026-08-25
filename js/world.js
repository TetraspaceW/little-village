/* world.js — the little world: tile map, collision, and all canvas drawing. */
window.LG = window.LG || {};

LG.world = (function () {
  const TILE = 32;
  /* The village is the southern half of this. North of it is forest and east
     of it the railway — see LG.NORTH_WOODS and the sections at the foot of
     build(). */
  const W = 96, H = 96;

  const T = { GRASS:0, PATH:1, TREE:2, WATER:3, WALL:4, DOOR:5, ROCK:6, FLOWER:7,
              CROP:8, FENCE:9, SAND:10, CAVE:11, FLOOR:12, REED:13, FOUNTAIN:14,
              PLATFORM:15, RAIL:16 };
  // walls, trees, water, rock, fence, fountain, and the permanent way
  const SOLID = { 2:1, 3:1, 4:1, 6:1, 9:1, 14:1, 16:1 };

  let tiles = null;
  const buildings = [];
  const labels = [];
  const props = [];

  function idx(x, y) { return y * W + x; }
  function get(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return T.WATER;
    return tiles[idx(x, y)];
  }
  function set(x, y, t) { if (x >= 0 && y >= 0 && x < W && y < H) tiles[idx(x, y)] = t; }
  function rect(x, y, w, h, t) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, t);
  }
  function isSolid(x, y) { return !!SOLID[get(x, y)]; }
  function isWalkable(x, y) { return !isSolid(x, y); }

  /* deterministic per-tile pseudo-random, so decoration doesn't shimmer */
  function hash(x, y) {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  function addBuilding(x, y, w, h, doorX, opts) {
    rect(x, y, w, h, T.WALL);
    rect(x + 1, y + 2, w - 2, h - 3, T.FLOOR);   // the top two rows are roof and back wall
    set(doorX, y + h - 1, T.DOOR);
    const b = Object.assign({ x, y, w, h, doorX, doorY: y + h - 1,
      inside: { x: x + 1, y: y + 2, w: w - 2, h: h - 3 }, furniture: [] }, opts);
    buildings.push(b);
    labels.push({ x: x + w / 2, y: y - 0.4, label: opts.label });
    return b;
  }

  /* Is this character standing in that rectangle? Villager patches, the green
     and building interiors are all rectangles in tile space, and "are they there
     yet" was being asked in three files with three slightly different answers. */
  function inRect(a, r) {
    return !!r && a.tx >= r.x && a.tx < r.x + r.w && a.ty >= r.y && a.ty < r.y + r.h;
  }
  /* Close enough to see into it. Villagers are aimed at a spot in a rectangle,
     not at its middle, so "did they get there" has to allow for standing at the
     edge of it looking in. */
  function nearRect(a, r, pad) {
    return !!r && a.tx >= r.x - pad && a.tx < r.x + r.w + pad &&
                  a.ty >= r.y - pad && a.ty < r.y + r.h + pad;
  }

  /* Which building, if any, is this tile inside? */
  function buildingAt(tx, ty) {
    for (const b of buildings) {
      const i = b.inside;
      if (tx >= i.x && tx < i.x + i.w && ty >= i.y && ty < i.y + i.h) return b;
      if (tx === b.doorX && ty === b.doorY) return b;
    }
    return null;
  }
  /* Which building is this *character* in? Characters are positioned by a point
     a little above their feet — collision tests py+4..py+10 — so asking with the
     raw tile puts you outside the room for the topmost few pixels of it, and the
     roof snaps shut while you are plainly standing indoors. Ask with the feet. */
  function buildingUnder(a) {
    if (!a) return null;
    return buildingAt((a.px / TILE) | 0, ((a.py + 8) / TILE) | 0);
  }

  /* Building roofs in screen space, for the sky to keep the rain off. The
     overhang is included, so precipitation stops at the eaves rather than at
     the wall. */
  function roofRects(cam, vw, vh) {
    const out = [];
    const ox = Math.round(cam.x), oy = Math.round(cam.y);
    for (const b of buildings) {
      const x = b.x * TILE - 6 - ox, y = b.y * TILE - 10 - oy;
      const w = b.w * TILE + 12, h = b.h * TILE + 10;
      if (x > vw || y > vh || x + w < 0 || y + h < 0) continue;
      out.push({ x, y, w, h });
    }
    return out;
  }

  function buildingByLabel(name) {
    for (const b of buildings) if (b.label === name) return b;
    return null;
  }

  function build() {
    tiles = new Uint8Array(W * H).fill(T.GRASS);
    buildings.length = 0; labels.length = 0; props.length = 0;
    signposts.length = 0; signBoxes = []; signRevealed = {};

    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      const r = hash(x, y);
      if (edge < 2) set(x, y, T.TREE);
      else if (edge < 4 && r < 0.45) set(x, y, T.TREE);
      else if (r < 0.03) set(x, y, T.TREE);
      else if (r > 0.978) set(x, y, T.FLOWER);
    }

    // ---- streets
    // The high street runs the width of the village and on east past its old
    // end, out to the railway platform: getting off the train and walking in
    // is one street the whole way.
    rect(8, 56, 76, 2, T.PATH);           // the high street, west to east
    rect(6, 82, 68, 2, T.PATH);           // the south street
    rect(24, 44, 2, 48, T.PATH);          // the west lane
    rect(58, 46, 2, 40, T.PATH);          // the east lane
    rect(40, 58, 2, 24, T.PATH);          // through the green, hall to south street
    rect(10, 62, 2, 6, T.PATH);           // down to the pond
    rect(16, 85, 8, 2, T.PATH);           // schoolyard
    rect(44, 85, 8, 2, T.PATH);           // to the smithy

    // ---- the village green, with the hall standing at the north of it
    rect(30, 66, 22, 14, T.GRASS);
    rect(30, 72, 22, 2, T.PATH);          // the green's cross path
    for (const [gx, gy] of [[33, 69], [49, 69], [33, 77], [49, 77], [36, 76], [46, 68]])
      set(gx, gy, T.TREE);
    rect(40, 70, 2, 2, T.FOUNTAIN);
    props.push({ type: 'fountain', x: 40, y: 70 });
    for (const [bx, by] of [[35, 71], [46, 71], [37, 74], [45, 74]])
      props.push({ type: 'bench', x: bx, y: by });
    labels.push({ x: 41, y: 80.6, label: 'The Green' });

    // ---- buildings
    addBuilding(35, 58, 12, 7, 41, { label: 'Village Hall', sign: '🏛️', roof: '#8a6a3f', wall: '#f3e7cc' });
    addBuilding(14, 46, 7,  6, 17, { label: 'Bakery',    sign: '🥖', roof: '#b5563f', wall: '#e8d5b7' });
    addBuilding(30, 47, 7,  6, 33, { label: 'Shop',      sign: '🏪', roof: '#4a6fa5', wall: '#e8d5b7' });
    addBuilding(62, 48, 8,  7, 65, { label: 'Inn',       sign: '🍺', roof: '#8a5a2b', wall: '#efdcbc' });
    addBuilding(62, 60, 7,  6, 65, { label: 'Farmhouse', sign: '🏡', roof: '#7a5c3e', wall: '#f0e2c8' });
    addBuilding(68, 72, 8,  7, 71, { label: 'Mill',      sign: '⚙️', roof: '#6b705c', wall: '#e8d5b7' });
    addBuilding(12, 85, 8,  6, 15, { label: 'School',    sign: '📚', roof: '#4f7a52', wall: '#f0e2c8' });
    addBuilding(28, 87, 7,  6, 31, { label: 'Chapel',    sign: '🕯️', roof: '#5b6b8a', wall: '#f3e9d6' });
    addBuilding(46, 87, 7,  6, 49, { label: 'Smithy',    sign: '🔨', roof: '#5a4436', wall: '#ddc9a6' });
    // The hut at the far east end, past the farmhouse. Smaller than the rest:
    // one room, and the man who lives in it also sells out of it.
    addBuilding(71, 58, 6,  5, 73, { label: 'Hut',       sign: '🍚', roof: '#8a7048', wall: '#e6d7b4' });

    // ---- the noticeboard, just past the hall, standing clear of its path
    rect(LG.BOARD_SPOT.x, LG.BOARD_SPOT.y, LG.BOARD_SPOT.w, LG.BOARD_SPOT.h, T.GRASS);
    props.push({ type: 'board', x: LG.BOARD_SPOT.x + 1, y: LG.BOARD_SPOT.y });
    labels.push({ x: LG.BOARD_SPOT.x + 1.5, y: LG.BOARD_SPOT.y - 0.3, label: 'Noticeboard' });
    signposts.push({ key: 'Noticeboard',
                     x: (LG.BOARD_SPOT.x + 1.5) * TILE, y: (LG.BOARD_SPOT.y + 2) * TILE + 6 });

    // ---- the mine, west
    rect(2, 50, 8, 9, T.ROCK);
    rect(3, 52, 5, 5, T.CAVE);
    rect(5, 57, 2, 3, T.PATH);
    rect(5, 59, 6, 1, T.PATH);
    rect(10, 58, 1, 2, T.PATH);
    labels.push({ x: 6, y: 49.4, label: 'Mine' });

    // ---- the pond, south-west
    for (let y = 68; y < 79; y++) for (let x = 4; x < 21; x++) {
      const dx = (x - 12) / 8, dy = (y - 73.5) / 5;
      const d = dx * dx + dy * dy;
      if (d < 1) set(x, y, T.WATER);
      else if (d < 1.2) set(x, y, hash(x, y) < 0.28 ? T.REED : T.SAND);
    }
    labels.push({ x: 12, y: 79.6, label: 'Pond' });

    // ---- the fields, east
    rect(60, 74, 15, 5, T.CROP);
    for (let x = 59; x <= 76; x++) { set(x, 73, T.FENCE); set(x, 80, T.FENCE); }
    for (let y = 73; y <= 80; y++) { set(59, y, T.FENCE); set(76, y, T.FENCE); }
    set(66, 73, T.PATH);
    labels.push({ x: 68, y: 72.4, label: 'Fields' });

    // ---- the orchard and beeyard, north-east
    rect(62, 64, 16, 8, T.GRASS);
    for (let y = 65; y <= 70; y += 2) for (let x = 63; x <= 77; x += 2) set(x, y, T.TREE);
    labels.push({ x: 70, y: 63.2, label: 'Orchard' });
    rect(72, 51, 7, 4, T.GRASS);
    for (let x = 73; x <= 77; x++) set(x, 51, T.FENCE);
    for (let y = 52; y <= 54; y++) set(72, y, T.FENCE);
    for (let x = 74; x <= 76; x += 2) props.push({ type: 'hive', x: x, y: 52 });
    labels.push({ x: 75, y: 50.2, label: 'Beeyard' });

    /* ---- the woodcutter's clearing
       Only onto open ground. This stand overlaps the eastern shore of the
       pond, and unguarded it will scatter a tree into the water wherever the
       hash happens to land — which it duly did the moment the village moved
       and every tile drew a different number. Nothing else here paints over
       what was deliberately put down; this was the one that did. */
    for (let y = 64; y <= 70; y++) for (let x = 16; x <= 22; x++)
      if (get(x, y) === T.GRASS && hash(x * 3, y * 5) < 0.32) set(x, y, T.TREE);
    set(18, 67, T.CAVE); set(19, 67, T.CAVE);
    labels.push({ x: 19, y: 63.2, label: 'Woodpile' });

    // These face south, away from the street, so they each need a lane down the
    // side and along the front or their doors open onto nothing.
    rect(26, 84, 1, 10, T.PATH); rect(26, 93, 6, 1, T.PATH);   // to the chapel door
    rect(53, 84, 1, 10, T.PATH); rect(49, 93, 5, 1, T.PATH);   // to the smithy door
    rect(70, 58, 1, 6, T.PATH);  rect(70, 63, 4, 1, T.PATH);   // to the hut door

    // ---- the graveyard behind the chapel
    for (let x = 36; x <= 44; x++) { set(x, 88, T.FENCE); set(x, 93, T.FENCE); }
    for (let y = 88; y <= 93; y++) { set(36, y, T.FENCE); set(44, y, T.FENCE); }
    set(36, 90, T.PATH);
    for (let y = 89; y <= 92; y += 2) for (let x = 38; x <= 43; x += 2)
      props.push({ type: 'grave', x: x, y: y });
    labels.push({ x: 40, y: 87.4, label: 'Graveyard' });

    northWoods();
    station();

    // Terrain painted after the buildings can land on a doorway — an orchard row
    // sealed the farmhouse once. Clear every door and its step, last of all.
    for (const b of buildings) {
      set(b.doorX, b.doorY, T.DOOR);
      if (b.doorY + 1 < H && isSolid(b.doorX, b.doorY + 1)) set(b.doorX, b.doorY + 1, T.PATH);
    }
    furnish();
    openTheWay();
    return { W, H, TILE };
  }

  /* ------------------------------------------------------------- the woods
     A proper expanse of forest north of the village — the kind of place a
     thing can be lost in, which is the point: chain.js drops the last item of
     an errand into one of LG.PLACES, and now a fair share of those are up
     here rather than round the corner from whoever is looking for it.

     Density is noise on top of noise. A flat probability gives an even
     stipple of trees, which reads as an orchard; what makes a wood is that it
     comes in stands, with the light getting through in some places and not
     others. `vnoise` supplies the stands, `hash` roughens their edges, and
     the whole thing thins out over the last few rows so the village looks out
     on scattered birches rather than at a wall. */
  function northWoods() {
    const edgeOfTown = LG.NORTH_WOODS;                 // where the trees give out
    for (let y = 2; y < edgeOfTown; y++) {
      for (let x = 2; x < W - 2; x++) {
        // Thins over the last eight rows, so the treeline is a fringe.
        const deep = Math.min(1, (edgeOfTown - y) / 8);
        const stand = vnoise(x, y, 11) * 0.62 + vnoise(x, y, 4) * 0.38;
        /* The second factor is what makes it a wood rather than a hedge: at
           the low end of the noise it opens out to almost nothing and at the
           high end it closes to a thicket. A flat probability here — even a
           high one — gives an even stipple with no thickets and no light, and
           reads as an orchard that went wrong. */
        const d = (0.10 + 0.50 * deep) * (0.20 + 1.30 * stand);
        if (hash(x * 5 + 3, y * 7 + 11) < d) set(x, y, T.TREE);
        else if (hash(x * 13 + 1, y * 3 + 5) > 0.986) set(x, y, T.FLOWER);
      }
    }
    // Boulders, in the couple of places the ground breaks through.
    for (const [bx, by, bw, bh] of [[8, 24, 3, 2], [58, 16, 2, 3], [37, 32, 3, 2]])
      rect(bx, by, bw, bh, T.ROCK);

    /* The glades. Each one is cleared outright rather than left to the noise:
       a named place has to be somewhere a villager can stand and an animal can
       potter about, and a rectangle with trees still in it pens both of them —
       which is the bug that used to strand Ilya in his own patch. */
    const glades = (LG.PLACES || []).filter(p => p.woods);
    glades.forEach(p => {
      const r = p.rect;
      rect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, T.GRASS);
      if (p.label) labels.push({ x: r.x + r.w / 2, y: r.y - 1.4, label: p.label });
    });

    // The spring actually has water in it, off to one side of its glade.
    const spring = glades.find(p => p.id === 'spring');
    if (spring) {
      set(spring.rect.x + 3, spring.rect.y + 1, T.WATER);
      set(spring.rect.x + 4, spring.rect.y + 1, T.WATER);
      set(spring.rect.x + 3, spring.rect.y + 2, T.REED);
    }
    // And the charcoal burner left his pit behind.
    const pit = glades.find(p => p.id === 'charcoal');
    if (pit) { set(pit.rect.x + 2, pit.rect.y + 2, T.CAVE); set(pit.rect.x + 3, pit.rect.y + 2, T.CAVE); }

    /* Tracks. The woods are meant to be hard to read, not impassable — you
       follow a track and it takes you somewhere. Each run is a chain of
       orthogonal segments, and every glade hangs off one of them. */
    [
      [[24, 44], [24, 38], [21, 38], [21, 33], [24, 33], [24, 30], [26, 30]],   // up out of the village to the spring
      [[24, 33], [28, 33], [28, 28], [32, 28], [32, 25], [34, 23]],             // on into the big clearing
      [[34, 23], [34, 19], [26, 19], [22, 19], [19, 17], [17, 15]],             // west, to the old oak
      [[34, 21], [40, 21], [40, 16], [44, 16], [46, 13], [46, 11]],             // north, to the deep woods
      [[34, 23], [39, 23], [39, 26], [45, 26], [45, 23], [50, 23], [53, 27]],   // east, down to the hollow
      [[50, 23], [56, 23], [56, 20], [62, 20], [62, 17], [68, 17]],             // and on to the charcoal pit
      [[68, 17], [68, 22], [71, 22], [71, 30], [68, 30], [68, 38]]              // back down to the village's north side
    ].forEach(track);
    labels.push({ x: 40, y: 4.6, label: 'The Woods' });
  }

  /* One run of track, as a chain of orthogonal segments.

     The spine is straight between its corners, which is what makes the
     network provably joined up — every glade hangs off a run that reaches
     back to the village, and that is checked rather than hoped for. What you
     see is not the spine: each tile frays a step to one side or the other, so
     it reads as something walked between trees rather than surveyed through
     them. Fraying only ever *adds* walkable ground, so it cannot break the
     connection it is decorating. */
  function track(points) {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
      let x = x0, y = y0;
      for (;;) {
        set(x, y, T.PATH);
        if (hash(x * 17 + 5, y * 23 + 9) < 0.36) {
          const side = hash(x * 3 + 1, y * 7 + 2) < 0.5 ? 1 : -1;
          if (x !== x1) set(x, y + side, T.PATH); else set(x + side, y, T.PATH);
        }
        if (x === x1 && y === y1) break;
        if (x !== x1) x += dx; else y += dy;
      }
    }
  }

  /* ----------------------------------------------------------- the station
     An unmanned halt at the end of the high street: a platform, a nameboard,
     a shelter with a bench in it, and a single line running north to south
     through the trees. Nobody works here and no train ever comes while you
     are looking — it is where the traveller got off, and the reason they have
     no way of asking anybody anything. */
  function station() {
    const p = (LG.PLACES || []).find(s => s.id === 'platform');
    if (!p) return;
    const r = p.rect;
    // The permanent way, running the height of the map and out of sight both
    // ways. Solid: the platform is the edge of the traveller's world.
    rect(90, 2, 2, H - 4, T.RAIL);
    // Ballast either side of it, so the line sits in something.
    for (let y = 2; y < H - 2; y++) {
      set(88, y, T.SAND); set(89, y, T.SAND);
      set(92, y, T.SAND); set(93, y, T.SAND);
    }
    rect(r.x, r.y, r.w, r.h, T.PLATFORM);
    // The forecourt, joining the platform to the end of the high street.
    rect(r.x - 1, 56, 1, 2, T.PATH);

    props.push({ type: 'shelter', x: r.x + 1, y: r.y + 1 });
    props.push({ type: 'lamp', x: r.x, y: r.y + 6 });
    props.push({ type: 'bench', x: r.x, y: r.y + 10 });
    labels.push({ x: r.x + r.w / 2, y: r.y - 0.8, label: 'Station' });
    /* The nameboard, where you would actually read it stepping off the train
       — and, for most players, the first word of the language they get. */
    signposts.push({ key: 'Station', x: (r.x + 2) * TILE, y: (r.y + 8) * TILE });
  }

  /* --------------------------------------------------- nowhere is sealed off
     Open is not the same as reachable — the lesson the woodcutter's clearing
     taught once already, and a forest is that failure waiting to happen at
     scale. Everywhere the game can send you or a villager is checked against
     a flood fill from the platform, and anything walled off has a way cut to
     it rather than being left as an errand nobody can finish.

     This is a guarantee, not a generator: with the tracks above it should
     never have anything to do. It runs anyway, because "should" is how the
     rice merchant happened. */
  function openTheWay() {
    const start = nearestOpen(LG.START.x, LG.START.y);
    for (let pass = 0; pass < 4; pass++) {
      const seen = flood(start.x, start.y);
      const cut = [];
      for (const p of (LG.PLACES || [])) {
        const r = p.rect;
        let reachable = false, mine = [];
        for (let y = r.y; y < r.y + r.h && !reachable; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            if (seen.has(idx(x, y))) { reachable = true; break; }
            if (isWalkable(x, y)) mine.push([x, y]);
          }
        if (!reachable) cut.push(mine[0] || [r.x, r.y]);
      }
      if (!cut.length) return;
      // Cut straight from each stranded spot to the nearest tile we can reach.
      cut.forEach(([tx, ty]) => {
        let best = null, bestD = Infinity;
        for (const k of seen) {
          const x = k % W, y = (k / W) | 0;
          const d = Math.abs(x - tx) + Math.abs(y - ty);
          if (d < bestD) { bestD = d; best = [x, y]; }
        }
        if (best) track([best, [best[0], ty], [tx, ty]]);
      });
    }
  }

  /* Every tile you can walk to from here. */
  function flood(sx, sy) {
    const seen = new Set([idx(sx, sy)]);
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.pop();
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = idx(nx, ny);
        if (seen.has(k) || !isWalkable(nx, ny)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  /* Enough in each room that you can tell whose it is from the doorway. */
  function furnish() {
    const put = (label, items) => {
      const b = buildingByLabel(label);
      if (!b) return;
      const i = b.inside;
      b.furniture = items.map(f => ({
        type: f[0], x: i.x + f[1], y: i.y + f[2], w: f[3] || 1
      })).filter(f => f.x < i.x + i.w && f.y < i.y + i.h);
    };
    put('Bakery',       [['oven', 0, 0], ['counter', 3, 2, 2], ['shelf', 3, 0, 2], ['sack', 0, 2]]);
    put('Shop',         [['counter', 1, 2, 3], ['shelf', 0, 0, 5], ['barrel', 0, 2], ['sack', 4, 2]]);
    put('Inn',          [['counter', 0, 0, 3], ['barrel', 4, 0], ['table', 1, 2], ['stool', 0, 2],
                         ['stool', 2, 2], ['table', 4, 2], ['stool', 3, 3]]);
    put('Farmhouse',    [['table', 1, 1], ['stool', 0, 1], ['stool', 2, 1], ['bed', 4, 0], ['sack', 3, 2]]);
    put('Mill',         [['sack', 0, 0], ['sack', 1, 0], ['sack', 0, 2], ['barrel', 5, 0],
                         ['counter', 2, 2, 3], ['shelf', 3, 0, 2]]);
    put('School',       [['desk', 0, 1], ['desk', 2, 1], ['desk', 4, 1], ['desk', 0, 2],
                         ['desk', 2, 2], ['desk', 4, 2], ['shelf', 0, 0, 3], ['table', 5, 0]]);
    put('Chapel',       [['pew', 0, 1, 4], ['pew', 0, 2, 4], ['table', 2, 0]]);
    put('Smithy',       [['forge', 0, 0], ['anvil', 2, 1], ['barrel', 4, 0], ['shelf', 2, 0, 2],
                         ['counter', 3, 2, 2]]);
    put('Hut',          [['sack', 0, 0], ['sack', 1, 0], ['bed', 3, 0], ['counter', 0, 1, 3]]);
    put('Village Hall', [['table', 3, 1], ['table', 5, 1], ['stool', 2, 1], ['stool', 6, 1],
                         ['pew', 1, 3, 4], ['pew', 5, 3, 4], ['shelf', 0, 0, 3], ['desk', 8, 1]]);
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /* Binary min-heap keyed by .f, for A*'s open set. A stale, since-beaten
     copy of a tile can sit in here more than once; pathTo drops those on
     pop rather than keeping the heap free of them, which is cheaper. */
  function heapPush(heap, item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }
  function heapPop(heap) {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  }

  /* A short path between two tiles, so a villager can actually cross the
     village rather than bumping into the first wall. A*, run only when a
     villager picks a new destination. Manhattan distance is an exact
     lower bound under 4-directional movement, so it finds the same
     shortest path a flood-fill would while touching far fewer tiles the
     farther apart the two ends are — a flood-fill expands a ring that
     grows with the *square* of the distance; the heuristic here keeps the
     search pointed at the target instead. */
  function pathTo(sx, sy, tx, ty, limit) {
    if (sx === tx && sy === ty) return [];
    /* The cap is a safety valve, not a budget, so it scales with the map
       rather than sitting at a number chosen when the village was the whole
       world — a walk from the platform to a glade in the far woods is a long
       way now, and through trees A* has to work for it. */
    const max = limit || W * H;
    const h = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);

    const gScore = new Map([[idx(sx, sy), 0]]);
    const cameFrom = new Map([[idx(sx, sy), null]]);
    const open = [{ x: sx, y: sy, f: h(sx, sy) }];
    const closed = new Set();
    let visited = 0;

    while (open.length && visited < max) {
      const cur = heapPop(open);
      const ck = idx(cur.x, cur.y);
      if (closed.has(ck)) continue;
      closed.add(ck);
      visited++;

      if (cur.x === tx && cur.y === ty) {
        const out = [];
        let xy = [cur.x, cur.y];
        while (xy) { out.push({ x: xy[0], y: xy[1] }); xy = cameFrom.get(idx(xy[0], xy[1])); }
        return out.reverse().slice(1);
      }

      const cg = gScore.get(ck);
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (!isWalkable(nx, ny)) continue;
        const nk = idx(nx, ny), ng = cg + 1;
        if (closed.has(nk) || (gScore.has(nk) && gScore.get(nk) <= ng)) continue;
        gScore.set(nk, ng);
        cameFrom.set(nk, [cur.x, cur.y]);
        heapPush(open, { x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
    return null;
  }

  /* nearest walkable tile to (x,y) — used to place characters safely */
  function nearestOpen(x, y) {
    if (isWalkable(x, y)) return { x, y };
    for (let r = 1; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1 && isWalkable(nx, ny)) return { x: nx, y: ny };
        }
    return { x: 22, y: 54 };            // the high street, if all else fails
  }

  /* ---------------------------------------------------------------- snow
     Lying snow is not a white wash over the finished picture. A sheet laid over
     the whole village greys it out and reads as fog; what actually looks like
     snow is the ground and the tops of things going white while trunks, walls,
     windows and doors keep their own colour. So everything that would hold snow
     is drawn holding it, and nothing else is touched.

     Cover creeps in tile by tile rather than fading up evenly everywhere at
     once: ground that pales uniformly looks like bad lighting, ground that goes
     white in patches looks like weather. `LG.time.snow` is the depth; each tile
     has a threshold of its own that it has to pass. */
  let lying = 0;                              // re-read from the clock each frame
  function readSnow() {
    lying = (LG.time && typeof LG.time.snow === 'number') ? LG.time.snow : 0;
  }
  /* Smooth value noise, so the depth varies over stretches of the map rather
     than tile by tile. Per-tile randomness alone puts an independent patch on
     every square and the ground comes out as confetti; snow gathers. */
  function vnoise(x, y, s) {
    const fx = x / s, fy = y / s;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
    const a = hash(x0 * 3 + s, y0 * 7 + s), b = hash((x0 + 1) * 3 + s, y0 * 7 + s);
    const c = hash(x0 * 3 + s, (y0 + 1) * 7 + s), d = hash((x0 + 1) * 3 + s, (y0 + 1) * 7 + s);
    const top = a + (b - a) * u, bot = c + (d - c) * u;
    return top + (bot - top) * v;
  }

  /* How deep it is on one tile. Every tile has its own threshold to clear, so
     thin snow is a few drifts on bare ground rather than an even dusting over
     all of it — and the deeper it gets the more of them join up. */
  function snowAt(x, y) {
    if (lying <= 0) return 0;
    const n = vnoise(x, y, 6) * 0.6 + vnoise(x, y, 2.5) * 0.28 + hash(x * 5 + 1, y * 7 + 3) * 0.12;
    // Sharpened, so a covered stretch is properly covered and only its border is
    // half-and-half. A soft ramp everywhere leaves every tile part-white, and
    // part-white tiles at a fixed spacing read as a pattern rather than as snow.
    return Math.max(0, Math.min(1, (lying * 2.4 - n * 1.55) * 2.2));
  }

  /* White over ground that has already been drawn. A drift is a blob, not a
     square: a tile filled corner to corner gives every patch of half-melted snow
     a hard edge on the tile grid and the village turns into a chessboard. The
     blob is jittered and drawn wider than its own tile, so neighbouring drifts
     run into each other and the overlaps pile up whiter, which is what snow
     actually does. It needs a pass of its own for that — see drawGround. */
  function snowOnTile(ctx, x, y, px, py) {
    const t = get(x, y);
    if (t === T.FLOOR || t === T.CAVE) return;          // snow does not get indoors
    /* Streets are walked all day: what lies on them is thin, packed and even,
       never a drift. It is capped well short of white on purpose — under a deep
       fall the lanes are the only thing telling you where the village goes, and
       a white field with the roads erased out of it is not a village. Flat fills
       edge to edge, so the packed snow has no seams and no patches. */
    /* The platform gets swept and the line gets used, so both take snow the
       way the streets do — thin, packed and never a drift. */
    if (t === T.PATH || t === T.FOUNTAIN || t === T.PLATFORM || t === T.RAIL) {
      const p = Math.min(0.5, lying * 0.62);
      if (p <= 0.02) return;
      ctx.fillStyle = 'rgba(250,251,255,' + p.toFixed(3) + ')';
      ctx.fillRect(px, py, TILE, TILE);
      return;
    }
    const a = snowAt(x, y);
    if (a <= 0.02) return;
    if (t === T.WATER) {                                // a skin of ice, not a drift
      ctx.fillStyle = 'rgba(206,228,240,' + (a * 0.75).toFixed(3) + ')';
      ctx.fillRect(px, py, TILE, TILE);
      return;
    }
    /* Depth drives the *size* of the patch, not how see-through it is. Snow that
       fades up in place is a white filter over the grass; snow that grows out
       from patches and meets itself is snow. Nearly opaque, so the overlaps do
       not stack into rings. */
    const r = hash(x * 3 + 7, y * 9 + 1), r2 = hash(x * 11 + 2, y * 5 + 6);
    /* Opaque well before it is deep. Leaving it part-transparent at depth means
       the ground shows through wherever exactly one shape covers a pixel and not
       where two do, which prints the tile grid back onto a field of snow as a
       lattice of faint stars. */
    ctx.fillStyle = 'rgba(252,253,255,' + Math.min(1, 0.55 + a * 0.75).toFixed(3) + ')';
    /* Inside a drift it is a sheet, so the tile fills — with its corners taken
       off, because a square of snow is the one shape that gives the tile grid
       away. The blob bulges over the edges and makes the border ragged. Both go
       into one path so the overlap is filled once and does not stack. */
    ctx.beginPath();
    if (a > 0.42) {
      if (ctx.roundRect) ctx.roundRect(px - 2, py - 2, TILE + 4, TILE + 4, 8);
      else ctx.rect(px, py, TILE, TILE);
    }
    ctx.ellipse(px + 8 + r * 16, py + 8 + r2 * 16,
                5 + a * (20 + r * 18), 4 + a * (16 + r2 * 16), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ------------------------------------------------------------- drawing */
  const COLORS = {
    grassA: '#79ad5b', grassB: '#6fa452',
    path: '#c9b088', pathEdge: '#b89b73',
    water: '#4a90c4', waterDeep: '#3b78a6',
    sand: '#ddca9b', crop: '#a8c46a', cave: '#2a2320'
  };

  function drawTile(ctx, x, y, px, py) {
    const t = get(x, y), r = hash(x, y);
    switch (t) {
      case T.FOUNTAIN:
      case T.PATH:
        ctx.fillStyle = COLORS.path; ctx.fillRect(px, py, TILE, TILE);
        if (r < 0.18) { ctx.fillStyle = COLORS.pathEdge;
          ctx.fillRect(px + (r * 20 | 0), py + (r * 27 | 0) % 24, 4, 3); }
        break;
      case T.WATER: {
        ctx.fillStyle = r < 0.5 ? COLORS.water : COLORS.waterDeep;
        ctx.fillRect(px, py, TILE, TILE);
        const t2 = (performance.now() / 900 + r * 6) % 4;
        if (t2 < 1) { ctx.fillStyle = 'rgba(255,255,255,.22)';
          ctx.fillRect(px + 6, py + 10 + (r * 8 | 0), 12, 2); }
        break;
      }
      case T.SAND: ctx.fillStyle = COLORS.sand; ctx.fillRect(px, py, TILE, TILE); break;
      case T.REED:
        ctx.fillStyle = COLORS.sand; ctx.fillRect(px, py, TILE, TILE);
        ctx.strokeStyle = '#6f8f4a'; ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const bx = px + 6 + i * 9 + (r * 4 | 0);
          ctx.beginPath(); ctx.moveTo(bx, py + 28); ctx.lineTo(bx + 2, py + 12); ctx.stroke();
        }
        break;
      case T.CROP:
        ctx.fillStyle = '#8b6b45'; ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = COLORS.crop;
        for (let i = 0; i < 3; i++) ctx.fillRect(px + 4 + i * 9, py + 8 + ((r * 10 * (i + 1)) % 8 | 0), 6, 16);
        break;
      case T.CAVE: ctx.fillStyle = COLORS.cave; ctx.fillRect(px, py, TILE, TILE); break;
      case T.PLATFORM:
        // Worn flags with the joints showing, and a painted edge along the
        // side that faces the track — the one bit of maintenance anybody does.
        ctx.fillStyle = '#b9b2a4'; ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(px, py, TILE, 2);
        ctx.fillStyle = 'rgba(60,52,40,.16)';
        ctx.fillRect(px, py + TILE - 2, TILE, 2); ctx.fillRect(px + TILE - 2, py, 2, TILE);
        if (r < 0.3) { ctx.fillStyle = 'rgba(60,52,40,.10)';
          ctx.fillRect(px + 4 + (r * 40 | 0) % 20, py + 6 + (r * 33 | 0) % 18, 6, 4); }
        if (get(x + 1, y) === T.SAND) {                 // the platform edge line
          ctx.fillStyle = '#e6dcae'; ctx.fillRect(px + TILE - 5, py, 4, TILE);
        }
        break;
      case T.RAIL: {
        ctx.fillStyle = '#8d8578'; ctx.fillRect(px, py, TILE, TILE);   // ballast
        ctx.fillStyle = '#6b573f';                                     // sleepers
        for (let i = 0; i < 3; i++) ctx.fillRect(px, py + 2 + i * 11, TILE, 6);
        ctx.fillStyle = '#b8b2ab';                                     // the rail itself
        ctx.fillRect(px + (get(x - 1, y) === T.RAIL ? 6 : 20), py, 5, TILE);
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.fillRect(px + (get(x - 1, y) === T.RAIL ? 6 : 20), py, 2, TILE);
        break;
      }
      case T.FLOOR:
        ctx.fillStyle = '#c6a173'; ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = 'rgba(120,86,52,.30)';               // floorboards
        ctx.fillRect(px, py + 10, TILE, 2);
        ctx.fillRect(px, py + 24, TILE, 2);
        if (r < 0.4) { ctx.fillStyle = 'rgba(120,86,52,.16)'; ctx.fillRect(px + 15, py, 2, 10); }
        break;
      case T.ROCK: {
        ctx.fillStyle = '#8a8478'; ctx.fillRect(px, py, TILE, TILE);
        for (let k = 0; k < 4; k++) {
          const h1 = hash(x * 7 + k, y * 13 + k * 3), h2 = hash(x * 11 + k * 5, y * 3 + k);
          ctx.fillStyle = h1 < 0.5 ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.10)';
          ctx.beginPath();
          ctx.arc(px + h1 * TILE, py + h2 * TILE, 5 + h1 * 7, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      default: {
        ctx.fillStyle = r < 0.5 ? COLORS.grassA : COLORS.grassB;
        ctx.fillRect(px, py, TILE, TILE);
        if (r > 0.72 && r < 0.8) { ctx.fillStyle = '#8cbd68';
          ctx.fillRect(px + 8, py + 18, 3, 6); ctx.fillRect(px + 16, py + 14, 3, 9); }
      }
    }
  }

  function drawProps(ctx, x, y, px, py) {
    const t = get(x, y), r = hash(x, y);
    const a = lying > 0 ? snowAt(x, y) : 0;
    if (t === T.TREE) {
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(px + 13, py + 16, 6, 14);
      const g = r < 0.5 ? '#3f7d3a' : '#4c8c40';
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px + 16, py + 12, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.arc(px + 12, py + 8, 6, 0, Math.PI * 2); ctx.fill();
      // It settles on top of the canopy and nowhere else: a green rim under a
      // white crown is what makes a laden tree read as laden rather than dead.
      if (a > 0.03) {
        ctx.fillStyle = 'rgba(250,252,255,' + (a * 0.92).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(px + 16, py + 11, 12, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(px + 13, py + 4, 4 + a * 2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (t === T.FLOWER) {
      if (a > 0.55) return;                     // buried
      const cols = ['#f2c14e', '#e5798f', '#c8a2f2', '#f5f0e6'];
      ctx.fillStyle = cols[(r * 4) | 0];
      ctx.beginPath(); ctx.arc(px + 10 + (r * 12 | 0), py + 16 + (r * 10 | 0), 3.5, 0, Math.PI * 2); ctx.fill();
    } else if (t === T.FENCE) {
      ctx.fillStyle = '#9a7b52';
      ctx.fillRect(px + 4, py + 8, 4, 20);
      ctx.fillRect(px + 22, py + 8, 4, 20);
      ctx.fillRect(px, py + 13, TILE, 4);
      if (a > 0.03) {
        ctx.fillStyle = 'rgba(250,252,255,' + (a * 0.9).toFixed(3) + ')';
        ctx.fillRect(px, py + 11, TILE, 3);                 // along the rail
        ctx.fillRect(px + 4, py + 6, 4, 3); ctx.fillRect(px + 22, py + 6, 4, 3);
      }
    }
  }

  /* Snow on the top of a standing thing. The shape is the caller's business —
     this only sets the white and gets out of the way when there is none. */
  function capSnow(ctx, p, shape) {
    const a = lying > 0 ? snowAt(p.x, p.y) : 0;
    if (a <= 0.03) return;
    ctx.fillStyle = 'rgba(250,252,255,' + (a * 0.9).toFixed(3) + ')';
    shape(a);
  }

  function drawProp(ctx, p) {
    if (p.type === 'hive') {
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.beginPath(); ctx.ellipse(x + 16, y + 26, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d8ab55';                       // stacked boxes
      ctx.fillRect(x + 6, y + 12, 20, 12);
      ctx.fillStyle = '#c2963f'; ctx.fillRect(x + 6, y + 6, 20, 7);
      ctx.fillStyle = '#8a6a2f'; ctx.fillRect(x + 4, y + 3, 24, 4);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 13, y + 18, 6, 3);
      capSnow(ctx, p, () => ctx.fillRect(x + 3, y, 26, 4));
      return;
    }
    if (p.type === 'bench') {
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x + 3, y + 20, 26, 5);
      ctx.fillStyle = '#9a7b52';
      ctx.fillRect(x + 2, y + 12, 28, 5);      // seat
      ctx.fillRect(x + 2, y + 6, 28, 4);       // back
      ctx.fillStyle = '#7d6242';
      ctx.fillRect(x + 4, y + 16, 4, 7);
      ctx.fillRect(x + 24, y + 16, 4, 7);
      capSnow(ctx, p, () => { ctx.fillRect(x + 2, y + 4, 28, 3); ctx.fillRect(x + 2, y + 10, 28, 3); });
      return;
    }
    if (p.type === 'grave') {
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath(); ctx.ellipse(x + 16, y + 25, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a8a296';
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 24); ctx.lineTo(x + 10, y + 12);
      ctx.arc(x + 16, y + 12, 6, Math.PI, 0);
      ctx.lineTo(x + 22, y + 24);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8d8779'; ctx.fillRect(x + 12, y + 16, 8, 2);
      capSnow(ctx, p, () => {
        ctx.beginPath(); ctx.arc(x + 16, y + 12, 6, Math.PI, 0); ctx.closePath(); ctx.fill();
      });
      return;
    }
    if (p.type === 'shelter') {
      // A lean-to open to the platform: three sides, a bench, and a roof that
      // has been keeping the rain off nobody in particular for years.
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.fillRect(x + 2, y + 34, TILE * 2, 6);
      ctx.fillStyle = '#6f5a44';                        // back and side walls
      ctx.fillRect(x, y + 6, TILE * 2, 28);
      ctx.fillStyle = '#5d4a37';
      ctx.fillRect(x + 4, y + 16, TILE * 2 - 8, 16);    // the shaded inside
      ctx.fillStyle = '#8a6a45';                        // a bench under it
      ctx.fillRect(x + 7, y + 24, TILE * 2 - 14, 5);
      ctx.fillStyle = '#7d6a52';                        // the roof, overhanging
      ctx.fillRect(x - 4, y, TILE * 2 + 8, 9);
      ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(x - 4, y, TILE * 2 + 8, 3);
      capSnow(ctx, p, () => ctx.fillRect(x - 4, y - 3, TILE * 2 + 8, 4));
      return;
    }
    if (p.type === 'lamp') {
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath(); ctx.ellipse(x + 16, y + 26, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a443c';
      ctx.fillRect(x + 14, y + 2, 4, 24);
      ctx.fillStyle = '#3c3630';
      ctx.fillRect(x + 10, y - 2, 12, 8);
      // Lit after dark, which is the only thing here that ever changes.
      const night = LG.time && LG.time.isNight && LG.time.isNight();
      ctx.fillStyle = night ? '#ffe6a3' : '#cdd3d6';
      ctx.fillRect(x + 12, y, 8, 5);
      if (night) {
        ctx.fillStyle = 'rgba(255,220,140,.16)';
        ctx.beginPath(); ctx.arc(x + 16, y + 4, 20, 0, Math.PI * 2); ctx.fill();
      }
      capSnow(ctx, p, () => ctx.fillRect(x + 10, y - 4, 12, 3));
      return;
    }
    if (p.type === 'board') {
      const x = p.x * TILE, y = p.y * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x - 2, y + 26, 36, 5);
      ctx.fillStyle = '#7d6242';                       // two posts
      ctx.fillRect(x - 1, y + 6, 5, 26);
      ctx.fillRect(x + 27, y + 6, 5, 26);
      ctx.fillStyle = '#6b4a2f';                        // the board itself
      ctx.fillRect(x - 4, y, 39, 20);
      ctx.fillStyle = '#c9b892';                        // a few pinned scraps
      ctx.fillRect(x, y + 3, 10, 7);
      ctx.fillRect(x + 12, y + 6, 9, 6);
      ctx.fillRect(x + 3, y + 11, 8, 6);
      ctx.fillRect(x + 22, y + 3, 9, 7);
      ctx.fillStyle = 'rgba(181,86,63,.85)';             // pins
      [[x + 4, y + 4], [x + 16, y + 7], [x + 6, y + 12], [x + 26, y + 4]]
        .forEach(([px, py]) => { ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill(); });
      capSnow(ctx, p, () => ctx.fillRect(x - 4, y - 3, 39, 4));
      return;
    }
    if (p.type !== 'fountain') return;
    const cx = (p.x + 1) * TILE, cy = (p.y + 1) * TILE;
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.beginPath(); ctx.ellipse(cx, cy + 6, 34, 14, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a9a294';                        // stone rim
    ctx.beginPath(); ctx.ellipse(cx, cy, 33, 22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8b8578';
    ctx.beginPath(); ctx.ellipse(cx, cy + 3, 33, 20, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#4a90c4';                        // water
    ctx.beginPath(); ctx.ellipse(cx, cy, 25, 15, 0, 0, Math.PI * 2); ctx.fill();
    const froze = snowAt(p.x, p.y);
    if (froze > 0.55) {                               // iced over: nothing is moving
      ctx.fillStyle = 'rgba(214,232,243,' + (froze * 0.85).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(cx, cy, 25, 15, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      const t = performance.now() / 700;
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2;
      for (let i = 0; i < 2; i++) {
        const rr = 6 + ((t + i * 0.5) % 1) * 16;
        ctx.globalAlpha = 1 - ((t + i * 0.5) % 1);
        ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    capSnow(ctx, p, () => {
      ctx.beginPath(); ctx.ellipse(cx, cy - 4, 33, 20, 0, Math.PI, 0); ctx.closePath(); ctx.fill();
    });
    ctx.fillStyle = '#c2bbac';                        // little central plinth
    ctx.fillRect(cx - 4, cy - 16, 8, 16);
    ctx.beginPath(); ctx.arc(cx, cy - 18, 6, 0, Math.PI * 2); ctx.fill();
    capSnow(ctx, p, () => { ctx.beginPath(); ctx.arc(cx, cy - 20, 6, Math.PI, 0); ctx.closePath(); ctx.fill(); });
  }

  /* Is this world-space box anywhere near the camera? Ground tiles are
     already culled per-tile in drawGround; buildings, props and labels are
     drawn from flat arrays instead, so they need the same test done by
     hand before each one — otherwise the cost of this pass grows with the
     size of the whole village rather than with what's actually on screen.
     margin covers roofs, signs and shadows that overhang a building's own
     tile footprint. */
  function inView(px, py, w, h, cam, vw, vh, margin) {
    return px + w + margin > cam.x && px - margin < cam.x + vw &&
           py + h + margin > cam.y && py - margin < cam.y + vh;
  }

  function drawBuildings(ctx, insideBuilding, cam, vw, vh) {
    readSnow();
    for (const p of props) {
      if (!inView(p.x * TILE, p.y * TILE, TILE, TILE, cam, vw, vh, TILE * 3)) continue;
      drawProp(ctx, p);
    }
    for (const b of buildings) {
      const px = b.x * TILE, py = b.y * TILE, pw = b.w * TILE, ph = b.h * TILE;
      if (!inView(px, py, pw, ph, cam, vw, vh, TILE * 2)) continue;
      const open = (b === insideBuilding);

      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(px + 6, py + 10, pw, ph);

      // the wall ring — the inside is left as floor so it can be furnished
      ctx.fillStyle = b.wall;
      ctx.fillRect(px, py, pw, TILE * 2);                     // back wall
      ctx.fillRect(px, py + ph - TILE, pw, TILE);             // front wall
      ctx.fillRect(px, py, TILE, ph);                         // west
      ctx.fillRect(px + pw - TILE, py, TILE, ph);             // east

      drawFurniture(ctx, b, open);

      // roof: solid from outside, a hint of one when you are under it
      ctx.globalAlpha = open ? 0.16 : 1;
      ctx.fillStyle = b.roof;
      if (!open) ctx.fillRect(px, py, pw, ph);
      ctx.fillRect(px - 6, py - 10, pw + 12, TILE * 2);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(px - 6, py + TILE * 2 - 16, pw + 12, 6);
      ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(px - 6, py - 10, pw + 12, 4);
      /* Roofs take it before the ground does and keep it after the ground has
         lost it — they are the one surface nobody walks on. Well short of white
         even then: a roof is how you tell one house from the next at a glance,
         and eleven white rectangles are not a village. */
      if (lying > 0.02) {
        ctx.globalAlpha = (open ? 0.16 : 1) * Math.min(0.72, lying * 1.2);
        ctx.fillStyle = 'rgba(250,252,255,1)';
        if (!open) ctx.fillRect(px, py, pw, ph);
        ctx.fillRect(px - 6, py - 10, pw + 12, TILE * 2 - 4);
      }
      ctx.globalAlpha = 1;

      // windows and door sit on the walls either way
      ctx.fillStyle = '#3d5468';
      for (let i = 1; i < b.w - 1; i += 2) ctx.fillRect(px + i * TILE + 6, py + TILE * 2 + 8, 20, 18);
      const dx = b.doorX * TILE, dy = (b.y + b.h - 1) * TILE;
      ctx.fillStyle = open ? '#3a2717' : '#5b3d26';
      ctx.fillRect(dx + 3, dy - 6, TILE - 6, TILE + 6);
      ctx.fillStyle = '#d8b25e';
      ctx.beginPath(); ctx.arc(dx + TILE - 10, dy + 12, 2.5, 0, Math.PI * 2); ctx.fill();

      ctx.font = '20px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(b.sign, px + pw / 2, py + TILE * 2 - 4);
    }
  }

  /* Plain shapes, but enough that a room reads as a bakery or a smithy. */
  function drawFurniture(ctx, b, open) {
    if (!b.furniture.length) return;
    ctx.globalAlpha = open ? 1 : 0.9;
    for (const f of b.furniture) {
      const x = f.x * TILE, y = f.y * TILE;
      switch (f.type) {
        case 'counter':
          ctx.fillStyle = '#8a6a45'; ctx.fillRect(x, y + 8, TILE * (f.w || 1), 18);
          ctx.fillStyle = '#a3855c'; ctx.fillRect(x, y + 8, TILE * (f.w || 1), 6);
          break;
        case 'shelf':
          ctx.fillStyle = '#6f563a'; ctx.fillRect(x, y + 4, TILE * (f.w || 1), 22);
          ctx.fillStyle = '#c8a76d';
          for (let i = 0; i < (f.w || 1) * 2; i++) ctx.fillRect(x + 4 + i * 14, y + 7, 9, 7);
          ctx.fillStyle = '#b08b57';
          for (let i = 0; i < (f.w || 1) * 2; i++) ctx.fillRect(x + 4 + i * 14, y + 17, 9, 7);
          break;
        case 'oven':
          ctx.fillStyle = '#7a5346'; ctx.fillRect(x, y + 2, TILE * 2, TILE - 4);
          ctx.fillStyle = '#2a1c14'; ctx.fillRect(x + 8, y + 10, 30, 14);
          ctx.fillStyle = '#e0913a'; ctx.fillRect(x + 12, y + 16, 22, 7);
          break;
        case 'table':
          ctx.fillStyle = '#8a6a45'; ctx.fillRect(x + 2, y + 6, TILE - 4, TILE - 12);
          ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(x + 2, y + TILE - 10, TILE - 4, 4);
          break;
        case 'stool':
          ctx.fillStyle = '#7d6242';
          ctx.beginPath(); ctx.arc(x + 16, y + 16, 7, 0, Math.PI * 2); ctx.fill();
          break;
        case 'anvil':
          ctx.fillStyle = '#4a4a52'; ctx.fillRect(x + 6, y + 16, 20, 8);
          ctx.fillRect(x + 10, y + 10, 12, 8);
          ctx.fillStyle = '#6b6b74'; ctx.fillRect(x + 4, y + 8, 24, 4);
          break;
        case 'forge':
          ctx.fillStyle = '#57493f'; ctx.fillRect(x, y + 4, TILE, TILE - 8);
          ctx.fillStyle = '#e8762a'; ctx.fillRect(x + 8, y + 12, 16, 12);
          ctx.fillStyle = '#f6c14a'; ctx.fillRect(x + 12, y + 16, 8, 6);
          break;
        case 'desk':
          ctx.fillStyle = '#8a6a45'; ctx.fillRect(x + 2, y + 8, TILE - 4, 14);
          ctx.fillStyle = '#f0e6d2'; ctx.fillRect(x + 8, y + 10, 12, 8);
          break;
        case 'pew':
          ctx.fillStyle = '#6f563a'; ctx.fillRect(x, y + 10, TILE * (f.w || 1), 7);
          ctx.fillRect(x, y + 4, TILE * (f.w || 1), 4);
          break;
        case 'barrel':
          ctx.fillStyle = '#8a6a45';
          ctx.beginPath(); ctx.ellipse(x + 16, y + 16, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#5f4a2f'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x + 6, y + 13); ctx.lineTo(x + 26, y + 13); ctx.stroke();
          break;
        case 'sack':
          ctx.fillStyle = '#c9b892';
          ctx.beginPath(); ctx.ellipse(x + 16, y + 18, 9, 11, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#a8946c'; ctx.fillRect(x + 12, y + 6, 8, 5);
          break;
        case 'bed':
          ctx.fillStyle = '#8a6a45'; ctx.fillRect(x + 2, y + 4, TILE - 4, TILE * 1.6);
          ctx.fillStyle = '#dfe6ee'; ctx.fillRect(x + 4, y + 6, TILE - 8, 14);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawLabels(ctx, cam, vw, vh, lang) {
    ctx.font = '600 13px system-ui';
    ctx.textAlign = 'center';
    for (const l of labels) {
      const text = LG.placeName(l.label, lang);
      const x = l.x * TILE, y = l.y * TILE;
      if (!inView(x, y, 0, 0, cam, vw, vh, TILE * 4)) continue;
      const w = ctx.measureText(text).width + 14;
      ctx.fillStyle = 'rgba(28,24,20,.55)';
      ctx.fillRect(x - w / 2, y - 14, w, 19);
      ctx.fillStyle = '#f6efe2';
      ctx.fillText(text, x, y);
    }
  }

  /* ------------------------------------------------------------------ signs
     A readable sign in front of every building's door, and one at the
     noticeboard: the name in the language the village speaks, with an English
     line underneath that stays blurred until clicked — the same convention
     the notebook and overheard speech already use for a gloss. `signBoxes` is
     rebuilt in world space every time this draws; a click is hit-tested
     against it by whoever knows where the mouse actually was (game.js). */
  let signBoxes = [];
  let signRevealed = {};

  /* Anything that is not a building but still has its name up: the
     noticeboard, the station. Filled during build(); buildings get theirs
     from their own door and are not listed here. */
  const signposts = [];

  function signSpots() {
    const out = buildings.map(b => {
      // Stood beside the door rather than across it, so it reads as a
      // shingle hung by the doorway and not a barrier in the way.
      const toRight = b.doorX < b.x + b.w - 1;
      const sx = (toRight ? b.doorX + 1 : b.doorX - 1) * TILE + TILE / 2;
      const sy = (b.doorY + 1) * TILE + 6;
      return { key: b.label, x: sx, y: sy };
    });
    return out.concat(signposts);
  }

  function drawSigns(ctx, cam, vw, vh, lang, revealAll) {
    signBoxes = [];
    const L = LG.LANGUAGES && LG.LANGUAGES[lang];
    const nativeFont = '600 11px ' + ((L && L.fontStack) || 'system-ui');
    const glossFont = '10px system-ui';
    ctx.textAlign = 'center';
    for (const s of signSpots()) {
      if (!inView(s.x - 40, s.y - 40, 80, 40, cam, vw, vh, TILE)) continue;
      const native = LG.placeName(s.key, lang);
      const gloss = lang === 'en' ? null : LG.placeName(s.key, 'en');
      ctx.font = nativeFont;
      let w = ctx.measureText(native).width;
      if (gloss) { ctx.font = glossFont; w = Math.max(w, ctx.measureText(gloss).width); }
      w += 16;
      const h = gloss ? 34 : 20;
      const bx = s.x - w / 2, by = s.y - h;

      ctx.fillStyle = '#6b4a2f';                        // the post
      ctx.fillRect(s.x - 2, s.y - 6, 4, 10);
      ctx.fillStyle = '#e9dcbb';                         // the board
      ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = '#8a6a45'; ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 0.75, by + 0.75, w - 1.5, h - 1.5);

      ctx.fillStyle = '#3a2e1f';
      ctx.font = nativeFont;
      ctx.fillText(native, s.x, by + 15);
      if (gloss) {
        const revealed = revealAll || signRevealed[s.key];
        ctx.save();
        if (!revealed) ctx.filter = 'blur(2.2px)';       // click-to-reveal, as elsewhere
        ctx.fillStyle = revealed ? '#6d5b45' : 'rgba(109,91,69,.65)';
        ctx.font = glossFont;
        ctx.fillText(gloss, s.x, by + 29);
        ctx.restore();
      }
      signBoxes.push({ x: bx, y: by, w, h, key: s.key });
    }
  }

  /* A click at this world-space point. Toggles whichever sign it landed on
     and reports whether it hit one, so the caller does not also read it as a
     click on the ground beneath. */
  function hitSign(wx, wy) {
    for (const b of signBoxes) {
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
        signRevealed[b.key] = !signRevealed[b.key];
        return true;
      }
    }
    return false;
  }
  function overSign(wx, wy) {
    return signBoxes.some(b => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h);
  }

  function drawGround(ctx, cam, vw, vh) {
    readSnow();
    const x0 = Math.max(0, (cam.x / TILE) | 0), y0 = Math.max(0, (cam.y / TILE) | 0);
    const x1 = Math.min(W - 1, ((cam.x + vw) / TILE) | 0), y1 = Math.min(H - 1, ((cam.y + vh) / TILE) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTile(ctx, x, y, x * TILE, y * TILE);
    // Snow after all the ground, never tile by tile with it: a drift that spills
    // over its own tile would be cut off again by the next tile's grass.
    if (lying > 0)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) snowOnTile(ctx, x, y, x * TILE, y * TILE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawProps(ctx, x, y, x * TILE, y * TILE);
  }

  return { TILE, W, H, T, build, get, isSolid, isWalkable, nearestOpen, pathTo,
           buildingAt, buildingUnder, roofRects, buildingByLabel, inRect, nearRect,
           drawGround, drawBuildings, drawLabels, drawSigns, hitSign, overSign, buildings,
           // for the tests: what got placed, and where you can get to from here
           _labels: () => labels, _props: () => props, _signs: () => signSpots(), _flood: flood };
})();
