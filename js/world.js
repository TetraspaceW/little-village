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
    forgetSnowField();
    signposts.length = 0; signBoxes = [];

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
    for (let y = 89; y <= 92; y += 2) for (let x = 38; x <= 43; x += 2) {
      const g = { type: 'grave', x: x, y: y };
      if (x === 38 && y === 91) g.li = true;   // marks the "Old Li" memorial grave -- see OLD-LI.md
      props.push(g);
    }

    northWoods();
    station();

    // Terrain painted after buildings can overwrite more than just a
    // doorway -- the orchard and fields both extend far enough to plow
    // over a whole wall (the mill's and farmhouse's), leaving a gap in
    // the side of the building. Re-stamps every wall and floor tile
    // exactly as addBuilding() originally laid them, then clears the
    // door and its step, all after every other terrain pass has run.
    for (const b of buildings) {
      rect(b.x, b.y, b.w, b.h, T.WALL);
      rect(b.inside.x, b.inside.y, b.inside.w, b.inside.h, T.FLOOR);
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
     unreachable NPC (the rice merchant, see OLD-LI.md) that went
     unnoticed until a player got stuck. */
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

     Where snow lies comes from one continuous noise field over the whole
     map, not from anything per-tile: `LG.time.snow` (0-1) sets a level,
     and wherever the field is under it there's snow. Deepening snow grows
     the patches until they join; melting shrinks them back into drifts.
     Any per-tile shape — a blob, a rounded square — prints the tile grid
     back onto a half-melted snowfield as polka dots and lattice lines. */
  let lying = 0;                              // current snow depth, re-read from LG.time each frame
  function readSnow() {
    lying = (LG.time && typeof LG.time.snow === 'number') ? LG.time.snow : 0;
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

  /* The field is sampled on a grid SUB times finer than the tiles, fine
     enough that the edge traced through it (see snowField) reads as a
     curve rather than a polygon. Everything about where snow can lie is
     fixed once the map is built; only the depth moves. So each sample is
     worked out once and kept:
       N  drift noise: where snow lies deepest and melts last.
       E  how far into ground that holds snow the point is, roughened. Its
          zero line runs a few pixels out into the street, so a drift
          covers its own ground and spills raggedly over the kerb instead
          of stopping along a ruler line. (Set on the boundary itself, it
          left grass showing along every street, and pinched into spikes
          round the odd tile of grass the street's edge steps around.)
       S  slope of a gentle relief, facing away from the light (top
          left). Where it's high the snow is in its own shadow, so the
          field has hollows and banks rather than being one flat sheet.
     Each tile also keeps its lowest and highest of each, so a tile wholly
     under snow or wholly clear is settled without going through its
     samples. What's on screen is worked out as it's needed and the rest
     of the map in the background, a few milliseconds at a time: worked
     out only as it came into view, the first step into new ground
     stuttered. */
  const SUB = 8, SW = W * SUB + 1, SH = H * SUB + 1;
  const EK = 0.3;                             // E in depth units, so the snowline interpolates evenly between the two
  const SHADE = 0.09;                         // how steep a slope has to face away to be in shadow
  let N = null, E = null, S = null, lo = null, hi = null, done = null, holds = null, octs = null;
  let cursor = 0, era = 0;
  function forgetSnowField() { N = null; era++; }

  /* One octave of `vnoise`, with its lattice worked out in advance: the
     same values vnoise(x, y, s) gives, at a fraction of the cost. */
  function octave(s) {
    const nx = Math.ceil(W / s) + 2, ny = Math.ceil(H / s) + 2, v = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = hash(i * 3 + s, j * 7 + s);
    return { s, nx, v };
  }
  function oct(o, x, y) {
    const fx = x / o.s, fy = y / o.s, x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0, u = tx * tx * (3 - 2 * tx), w = ty * ty * (3 - 2 * ty);
    const v = o.v, k = y0 * o.nx + x0, k2 = k + o.nx;
    const top = v[k] + (v[k + 1] - v[k]) * u, bot = v[k2] + (v[k2 + 1] - v[k2]) * u;
    return top + (bot - top) * w;
  }
  // hash() runs 0 to 0.5, so its octaves centre on 0.25.
  function relief(x, y) { return oct(octs.r0, x, y) * 0.75 + oct(octs.r1, x, y) * 0.25; }

  function sample(i, j) {
    const k = j * SW + i;
    if (N[k] === N[k]) return k;
    const x = i / SUB, y = j / SUB;
    N[k] = oct(octs.n0, x, y) * 0.56 + oct(octs.n1, x, y) * 0.26 + oct(octs.n2, x, y) * 0.11 + oct(octs.n3, x, y) * 0.07;
    // Which tiles hold snow, blended between tile centres; clamped at the map's edge.
    const u = Math.min(W - 1, Math.max(0, x - 0.5)), v = Math.min(H - 1, Math.max(0, y - 0.5));
    const tx = Math.min(W - 2, u | 0), ty = Math.min(H - 2, v | 0), fx = u - tx, fy = v - ty, t = ty * W + tx;
    const top = holds[t] + (holds[t + 1] - holds[t]) * fx, bot = holds[t + W] + (holds[t + W + 1] - holds[t + W]) * fx;
    E[k] = top + (bot - top) * fy - 0.36 + (oct(octs.e0, x, y) - 0.25) * 0.34 + (oct(octs.e1, x, y) - 0.25) * 0.22;
    // Ground that holds snow is covered right to its edge; only the spill beyond varies.
    const ta = Math.min(W - 1, (i / SUB) | 0), tb = Math.min(H - 1, (j / SUB) | 0);
    const ia = i % SUB ? ta : Math.max(0, ta - 1), jb = j % SUB ? tb : Math.max(0, tb - 1);
    if (holds[tb * W + ta] || holds[tb * W + ia] || holds[jb * W + ta] || holds[jb * W + ia]) E[k] = Math.max(E[k], 0.02);
    // Never inside a building, though: a drift spilling in off the walls would show once the roof lifts.
    if (tiles[tb * W + ta] === T.FLOOR || tiles[tb * W + ia] === T.FLOOR ||
        tiles[jb * W + ta] === T.FLOOR || tiles[jb * W + ia] === T.FLOOR) E[k] = -1;
    const d = 0.25;
    S[k] = (relief(Math.max(0, x - d), Math.max(0, y - d)) - relief(x + d, y + d)) / (2 * d);
    return k;
  }

  function tileField(x, y) {
    const t = y * W + x;
    if (done[t]) return t;
    let n0 = Infinity, n1 = -Infinity, e0 = Infinity, e1 = -Infinity, s0 = Infinity, s1 = -Infinity;
    for (let j = 0; j <= SUB; j++)
      for (let i = 0; i <= SUB; i++) {
        const k = sample(x * SUB + i, y * SUB + j);
        if (N[k] < n0) n0 = N[k];
        if (N[k] > n1) n1 = N[k];
        if (E[k] < e0) e0 = E[k];
        if (E[k] > e1) e1 = E[k];
        if (S[k] < s0) s0 = S[k];
        if (S[k] > s1) s1 = S[k];
      }
    const m = t * 6;
    lo[m] = n0; hi[m] = n1; lo[m + 1] = e0; hi[m + 1] = e1; lo[m + 2] = s0; hi[m + 2] = s1;
    done[t] = 1;
    return t;
  }

  function snowFieldReady() {
    if (N) return;
    octs = { n0: octave(6), n1: octave(2.5), n2: octave(1.1), n3: octave(0.45),
             e0: octave(0.7), e1: octave(1.7), r0: octave(3.2), r1: octave(1.3) };
    N = new Float32Array(SW * SH).fill(NaN); E = new Float32Array(SW * SH); S = new Float32Array(SW * SH);
    lo = new Float32Array(W * H * 6); hi = new Float32Array(W * H * 6); done = new Uint8Array(W * H);
    holds = new Uint8Array(W * H);
    for (let t = 0; t < W * H; t++) holds[t] = holdsDrift(tiles[t]) ? 1 : 0;
    cursor = 0;
    const mine = era, clock = () => performance.now();
    (function slice() {
      if (era !== mine) return;
      const end = clock() + 4;
      while (cursor < W * H && clock() < end) { tileField(cursor % W, (cursor / W) | 0); cursor++; }
      if (cursor < W * H) setTimeout(slice, 16);
    })();
  }

  // How far under the snow a point with drift noise `n` is: positive is snow, negative bare.
  function depth(n) { return lying * 2.4 - n * 1.55; }

  /* Snow depth (0-1) at the middle of one tile, for whatever stands on it
     — a tree's crown, a fence rail, the fountain. Read off the same field
     the ground is drawn from, so a tree in a drift is capped and a tree on
     bare grass isn't. Sharpened toward 0 or 1, since the ground under it
     is either white or it isn't. */
  function snowAt(x, y) {
    if (lying <= 0 || x < 0 || y < 0 || x >= W || y >= H) return 0;
    snowFieldReady();
    tileField(x, y);
    return Math.max(0, Math.min(1, depth(N[(y * SUB + SUB / 2) * SW + x * SUB + SUB / 2]) * 2.2));
  }
  /* Ponds freeze over as one sheet rather than tile by tile — patchy ice
     on open water is the same chessboard as patchy snow. */
  function iceOnWater() { return Math.min(1, lying * 2) * 0.75; }

  /* Tiles that hold a drift. Streets and the station get packed snow
     instead, water gets ice, and indoors gets none. */
  function holdsDrift(t) {
    return t !== T.PATH && t !== T.FOUNTAIN && t !== T.PLATFORM && t !== T.RAIL &&
           t !== T.WATER && t !== T.FLOOR && t !== T.CAVE;
  }

  /* The snowline, as closed loops. Marching squares over the fine grid:
     each cell whose corners disagree adds a stretch of line between the
     points where it crosses the cell's edges, turned so the snow is on
     its right, and the stretches are joined end to end through the edges
     they share. Filled (nonzero), the loops cover everything inside them,
     so a screenful of snow is its outline and nothing more. Built as a
     piece per cell and a rectangle per row of cells, it was tens of
     thousands of shapes, and each fill of it cost Firefox ~10 ms.
     Only cells in tiles the line passes through (`fate` 0) are looked at,
     plus a ring of cells just outside the range, which counts as bare so
     that every loop closes. A cell with two opposite corners inside and a
     bare middle is two corners, not a band across it. Loops aren't
     closePath()ed: fill() closes them, and in Chrome closePath() costs
     over a hundred times what a lineTo() does. */
  /* Scratch for traceLoops, grown as needed and reused: each paint's
     values on a local grid, and per grid edge where the line crosses it
     and which edge the line goes on to. `gen` stamps mark what this paint
     has set, so nothing needs clearing. (Maps keyed by edge made the
     tracing, not the drawing, the slow part of a snowy repaint.) */
  let vals = new Float32Array(0), ex = new Float32Array(0), ey = new Float32Array(0);
  let onward = new Int32Array(0), crossed = new Int32Array(0), linked = new Int32Array(0), gen = 0;
  const starts = [];
  function traceLoops(p, x0, y0, x1, y1, fate, shade) {
    const step = shade ? 2 : 1, per = SUB / step, cols = x1 - x0 + 1, rows = y1 - y0 + 1;
    const I0 = x0 * SUB, I1 = (x1 + 1) * SUB, J0 = y0 * SUB, J1 = (y1 + 1) * SUB, px = TILE / SUB;
    // The range's samples, one step apart, inside a ring of bare ones.
    const LW = (I1 - I0) / step + 3, LH = (J1 - J0) / step + 3, n = LW * LH;
    if (vals.length < n) {
      vals = new Float32Array(n); ex = new Float32Array(2 * n); ey = new Float32Array(2 * n);
      onward = new Int32Array(2 * n); crossed = new Int32Array(2 * n); linked = new Int32Array(2 * n);
    }
    /* Only what's read gets set: the ring, the range's own edge — where a
       wholly snowed-over tile just needs to read as inside, so its loop
       closes out in the ring — and every sample of the tiles the line
       runs through. Working out every sample in range was most of a
       repaint's time in Firefox. */
    for (let li = 0; li < LW; li++) { vals[li] = -1; vals[(LH - 1) * LW + li] = -1; }
    for (let lj = 1; lj < LH - 1; lj++) {
      const row = Math.min((lj - 1) / per | 0, rows - 1) * cols;
      vals[lj * LW] = -1; vals[lj * LW + LW - 1] = -1;
      vals[lj * LW + 1] = fate[row] > 0 ? 1 : -1; vals[lj * LW + LW - 2] = fate[row + cols - 1] > 0 ? 1 : -1;
    }
    for (let li = 1; li < LW - 1; li++) {
      const c = Math.min((li - 1) / per | 0, cols - 1);
      vals[LW + li] = fate[c] > 0 ? 1 : -1; vals[(LH - 2) * LW + li] = fate[(rows - 1) * cols + c] > 0 ? 1 : -1;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (fate[(y - y0) * cols + x - x0] !== 0) continue;
      const li0 = (x - x0) * per + 1, lj0 = (y - y0) * per + 1;
      for (let lj = lj0; lj <= lj0 + per; lj++)
        for (let li = li0, k = lj * LW + li0, g = (J0 + (lj - 1) * step) * SW + I0 + (li0 - 1) * step; li <= li0 + per; li++, k++, g += step) {
          let v = depth(N[g]);
          const e = E[g] * EK;
          if (e < v) v = e;
          if (shade && S[g] - SHADE < v) v = S[g] - SHADE;
          vals[k] = v;
        }
    }
    gen++; starts.length = 0;
    const s = step * px;
    // Edges are numbered by the sample they start from, times two, plus one if they run down.
    function at(e, x, y) { if (crossed[e] !== gen) { crossed[e] = gen; ex[e] = x; ey[e] = y; } return e; }
    function join(a, b) { onward[a] = b; linked[a] = gen; starts.push(a); }
    function cell(li, lj) {
      const k = lj * LW + li, a = vals[k], b = vals[k + 1], c = vals[k + LW + 1], d = vals[k + LW];
      const q = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
      if (q === 0 || q === 15) return;
      const x = (I0 + (li - 1) * step) * px, y = (J0 + (lj - 1) * step) * px;
      const A = q >> 3, B = (q >> 2) & 1, C = (q >> 1) & 1, D = q & 1;
      const T = A !== B ? at(2 * k, x + s * a / (a - b), y) : -1;
      const R = B !== C ? at(2 * (k + 1) + 1, x + s, y + s * b / (b - c)) : -1;
      const Bo = C !== D ? at(2 * (k + LW), x + s * d / (d - c), y + s) : -1;
      const L = D !== A ? at(2 * k + 1, x, y + s * a / (a - d)) : -1;
      switch (q) {                            // from crossing to crossing, snow on the right
        case 1: join(L, Bo); break;          case 14: join(Bo, L); break;
        case 2: join(Bo, R); break;          case 13: join(R, Bo); break;
        case 3: join(L, R); break;           case 12: join(R, L); break;
        case 4: join(R, T); break;           case 11: join(T, R); break;
        case 6: join(Bo, T); break;          case 9: join(T, Bo); break;
        case 7: join(L, T); break;           case 8: join(T, L); break;
        case 5:                                // top right and bottom left
          if (a + b + c + d > 0) { join(L, T); join(R, Bo); } else { join(R, T); join(L, Bo); }
          break;
        case 10:                               // top left and bottom right
          if (a + b + c + d > 0) { join(T, R); join(Bo, L); } else { join(T, L); join(Bo, R); }
          break;
      }
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (fate[(y - y0) * cols + x - x0] !== 0) continue;
      const li0 = (x - x0) * per + 1, lj0 = (y - y0) * per + 1;
      for (let lj = lj0; lj < lj0 + per; lj++) for (let li = li0; li < li0 + per; li++) cell(li, lj);
    }
    for (let li = 0; li < LW - 1; li++) { cell(li, 0); cell(li, LH - 2); }
    for (let lj = 1; lj < LH - 2; lj++) { cell(0, lj); cell(LW - 2, lj); }
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      if (linked[start] !== gen) continue;   // already walked, as part of an earlier loop
      let e = start;
      p.moveTo(ex[e], ey[e]);
      for (;;) {
        const next = onward[e];
        linked[e] = 0;
        if (next === start || linked[next] !== gen) break;
        p.lineTo(ex[next], ey[next]); e = next;
      }
    }
  }

  /* Draws the snow for tiles x0..x1, y0..y1 over already-drawn ground.
     Drifts are the snowline's loops in one path; a thin blue-grey lip
     under each drift — the same path filled first, 2 px lower — is what
     makes a white patch read as snow lying on the grass rather than a
     hole cut in it. (It was the fill's shadow, which Firefox draws through
     an extra offscreen pass: ~20 ms a repaint.) The relief's shadows go
     over that as a second path, only where there's snow, traced at half
     the resolution — they're too faint for the difference to show, and
     it's a quarter of the work. */
  function snowField(ctx, x0, y0, x1, y1) {
    snowFieldReady();
    /* Streets get thin, even, packed snow, never a drift, since they're
       walked constantly. Deliberately capped well short of white: even
       under heavy snowfall, the roads need to stay visually distinct so
       the village's layout still reads. */
    const packed = Math.min(0.5, lying * 0.62), ice = iceOnWater();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = get(x, y);
      if (t === T.WATER) {
        if (ice <= 0.02) continue;
        ctx.fillStyle = 'rgba(206,228,240,' + ice.toFixed(3) + ')';
      } else if (t === T.PATH || t === T.FOUNTAIN || t === T.PLATFORM || t === T.RAIL) {
        if (packed <= 0.02) continue;
        ctx.fillStyle = 'rgba(250,251,255,' + packed.toFixed(3) + ')';
      } else continue;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }

    // Whether each tile is under the drift wholly (1), partly (0) or not at all (-1),
    // and the same for the relief's shadows.
    const n = (x1 - x0 + 1) * (y1 - y0 + 1), fate = new Int8Array(n), shaded = new Int8Array(n);
    for (let y = y0, f = 0; y <= y1; y++) for (let x = x0; x <= x1; x++, f++) {
      const m = tileField(x, y) * 6;
      fate[f] = (hi[m + 1] <= 0 || depth(lo[m]) <= 0) ? -1 : (lo[m + 1] > 0 && depth(hi[m]) > 0) ? 1 : 0;
      shaded[f] = (fate[f] < 0 || hi[m + 2] <= SHADE) ? -1 : (fate[f] > 0 && lo[m + 2] > SHADE) ? 1 : 0;
    }

    const drift = typeof Path2D === 'function' ? new Path2D() : null;
    if (!drift) ctx.beginPath();
    traceLoops(drift || ctx, x0, y0, x1, y1, fate, false);
    if (drift) {
      ctx.fillStyle = 'rgba(90,112,140,.32)';
      ctx.translate(0, 2); ctx.fill(drift); ctx.translate(0, -2);
    }
    ctx.fillStyle = '#fbfcff';
    if (drift) ctx.fill(drift); else ctx.fill();

    ctx.fillStyle = 'rgba(150,172,204,.14)';
    ctx.beginPath();
    traceLoops(ctx, x0, y0, x1, y1, shaded, true);
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
      case T.WATER:                                     // its glint is drawn live, in drawAnimated
        ctx.fillStyle = r < 0.5 ? COLORS.water : COLORS.waterDeep;
        ctx.fillRect(px, py, TILE, TILE);
        break;
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

  /* Draws all ground-standing props (trees, flowers, fences) for a
     region in one batched pass, rather than one call per tile.

     Previously each tree drew 2-3 separate beginPath/arc/fill calls, and
     standing in the woods that added up to a couple hundred paths per
     frame — thousands per second. On Firefox for Android, this wasn't
     just slow: canopies visibly broke apart, with circles rendering as
     horizontal bands smeared across the screen while trunks stayed in
     place. This is the known symptom of `beginPath` calls between arcs
     not taking effect — each `arc` then joins to the previous one with a
     straight line instead of starting a new subpath, and the whole
     accumulated shape gets filled as one.

     The fix here is to batch: circles of one color go into a single path
     (one beginPath, one fill), with an explicit `moveTo` to each circle's
     rim before its `arc` call, which keeps them as separate subpaths
     rather than chained together. Both parts matter — batching means far
     fewer beginPath calls for the bug to trigger on, and the `moveTo`
     means that even if it does trigger, circles still won't chain into bands.

     Reordering draw calls across tiles is safe here because nothing
     drawn for one tile overlaps another tile's drawing: a tree canopy is
     13px wide on a 32px tile and extends from just above its own tile to
     just short of the next row, and the trunk sits within that. The
     original within-tile draw order (trunk, canopy, highlight, snow) is
     preserved by keeping each pass in that order. */
  const FLOWER_COLS = ['#f2c14e', '#e5798f', '#c8a2f2', '#f5f0e6'];

  /* ----------------------------------------------------------- disc sprites
     Batching (above) reduced the number of fill calls, but didn't fully
     fix the Firefox flashing bug, because fill-call count wasn't the
     actual determining factor. Firefox's accelerated canvas rasterizes a
     filled path on the GPU and caches the resulting triangle geometry in
     its own buffer; fillRect, fillText, and drawImage don't use that
     path at all. That distinction lines up exactly with the observed
     bug: in foggy forest scenes, canopies/heads/shadows (filled arcs)
     would drop frames or smear, while trunks, walls, paths, and text
     (rects/images/text) stayed correct. Batching a hundred circles into
     one path still produces a hundred circles' worth of vertices — it
     only reduces the number of draw calls, not the vertex-buffer usage
     that triggers the bug.

     A drawImage blit has no vertices at all, so the fix is to pre-render
     each disc once into its own small offscreen canvas (at device
     resolution) and blit that instead of drawing an arc live — moving
     the work off the buggy vertex-buffer path entirely and onto the one
     that works correctly. Sprites are cached per color+radius and
     invalidated if the device pixel ratio changes.

     Falls back to the original live-arc drawing when no dpr is given
     (mainly in the test environment, which has no real canvas to render
     sprites into), so the drawing code path is still exercised there. */
  const spriteFor = new Map();
  let spriteDpr = 0;
  /* A tree's snow crown at depth step b (of 10): the cap over the canopy
     and the puff on top of it, in tile coordinates from (3, -3). It's
     blitted one texel to one device pixel, at a whole device pixel: a
     sprite stretched by a fraction of a pixel drops a different edge
     column depending on where the layer sits, which put a green rim
     round the cap on one repaint and not the next. */
  function crownColour(a) { return 'rgba(250,252,255,' + (a * 0.92).toFixed(3) + ')'; }
  function crownSprite(b, d) {
    if (d !== spriteDpr) { spriteFor.clear(); spriteDpr = d; }
    const key = 'crown@' + b;
    if (spriteFor.has(key)) return spriteFor.get(key);
    let made = null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(26 * d) + 1;
    canvas.height = Math.ceil(16 * d) + 1;
    const g = canvas.getContext && canvas.getContext('2d');
    if (g && typeof g.arc === 'function') {
      const a = b / 10;
      g.setTransform(d, 0, 0, d, -3 * d, 3 * d);
      g.fillStyle = crownColour(a);
      g.beginPath(); g.moveTo(4, 11); g.arc(16, 11, 12, Math.PI, 0); g.fill();
      g.beginPath(); g.arc(13, 4, 4 + a * 2, 0, Math.PI * 2); g.fill();
      made = { canvas, w: canvas.width / d, h: canvas.height / d };
    }
    spriteFor.set(key, made);
    return made;
  }

  function discSprite(colour, r, d) {
    if (d !== spriteDpr) { spriteFor.clear(); spriteDpr = d; }
    const key = colour + '@' + r;
    if (spriteFor.has(key)) return spriteFor.get(key);
    let made = null;
    // One pixel of margin on each side, so the antialiased rim isn't clipped.
    const size = Math.ceil(r + 1) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size * d);
    canvas.height = Math.round(size * d);
    const g = canvas.getContext && canvas.getContext('2d');
    if (g && typeof g.arc === 'function') {
      g.setTransform(d, 0, 0, d, 0, 0);
      g.fillStyle = colour;
      g.beginPath();
      g.arc(size / 2, size / 2, r, 0, Math.PI * 2);
      g.fill();
      made = { canvas, size, half: size / 2 };
    }
    spriteFor.set(key, made);
    return made;
  }

  function discs(ctx, at, r, colour, dpr) {
    if (!at.length) return;
    const s = dpr ? discSprite(colour, r, dpr) : null;
    if (s) {
      /* One texel to one device pixel, at a whole device pixel (see
         crownSprite): drawn at the half pixel a tree's canopy lands on,
         which way a rim pixel rounded came down to floating-point noise in
         the layer's position, so repaints disagreed along a strip's edge. */
      const side = s.canvas.width / dpr;
      for (let i = 0; i < at.length; i += 2)
        ctx.drawImage(s.canvas, Math.round((at[i] - s.half) * dpr) / dpr, Math.round((at[i + 1] - s.half) * dpr) / dpr, side, side);
      return;
    }
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let i = 0; i < at.length; i += 2) {
      ctx.moveTo(at[i] + r, at[i + 1]);          // starts a new subpath rather than chaining to the previous arc
      ctx.arc(at[i], at[i + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function drawPropsPass(ctx, x0, y0, x1, y1, dpr) {
    const trunks = [], canopy = [[], []], crowns = [], flowers = [[], [], [], []], fences = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = get(x, y);
        if (t !== T.TREE && t !== T.FLOWER && t !== T.FENCE) continue;
        const px = x * TILE, py = y * TILE, r = hash(x, y);
        // Snow depth is only computed for these three prop types --
        // most of a view is grass/path, which don't need it.
        const a = lying > 0 ? snowAt(x, y) : 0;
        if (t === T.TREE) {
          trunks.push(px, py);
          canopy[r < 0.5 ? 0 : 1].push(px + 16, py + 12);
          if (a > 0.03) crowns.push(px, py, a);
        } else if (t === T.FLOWER) {
          if (a > 0.55) continue;                // buried
          flowers[(r * 4) | 0].push(px + 10 + (r * 12 | 0), py + 16 + (r * 10 | 0));
        } else {
          fences.push(px, py, a);
        }
      }
    }

    ctx.fillStyle = '#6b4a2f';
    ctx.beginPath();
    for (let i = 0; i < trunks.length; i += 2) ctx.rect(trunks[i] + 13, trunks[i + 1] + 16, 6, 14);
    ctx.fill();
    discs(ctx, canopy[0], 13, '#3f7d3a', dpr);
    discs(ctx, canopy[1], 13, '#4c8c40', dpr);
    // The highlight wash is identical for every canopy, so it can reuse the same sprite/stamp.
    const lit = [];
    for (let i = 0; i < trunks.length; i += 2) lit.push(trunks[i] + 12, trunks[i + 1] + 8);
    discs(ctx, lit, 6, 'rgba(255,255,255,.10)', dpr);

    /* Snow drawn only on top of the canopy -- the green rim showing
       below a white crown is what makes it read as a snow-laden tree
       rather than a dead/bare one. Crowns come in ten steps of depth and
       are stamped from one sprite per step, like the canopies under them:
       drawn live, a snowed-in forest was two fills, a closePath() and two
       curves a tree, over a thousand trees a screen, and the slowest
       thing to walk into on the whole map. */
    const byDepth = [];
    for (let i = 0; i < crowns.length; i += 3) {
      const b = Math.round(crowns[i + 2] * 10);
      if (b) (byDepth[b] || (byDepth[b] = [])).push(crowns[i], crowns[i + 1]);
    }
    for (let b = 1; b <= 10; b++) {
      const at = byDepth[b];
      if (!at) continue;
      const s = dpr ? crownSprite(b, dpr) : null;
      if (s) {
        for (let i = 0; i < at.length; i += 2)
          ctx.drawImage(s.canvas, Math.round((at[i] + 3) * dpr) / dpr, Math.round((at[i + 1] - 3) * dpr) / dpr, s.w, s.h);
        continue;
      }
      const a = b / 10, colour = crownColour(a), puffs = [];
      ctx.fillStyle = colour;
      ctx.beginPath();
      for (let i = 0; i < at.length; i += 2) {
        ctx.moveTo(at[i] + 4, at[i + 1] + 11);
        ctx.arc(at[i] + 16, at[i + 1] + 11, 12, Math.PI, 0);
        puffs.push(at[i] + 13, at[i + 1] + 4);
      }
      ctx.fill();
      discs(ctx, puffs, 4 + a * 2, colour, dpr);
    }

    for (let i = 0; i < flowers.length; i++) {
      if (!flowers[i].length) continue;
      discs(ctx, flowers[i], 3.5, FLOWER_COLS[i], dpr);
    }

    for (let i = 0; i < fences.length; i += 3) {
      const px = fences[i], py = fences[i + 1], a = fences[i + 2];
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
      ctx.fillStyle = p.li ? '#9b958a' : '#a8a296';
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 24); ctx.lineTo(x + 10, y + 12);
      ctx.arc(x + 16, y + 12, 6, Math.PI, 0);
      ctx.lineTo(x + 22, y + 24);
      ctx.closePath(); ctx.fill();
      if (p.li) {
        ctx.save();
        ctx.fillStyle = '#6f6a60';
        ctx.font = '7px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('老', x + 16, y + 13);
        ctx.fillText('李', x + 16, y + 20);
        ctx.restore();
      } else {
        ctx.fillStyle = '#8d8779'; ctx.fillRect(x + 12, y + 16, 8, 2);
      }
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
    }
    // The ripples, and everything drawn over them, go in drawFountainLive.
  }

  /* The fountain's moving part: ripples, then the snow and plinth that sit
     on top of them. Drawn every frame over the cached ground layer, since
     anything with performance.now() in it would freeze in the cache. */
  function drawFountainLive(ctx, p) {
    const cx = (p.x + 1) * TILE, cy = (p.y + 1) * TILE;
    if (snowAt(p.x, p.y) <= 0.55) {
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
     A sign at every building's door, the noticeboard and the station, in
     the village's language only: no English underneath, and nothing to
     click. `signBoxes` is where each board was last drawn, in world
     coordinates, for the tests. */
  let signBoxes = [];

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

  function drawSigns(ctx, cam, vw, vh, lang, dpr) {
    signBoxes = [];
    const L = LG.LANGUAGES && LG.LANGUAGES[lang];
    const nativeFont = '600 11px ' + ((L && L.fontStack) || 'system-ui');
    /* Sign boards are the one thing here sized by text measurement
       rather than the tile grid — measureText returns a fractional
       width, and centering the board on that width would land its edges
       between device pixels. Since draw() snaps the camera to a fixed
       grid, an unsnapped board would sit at a consistent-but-off-grid
       offset every frame (not flickering, just permanently blurry — its
       1.5px border would render across ~4 device pixels while the tile
       seam beside it renders across 1). Snapping the board to whole
       *device* pixels (not CSS pixels), using the same dpr draw()
       translates by, aligns it back onto the same pixel grid as
       everything else — same reasoning as roofRects, since at a
       fractional dpr, device and CSS pixel grids don't coincide. */
    const d = dpr || 1;
    const snap = v => Math.round(v * d) / d;
    ctx.textAlign = 'center';
    for (const s of signSpots()) {
      if (!inView(s.x - 40, s.y - 40, 80, 40, cam, vw, vh, TILE)) continue;
      const native = LG.placeName(s.key, lang);
      ctx.font = nativeFont;
      const w = snap(ctx.measureText(native).width + 16), h = snap(20);
      const bx = snap(s.x - w / 2), by = snap(s.y - h);

      ctx.fillStyle = '#6b4a2f';                        // the post
      ctx.fillRect(snap(s.x - 2), snap(s.y - 6), snap(4), snap(10));
      ctx.fillStyle = '#e9dcbb';                         // the board
      ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = '#8a6a45'; ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + 0.75, by + 0.75, w - 1.5, h - 1.5);

      ctx.fillStyle = '#3a2e1f';
      ctx.fillText(native, s.x, by + 15);
      signBoxes.push({ x: bx, y: by, w, h, key: s.key });
    }
  }

  /* Called only when game.js repaints its cached ground layer, so the
     snow is drawn straight into that. (It had an offscreen canvas of its
     own from before that cache existed, keyed on the tile range and snow
     bucket — the same things that make the ground layer repaint, so it
     almost never hit, and it was drawn at 1x, which left drifts blocky
     on a high-density screen.) */
  function drawGround(ctx, cam, vw, vh, dpr) {
    readSnow();
    const x0 = Math.max(0, (cam.x / TILE) | 0), y0 = Math.max(0, (cam.y / TILE) | 0);
    const x1 = Math.min(W - 1, ((cam.x + vw) / TILE) | 0), y1 = Math.min(H - 1, ((cam.y + vh) / TILE) | 0);
    if (x1 < x0 || y1 < y0) return;      // a strip of the ground layer lying wholly off the map
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTile(ctx, x, y, x * TILE, y * TILE);
    // Snow drawn after all ground tiles, as a separate pass --
    // drawing it tile-by-tile alongside the ground would let each
    // drift's spillover get clipped again by the following tile's grass.
    if (lying > 0) snowField(ctx, x0, y0, x1, y1);
    drawPropsPass(ctx, x0, y0, x1, y1, dpr);
  }

  /* What moves on its own and isn't a character: water glints and the
     fountain. game.js paints everything else once into a cached layer and
     keeps it until the camera leaves it, so these are drawn fresh on top
     every frame instead. Nothing in that layer overlaps them. */
  function drawAnimated(ctx, cam, vw, vh) {
    readSnow();
    const x0 = Math.max(0, (cam.x / TILE) | 0), y0 = Math.max(0, (cam.y / TILE) | 0);
    const x1 = Math.min(W - 1, ((cam.x + vw) / TILE) | 0), y1 = Math.min(H - 1, ((cam.y + vh) / TILE) | 0);
    const t = performance.now() / 900;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (get(x, y) !== T.WATER) continue;
      const r = hash(x, y);
      if ((t + r * 6) % 4 >= 1) continue;
      // Drawn over the ice rather than under it now, so fade it by as much as the ice would.
      const ice = iceOnWater();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.22 * (1 - ice)).toFixed(3) + ')';
      ctx.fillRect(x * TILE + 6, y * TILE + 10 + (r * 8 | 0), 12, 2);
    }
    for (const p of props)
      if (p.type === 'fountain' && inView(p.x * TILE, p.y * TILE, TILE * 2, TILE * 2, cam, vw, vh, TILE))
        drawFountainLive(ctx, p);
  }

  return { TILE, W, H, T, build, get, isSolid, isWalkable, nearestOpen, pathTo,
           buildingAt, buildingUnder, roofRects, buildingByLabel, inRect, nearRect,
           drawGround, drawBuildings, drawSigns, drawAnimated, buildings,
           // for the tests: what got placed, and where you can get to from here
           _props: () => props, _signs: () => signSpots(), _flood: flood,
           _signBoxes: () => signBoxes };
})();
