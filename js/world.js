/* world.js — tile map generation, collision/pathfinding, and canvas rendering. */
window.LG = window.LG || {};

LG.world = (function () {
  const TILE = 32;
  /* The village occupies the southern half of this map; north is forest,
     east is the railway — see LG.NORTH_WOODS and the northWoods()/station()
     calls at the end of build(). */
  const W = 96, H = 96;

  const T = { GRASS:0, PATH:1, TREE:2, WATER:3, WALL:4, DOOR:5, ROCK:6, FLOWER:7,
              CROP:8, FENCE:9, SAND:10, CAVE:11, FLOOR:12, REED:13, FOUNTAIN:14,
              PLATFORM:15, RAIL:16 };
  // walls, trees, water, rock, fence, fountain, and the permanent way
  const SOLID = { 2:1, 3:1, 4:1, 6:1, 9:1, 14:1, 16:1 };

  let tiles = null;
  const buildings = [];
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
    return b;
  }

  /* Is this character's tile position inside rectangle r? Villager
     patches, the green, and building interiors are all rectangles in
     tile space; centralized here since this check used to be duplicated
     with slightly different logic across three files. */
  function inRect(a, r) {
    return !!r && a.tx >= r.x && a.tx < r.x + r.w && a.ty >= r.y && a.ty < r.y + r.h;
  }
  /* Like inRect but with a margin — villagers walk to a random point
     within a rectangle, not its center, so "have they arrived" needs to
     tolerate being just outside the edge, looking in. */
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
  /* Which building is this *character* standing in? Uses feet position
     (py+8), not the character's raw anchor point (collision uses
     py+4..py+10) — using the raw anchor would read as outside the room
     for the first few pixels of entering, making the roof appear to snap
     shut while visibly standing indoors. */
  function buildingUnder(a) {
    if (!a) return null;
    return buildingAt((a.px / TILE) | 0, ((a.py + 8) / TILE) | 0);
  }

  /* Returns building roofs in screen space, used by sky.js to clip
     precipitation. Includes the roof overhang, so rain/snow stops at the
     eaves rather than at the wall line. */
  function roofRects(cam, vw, vh, dpr) {
    const out = [];
    /* Must round to the exact same offset draw() itself uses, or the
       weather clip drifts off the roof by up to a device pixel at
       fractional dpr. Snapping to whole *device* pixels (not re-rounding
       to whole CSS pixels) is what keeps this in sync with draw(). */
    const d = dpr || 1;
    const ox = Math.round(cam.x * d) / d, oy = Math.round(cam.y * d) / d;
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
    buildings.length = 0; props.length = 0;
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
    // The high street runs the full width of the village and continues east
    // past its old endpoint to the railway platform, so arriving by train
    // and walking into the village is a single continuous street.
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
    // The hut, at the far east end past the farmhouse: one room, smaller
    // than the other buildings, doubling as the resident's shop.
    addBuilding(71, 58, 6,  5, 73, { label: 'Hut',       sign: '🍚', roof: '#8a7048', wall: '#e6d7b4' });

    // ---- the noticeboard, just past the hall, standing clear of its path
    rect(LG.BOARD_SPOT.x, LG.BOARD_SPOT.y, LG.BOARD_SPOT.w, LG.BOARD_SPOT.h, T.GRASS);
    props.push({ type: 'board', x: LG.BOARD_SPOT.x + 1, y: LG.BOARD_SPOT.y });
    signposts.push({ key: 'Noticeboard',
                     x: (LG.BOARD_SPOT.x + 1.5) * TILE, y: (LG.BOARD_SPOT.y + 2) * TILE + 6 });

    // ---- the mine, west
    rect(2, 50, 8, 9, T.ROCK);
    rect(3, 52, 5, 5, T.CAVE);
    rect(5, 57, 2, 3, T.PATH);
    rect(5, 59, 6, 1, T.PATH);
    rect(10, 58, 1, 2, T.PATH);

    // ---- the pond, south-west
    for (let y = 68; y < 79; y++) for (let x = 4; x < 21; x++) {
      const dx = (x - 12) / 8, dy = (y - 73.5) / 5;
      const d = dx * dx + dy * dy;
      if (d < 1) set(x, y, T.WATER);
      else if (d < 1.2) set(x, y, hash(x, y) < 0.28 ? T.REED : T.SAND);
    }

    // ---- the fields, east
    rect(60, 74, 15, 5, T.CROP);
    for (let x = 59; x <= 76; x++) { set(x, 73, T.FENCE); set(x, 80, T.FENCE); }
    for (let y = 73; y <= 80; y++) { set(59, y, T.FENCE); set(76, y, T.FENCE); }
    set(66, 73, T.PATH);

    // ---- the orchard and beeyard, north-east
    rect(62, 64, 16, 8, T.GRASS);
    for (let y = 65; y <= 70; y += 2) for (let x = 63; x <= 77; x += 2) set(x, y, T.TREE);
    rect(72, 51, 7, 4, T.GRASS);
    for (let x = 73; x <= 77; x++) set(x, 51, T.FENCE);
    for (let y = 52; y <= 54; y++) set(72, y, T.FENCE);
    for (let x = 74; x <= 76; x += 2) props.push({ type: 'hive', x: x, y: 52 });

    /* ---- the woodcutter's clearing
       Only plants trees on tiles that are still plain grass (checks
       get(x,y) === T.GRASS first). This stand overlaps the pond's eastern
       shore, and without that check it would scatter trees into the water
       wherever the hash landed — which it did the moment the village
       coordinates shifted and every tile's hash value changed. This is the
       one place in build() that risks overwriting deliberately-placed
       terrain, hence the guard. */
    for (let y = 64; y <= 70; y++) for (let x = 16; x <= 22; x++)
      if (get(x, y) === T.GRASS && hash(x * 3, y * 5) < 0.32) set(x, y, T.TREE);
    set(18, 67, T.CAVE); set(19, 67, T.CAVE);

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

    northWoods();
    station();

    // Terrain painted after buildings can overwrite a doorway — an orchard
    // row once sealed the farmhouse shut. Clear every door and its
    // adjoining step last, after all other terrain is placed.
    for (const b of buildings) {
      set(b.doorX, b.doorY, T.DOOR);
      if (b.doorY + 1 < H && isSolid(b.doorX, b.doorY + 1)) set(b.doorX, b.doorY + 1, T.PATH);
    }
    furnish();
    openTheWay();
    return { W, H, TILE };
  }

  /* ------------------------------------------------------------- the woods
     Generates a large forest area north of the village, big enough that
     an item can plausibly be "lost" there — several of LG.PLACES sit up
     here rather than immediately next to whoever's looking for them.

     Tree density is generated as noise layered on noise rather than a
     flat probability, because a flat probability produces an even
     stipple that reads as an orchard, not a forest. A real forest has
     dense stands with clearer patches between them. `vnoise` generates
     those stands, `hash` adds fine-grained roughness to their edges, and
     density tapers over the last few rows near the village so the
     treeline reads as a fringe of scattered trees rather than a wall. */
  function northWoods() {
    const edgeOfTown = LG.NORTH_WOODS;                 // where the trees give out
    for (let y = 2; y < edgeOfTown; y++) {
      for (let x = 2; x < W - 2; x++) {
        // Density tapers over the last 8 rows near the village edge.
        const deep = Math.min(1, (edgeOfTown - y) / 8);
        const stand = vnoise(x, y, 11) * 0.62 + vnoise(x, y, 4) * 0.38;
        /* Multiplying density by `stand` (rather than using a flat
           probability) is what produces actual thickets and clearings —
           near-zero density where the noise is low, near-total density
           where it's high. A flat probability, however high, would just
           give an even stipple with no thickets and no light gaps. */
        const d = (0.10 + 0.50 * deep) * (0.20 + 1.30 * stand);
        if (hash(x * 5 + 3, y * 7 + 11) < d) set(x, y, T.TREE);
        else if (hash(x * 13 + 1, y * 3 + 5) > 0.986) set(x, y, T.FLOWER);
      }
    }
    // Boulder outcrops, at a few fixed spots.
    for (const [bx, by, bw, bh] of [[8, 24, 3, 2], [58, 16, 2, 3], [37, 32, 3, 2]])
      rect(bx, by, bw, bh, T.ROCK);

    /* Glade clearings: cleared outright rather than left to the tree
       noise. A named place needs to be a fully walkable rectangle a
       villager can stand in and an animal can wander within — leaving
       trees inside it is what used to strand Ilya inside his own home
       patch (see the `patch` field on villagers in npc.js). */
    const glades = (LG.PLACES || []).filter(p => p.woods);
    glades.forEach(p => {
      const r = p.rect;
      rect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, T.GRASS);
    });

    // The spring actually has water in it, off to one side of its glade.
    const spring = glades.find(p => p.id === 'spring');
    if (spring) {
      set(spring.rect.x + 3, spring.rect.y + 1, T.WATER);
      set(spring.rect.x + 4, spring.rect.y + 1, T.WATER);
      set(spring.rect.x + 3, spring.rect.y + 2, T.REED);
    }
    // Charcoal pit for the charcoal-burner's glade.
    const pit = glades.find(p => p.id === 'charcoal');
    if (pit) { set(pit.rect.x + 2, pit.rect.y + 2, T.CAVE); set(pit.rect.x + 3, pit.rect.y + 2, T.CAVE); }

    /* Tracks through the woods. Meant to make the forest disorienting but
       not actually impassable — each track leads somewhere if followed.
       Each run is a chain of orthogonal segments; every glade connects to
       one. */
    [
      [[24, 44], [24, 38], [21, 38], [21, 33], [24, 33], [24, 30], [26, 30]],   // up out of the village to the spring
      [[24, 33], [28, 33], [28, 28], [32, 28], [32, 25], [34, 23]],             // on into the big clearing
      [[34, 23], [34, 19], [26, 19], [22, 19], [19, 17], [17, 15]],             // west, to the old oak
      [[34, 21], [40, 21], [40, 16], [44, 16], [46, 13], [46, 11]],             // north, to the deep woods
      [[34, 23], [39, 23], [39, 26], [45, 26], [45, 23], [50, 23], [53, 27]],   // east, down to the hollow
      [[50, 23], [56, 23], [56, 20], [62, 20], [62, 17], [68, 17]],             // and on to the charcoal pit
      [[68, 17], [68, 22], [71, 22], [71, 30], [68, 30], [68, 38]]              // back down to the village's north side
    ].forEach(track);
  }

  /* Draws one track as a chain of straight orthogonal segments between
     the given points.

     The underlying path is straight between corners, which is what makes
     the network's connectivity provably correct (checked in
     openTheWay(), not just assumed) — every glade connects via a run
     that reaches back to the village. What's actually drawn isn't the
     straight spine, though: each tile has a chance to fray a step to one
     side, so the track reads as walked through trees rather than
     surveyed. Fraying only ever *adds* walkable tiles alongside the
     spine, so it can't break the connectivity it's decorating. */
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
     Builds the unmanned railway halt at the end of the high street: a
     platform, a nameboard, a shelter with a bench, and a single track
     running north-south through the trees. No trains ever run, and it's
     unstaffed — it's simply where the player character arrived, which is
     the in-fiction reason they don't already speak the local language. */
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
    /* Station nameboard, positioned where it'd be read stepping off the
       train — for most players, the first word of the village's language
       they see. */
    signposts.push({ key: 'Station', x: (r.x + 2) * TILE, y: (r.y + 8) * TILE });
  }

  /* --------------------------------------------------- nowhere is sealed off
     Ensures every place the game can send the player or a villager to is
     actually reachable. Checks every LG.PLACES rectangle against a flood
     fill from the platform, and cuts a path to anywhere unreachable
     rather than leaving an errand impossible to complete.

     This is a correctness guarantee, not primarily a generator — the
     hand-placed tracks above should already connect everything. It runs
     regardless, because a "should" here previously produced an
     unreachable NPC (the rice merchant) that went unnoticed until a
     player got stuck. */
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

  /* Returns the set of all tile indices reachable on foot from (sx, sy). */
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

  /* Places furniture in each building, enough that a room reads as
     recognizably a bakery, smithy, etc. from the doorway. */
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

  /* Binary min-heap keyed by .f, used as A*'s open set in pathTo(). A
     tile can end up pushed more than once with a stale (higher) f-score;
     rather than removing the stale copy, pathTo() just skips it via
     `closed` when popped — cheaper than maintaining heap uniqueness. */
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

  /* Finds a walkable path between two tiles using A*, run each time a
     villager picks a new destination. Manhattan distance is an exact
     lower bound for 4-directional movement, so this finds the same
     shortest path a flood-fill would, while examining far fewer tiles at
     longer distances — a flood-fill's search area grows with the
     *square* of the distance, while this heuristic keeps the search
     focused toward the target. */
  function pathTo(sx, sy, tx, ty, limit) {
    if (sx === tx && sy === ty) return [];
    /* Node-visit cap, scaled to map size rather than a fixed number —
       fixed caps set when the map was smaller became too tight once the
       forest was added (a platform-to-far-glade walk is now a long path
       through trees, and A* has to explore more to find it). */
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
     Ground snow isn't a flat white overlay — a uniform wash over the
     whole village would read as fog rather than snow. Instead, only
     surfaces that would actually hold snow (ground, roof tops, prop
     tops) are drawn white; walls, doors, and windows keep their normal
     colors.

     Coverage builds up tile by tile rather than fading in uniformly
     everywhere at once — uniform fading reads as a lighting change, while
     patchy accumulation reads as weather. `LG.time.snow` gives the
     overall depth (0-1); each tile has its own noise-derived threshold it
     must clear before it shows snow, so coverage advances unevenly. */
  let lying = 0;                              // current snow depth, re-read from LG.time each frame
  /* `lying` changes by a tiny fraction each tick, so caching keyed on its
     exact value would essentially never hit. Instead it's quantized into
     buckets fine enough that bucket edges are imperceptible (the alpha
     value it drives is rounded to 3 decimals anyway) — so a tile computed
     once is reused across all frames within the same bucket, which for
     snow that's finished falling and just sitting there is effectively
     every frame. */
  let snowBucket = -1;
  let snowCache = null;                       // Float32Array(W*H), -1 = not yet computed
  function readSnow() {
    lying = (LG.time && typeof LG.time.snow === 'number') ? LG.time.snow : 0;
    const b = Math.round(lying * 400);
    if (b !== snowBucket) {
      snowBucket = b;
      if (!snowCache) snowCache = new Float32Array(W * H);
      snowCache.fill(-1);
    }
  }
  /* Smooth value noise so snow depth varies over stretches of the map
     rather than randomly per-tile — independent per-tile randomness
     produces a confetti-like scatter instead of coherent drifts. */
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

  /* Computes snow coverage (0-1) for one tile. Each tile has its own
     noise-derived threshold, so thin overall snow shows as scattered
     drifts on bare ground rather than an even dusting, and drifts merge
     together as depth increases. Memoized per `lying` bucket (see
     readSnow) — this is called twice per tile per frame (ground blob,
     then any prop on top) and again on every subsequent frame the tile
     stays on screen, and the underlying noise never changes. */
  function snowAt(x, y) {
    if (lying <= 0) return 0;
    const inBounds = x >= 0 && y >= 0 && x < W && y < H;
    const i = inBounds ? idx(x, y) : -1;
    if (i >= 0) {
      const c = snowCache[i];
      if (c >= 0) return c;
    }
    const n = vnoise(x, y, 6) * 0.6 + vnoise(x, y, 2.5) * 0.28 + hash(x * 5 + 1, y * 7 + 3) * 0.12;
    // Sharpened toward 0 or 1 rather than a soft gradient, so a covered
    // area is fully covered and only its border tiles are half-and-half —
    // a soft gradient everywhere would leave every tile partially white,
    // which at the fixed tile spacing reads as a repeating pattern rather
    // than as snow.
    const v = Math.max(0, Math.min(1, (lying * 2.4 - n * 1.55) * 2.2));
    if (i >= 0) snowCache[i] = v;
    return v;
  }

  /* Draws snow over already-drawn ground on one tile, as a blob rather
     than a square fill — a square fill would give every patch of
     half-melted snow a hard tile-aligned edge, making the village look
     like a chessboard. The blob is jittered and sized larger than its own
     tile so neighboring drifts overlap and stack whiter where they
     overlap, matching how real snow accumulates. Needs its own draw pass
     separate from the base tile — see drawGround. */
  function snowOnTile(ctx, x, y, px, py) {
    const t = get(x, y);
    if (t === T.FLOOR || t === T.CAVE) return;          // snow doesn't reach indoors
    /* Paths/streets get thin, even, packed snow — never a drift — since
       they're walked constantly. Deliberately capped well short of white:
       even under heavy snowfall, the roads need to stay visually distinct
       so the village's layout still reads. Filled flat edge-to-edge (no
       blob), so packed snow has no seams or gaps.
       Platform and rail get the same treatment as streets, since both are
       kept clear/used regularly. */
    if (t === T.PATH || t === T.FOUNTAIN || t === T.PLATFORM || t === T.RAIL) {
      const p = Math.min(0.5, lying * 0.62);
      if (p <= 0.02) return;
      ctx.fillStyle = 'rgba(250,251,255,' + p.toFixed(3) + ')';
      ctx.fillRect(px, py, TILE, TILE);
      return;
    }
    const a = snowAt(x, y);
    if (a <= 0.02) return;
    if (t === T.WATER) {                                // renders as a skin of ice, not a drift
      ctx.fillStyle = 'rgba(206,228,240,' + (a * 0.75).toFixed(3) + ')';
      ctx.fillRect(px, py, TILE, TILE);
      return;
    }
    /* `a` (depth) controls the *size* of the drawn patch, not its
       opacity — a fixed-size patch fading in place would look like a
       transparency filter over the grass rather than accumulating snow. */
    const r = hash(x * 3 + 7, y * 9 + 1), r2 = hash(x * 11 + 2, y * 5 + 6);
    /* Reaches near-full opacity well before depth is at its max. Leaving
       it more transparent at moderate depth would let the ground show
       through differently under one overlapping shape vs. two, which
       prints the tile grid back onto the snowfield as a faint lattice. */
    ctx.fillStyle = 'rgba(252,253,255,' + Math.min(1, 0.55 + a * 0.75).toFixed(3) + ')';
    /* Once in a full drift (a > 0.42), fills the whole tile — with
       corners cut, since a square fill is the shape that most reveals the
       tile grid — plus a jittered ellipse that bulges past the tile edge
       for a ragged border. Both shapes go in one path so the overlap
       between them is filled once, not doubled up. */
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
    // Snow depth is only computed for the prop types that use it (tree,
    // flower, fence) — most tiles are plain grass/path and don't need it,
    // so computing it unconditionally would waste work on most tiles
    // every frame.
    const a = (lying > 0 && (t === T.TREE || t === T.FLOWER || t === T.FENCE)) ? snowAt(x, y) : 0;
    if (t === T.TREE) {
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(px + 13, py + 16, 6, 14);
      const g = r < 0.5 ? '#3f7d3a' : '#4c8c40';
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px + 16, py + 12, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.arc(px + 12, py + 8, 6, 0, Math.PI * 2); ctx.fill();
      // Snow drawn only on top of the canopy — the green rim showing
      // below a white crown is what makes it read as a snow-laden tree
      // rather than a dead/bare one.
      if (a > 0.03) {
        ctx.fillStyle = 'rgba(250,252,255,' + (a * 0.92).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(px + 16, py + 11, 12, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(px + 13, py + 4, 4 + a * 2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (t === T.FLOWER) {
      if (a > 0.55) return;                     // buried under enough snow to not be visible
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

  /* Draws snow on top of a prop. The shape itself is drawn by the caller
     (`shape`) — this only sets up the white fill style and skips the call
     entirely when there's no snow to draw. */
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
      // Open-sided lean-to shelter on the platform: three walls, a bench, and a roof.
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
      // Lit at night; unlit during the day — the only state this prop has.
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
    if (froze > 0.55) {                               // frozen solid — no water animation
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

  /* Frustum check: is this world-space box within `margin` of the
     camera's view? Ground tiles are already culled per-tile in
     drawGround; buildings, props, and signs are drawn from flat arrays
     instead and need this explicit check per item — without it, render
     cost would scale with total village size rather than what's
     currently visible. `margin` accounts for roofs, signs, and shadows
     that extend past a building's own tile footprint. */
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
      /* Roofs accumulate snow faster and retain it longer than the
         ground, since they're the one surface nobody walks on. Still
         capped well short of full white, though — a roof's own color is
         what distinguishes one building from the next at a glance, and
         every building turning uniformly white would erase that. */
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

  /* Draws each building's furniture as simple flat shapes — plain, but
     distinct enough that a room reads as a bakery vs. a smithy, etc. */
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

  /* ------------------------------------------------------------------ signs
     Draws a readable sign at every building's door plus the noticeboard:
     the name in the village's language, with an English gloss underneath
     that stays blurred until clicked (same click-to-reveal convention
     used for the notebook and overheard speech). `signBoxes` is rebuilt
     in world-space coordinates on every draw call; game.js hit-tests
     click position against it since it's the one that knows the actual
     mouse position. */
  let signBoxes = [];
  let signRevealed = {};

  /* Non-building signposted locations (noticeboard, station). Populated
     during build(); buildings get their sign position from their own
     door instead and aren't listed here. */
  const signposts = [];

  function signSpots() {
    const out = buildings.map(b => {
      // Positioned beside the door, not centered on it, so it reads as a
      // shingle hung next to the doorway rather than blocking it.
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

  /* Handles a click at this world-space point: toggles the sign it hit
     (if any) and returns whether it hit one, so the caller can skip also
     treating it as a click on the ground beneath. */
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

  /* Caches the ground snow layer to an offscreen canvas rather than
     redrawing it into the visible context every frame. Redrawing directly
     was the expensive part: every visible tile gets a jittered ellipse
     (sometimes a rounded rect too) redrawn 60 times a second, for a
     picture that barely changes — the underlying noise is fixed and
     `lying` moves only slightly frame to frame. The camera also has to
     cross a full tile before the visible tile range even shifts, so the
     same blobs were being redrawn identically for a dozen-plus frames at
     a time. Now the offscreen canvas is only rebuilt when the visible
     tile range or the snow bucket changes; otherwise it's just blitted. */
  let snowLayer = null, snowLayerCtx = null, snowLayerKey = null;
  function drawSnowLayer(ctx, x0, y0, x1, y1) {
    const key = x0 + ',' + y0 + ',' + x1 + ',' + y1 + ',' + snowBucket;
    const w = (x1 - x0 + 1) * TILE, h = (y1 - y0 + 1) * TILE;
    if (key !== snowLayerKey) {
      if (!snowLayer) snowLayer = document.createElement('canvas');
      if (snowLayer.width !== w || snowLayer.height !== h) {
        snowLayer.width = w; snowLayer.height = h;
        snowLayerCtx = snowLayer.getContext('2d');
      } else {
        snowLayerCtx.clearRect(0, 0, w, h);
      }
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          snowOnTile(snowLayerCtx, x, y, (x - x0) * TILE, (y - y0) * TILE);
      snowLayerKey = key;
    }
    ctx.drawImage(snowLayer, x0 * TILE, y0 * TILE);
  }

  function drawGround(ctx, cam, vw, vh) {
    readSnow();
    const x0 = Math.max(0, (cam.x / TILE) | 0), y0 = Math.max(0, (cam.y / TILE) | 0);
    const x1 = Math.min(W - 1, ((cam.x + vw) / TILE) | 0), y1 = Math.min(H - 1, ((cam.y + vh) / TILE) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTile(ctx, x, y, x * TILE, y * TILE);
    // Snow layer drawn after all ground tiles, as a separate pass —
    // drawing it tile-by-tile alongside the ground would let each
    // drift's spillover get clipped again by the following tile's grass.
    if (lying > 0) drawSnowLayer(ctx, x0, y0, x1, y1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawProps(ctx, x, y, x * TILE, y * TILE);
  }

  return { TILE, W, H, T, build, get, isSolid, isWalkable, nearestOpen, pathTo,
           buildingAt, buildingUnder, roofRects, buildingByLabel, inRect, nearRect,
           drawGround, drawBuildings, drawSigns, hitSign, overSign, buildings,
           // for the tests: what got placed, and where you can get to from here
           _props: () => props, _signs: () => signSpots(), _flood: flood };
})();
