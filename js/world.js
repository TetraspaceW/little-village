/* world.js — the little world: tile map, collision, and all canvas drawing. */
window.LG = window.LG || {};

LG.world = (function () {
  const TILE = 32;
  const W = 48, H = 34;

  const T = { GRASS:0, PATH:1, TREE:2, WATER:3, WALL:4, DOOR:5, ROCK:6, FLOWER:7,
              CROP:8, FENCE:9, SAND:10, CAVE:11, FLOOR:12, REED:13, FOUNTAIN:14 };
  const SOLID = { 2:1, 3:1, 4:1, 5:1, 6:1, 9:1, 12:1, 14:1 };

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
    rect(x + 1, y + 1, w - 2, h - 2, T.FLOOR);
    set(doorX, y + h - 1, T.DOOR);
    buildings.push(Object.assign({ x, y, w, h, doorX, doorY: y + h - 1 }, opts));
    labels.push({ x: x + w / 2, y: y - 0.4, text: opts.label });
  }

  function build() {
    tiles = new Uint8Array(W * H).fill(T.GRASS);
    buildings.length = 0; labels.length = 0; props.length = 0;

    // scattered trees round the edges
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      const r = hash(x, y);
      if (edge < 2) set(x, y, T.TREE);
      else if (edge < 4 && r < 0.45) set(x, y, T.TREE);
      else if (r < 0.035) set(x, y, T.TREE);
      else if (r > 0.975) set(x, y, T.FLOWER);
    }

    // ---- roads
    rect(10, 13, 36, 2, T.PATH);         // main east-west street
    rect(22, 4, 2, 26, T.PATH);          // north-south street
    rect(30, 22, 12, 2, T.PATH);         // lane to the farm
    rect(8, 20, 2, 4, T.PATH);           // lane down to the pond

    // ---- village square (with a fountain)
    rect(19, 15, 8, 6, T.PATH);
    rect(22, 17, 2, 2, T.FOUNTAIN);
    props.push({ type: 'fountain', x: 22, y: 17 });

    // ---- buildings
    addBuilding(14, 5, 7, 6, 17, { label: 'Bakery', sign: '🥖', roof: '#b5563f', wall: '#e8d5b7' });
    addBuilding(29, 7, 7, 6, 32, { label: 'Shop',   sign: '🏪', roof: '#4a6fa5', wall: '#e8d5b7' });
    addBuilding(35, 17, 7, 6, 38, { label: 'Farmhouse', sign: '🏡', roof: '#7a5c3e', wall: '#f0e2c8' });

    // ---- the mine: a rocky hillside on the west with a cave mouth
    rect(2, 9, 8, 9, T.ROCK);
    rect(3, 11, 5, 5, T.CAVE);
    rect(5, 16, 2, 3, T.PATH);         // cave mouth
    rect(5, 18, 6, 1, T.PATH);         // trail along the foot of the hill
    rect(10, 15, 1, 4, T.PATH);        // ...up to the street
    labels.push({ x: 6, y: 8.4, text: 'Mine' });

    // ---- the pond, south-west
    for (let y = 23; y < 31; y++) for (let x = 3; x < 16; x++) {
      const dx = (x - 9.5) / 6.5, dy = (y - 27) / 3.6;
      const d = dx * dx + dy * dy;
      if (d < 1) set(x, y, T.WATER);
      else if (d < 1.2) set(x, y, hash(x, y) < 0.28 ? T.REED : T.SAND);
    }
    labels.push({ x: 9.5, y: 21.6, text: 'Pond' });

    // ---- the farm fields, south-east
    rect(31, 26, 13, 5, T.CROP);
    for (let x = 30; x <= 44; x++) { set(x, 25, T.FENCE); set(x, 31, T.FENCE); }
    for (let y = 25; y <= 31; y++) { set(30, y, T.FENCE); set(44, y, T.FENCE); }
    set(36, 25, T.PATH); // gate
    labels.push({ x: 37, y: 24.4, text: 'Fields' });

    return { W, H, TILE };
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
    return { x: 22, y: 14 };
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
      case T.FLOOR: ctx.fillStyle = '#8a6a4d'; ctx.fillRect(px, py, TILE, TILE); break;
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
    if (t === T.TREE) {
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(px + 13, py + 16, 6, 14);
      const g = r < 0.5 ? '#3f7d3a' : '#4c8c40';
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px + 16, py + 12, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.arc(px + 12, py + 8, 6, 0, Math.PI * 2); ctx.fill();
    } else if (t === T.FLOWER) {
      const cols = ['#f2c14e', '#e5798f', '#c8a2f2', '#f5f0e6'];
      ctx.fillStyle = cols[(r * 4) | 0];
      ctx.beginPath(); ctx.arc(px + 10 + (r * 12 | 0), py + 16 + (r * 10 | 0), 3.5, 0, Math.PI * 2); ctx.fill();
    } else if (t === T.FENCE) {
      ctx.fillStyle = '#9a7b52';
      ctx.fillRect(px + 4, py + 8, 4, 20);
      ctx.fillRect(px + 22, py + 8, 4, 20);
      ctx.fillRect(px, py + 13, TILE, 4);
    }
  }

  function drawProp(ctx, p) {
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
    const t = performance.now() / 700;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2;
    for (let i = 0; i < 2; i++) {
      const rr = 6 + ((t + i * 0.5) % 1) * 16;
      ctx.globalAlpha = 1 - ((t + i * 0.5) % 1);
      ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c2bbac';                        // little central plinth
    ctx.fillRect(cx - 4, cy - 16, 8, 16);
    ctx.beginPath(); ctx.arc(cx, cy - 18, 6, 0, Math.PI * 2); ctx.fill();
  }

  function drawBuildings(ctx) {
    for (const p of props) drawProp(ctx, p);
    for (const b of buildings) {
      const px = b.x * TILE, py = b.y * TILE, pw = b.w * TILE, ph = b.h * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(px + 6, py + 10, pw, ph);
      ctx.fillStyle = b.wall; ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = b.roof; ctx.fillRect(px - 6, py - 10, pw + 12, TILE * 2);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(px - 6, py + TILE * 2 - 16, pw + 12, 6);
      ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(px - 6, py - 10, pw + 12, 4);
      ctx.fillStyle = 'rgba(0,0,0,.10)';                        // plank courses
      for (let yy = py + TILE * 2 + 34; yy < py + ph; yy += 12) ctx.fillRect(px, yy, pw, 2);
      ctx.fillStyle = '#8a6a4d'; ctx.fillRect(px, py + ph - 7, pw, 7);
      // windows
      ctx.fillStyle = '#3d5468';
      for (let i = 1; i < b.w - 1; i += 2) ctx.fillRect(px + i * TILE + 6, py + TILE * 2 + 8, 20, 18);
      // door
      const dx = b.doorX * TILE, dy = (b.y + b.h - 1) * TILE;
      ctx.fillStyle = '#5b3d26'; ctx.fillRect(dx + 3, dy - 6, TILE - 6, TILE + 6);
      ctx.fillStyle = '#d8b25e'; ctx.beginPath(); ctx.arc(dx + TILE - 10, dy + 12, 2.5, 0, Math.PI * 2); ctx.fill();
      // hanging sign
      ctx.font = '20px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(b.sign, px + pw / 2, py + TILE * 2 - 4);
    }
  }

  function drawLabels(ctx) {
    ctx.font = '600 13px system-ui';
    ctx.textAlign = 'center';
    for (const l of labels) {
      const x = l.x * TILE, y = l.y * TILE;
      const w = ctx.measureText(l.text).width + 14;
      ctx.fillStyle = 'rgba(28,24,20,.55)';
      ctx.fillRect(x - w / 2, y - 14, w, 19);
      ctx.fillStyle = '#f6efe2';
      ctx.fillText(l.text, x, y);
    }
  }

  function drawGround(ctx, cam, vw, vh) {
    const x0 = Math.max(0, (cam.x / TILE) | 0), y0 = Math.max(0, (cam.y / TILE) | 0);
    const x1 = Math.min(W - 1, ((cam.x + vw) / TILE) | 0), y1 = Math.min(H - 1, ((cam.y + vh) / TILE) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTile(ctx, x, y, x * TILE, y * TILE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawProps(ctx, x, y, x * TILE, y * TILE);
  }

  return { TILE, W, H, T, build, get, isSolid, isWalkable, nearestOpen,
           drawGround, drawBuildings, drawLabels, buildings };
})();
