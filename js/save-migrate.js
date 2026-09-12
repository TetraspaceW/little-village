/* save-migrate.js — turning an old save into the shape this version reads.

   `save.js` refuses a save that no longer matches what the generator would
   build from its seed — see the digest check there — except for the one
   difference it knows how to undo on purpose: the map moving south for the
   forest. That translation, and the historical fact about the place list it
   depends on, live here rather than in `save.js` itself or in `data.js`
   alongside the current places, because neither of those files should have
   to know the shape of every save this version has ever stopped writing. */
window.LG = window.LG || {};

LG.saveMigrate = (function () {
  /* ------------------------------------------------------- migrating v1
     The village moved 40 tiles south, as a block, to make room for the
     forest — nothing rotated or resized, so "migrate" is only ever "add the
     same number to every y". `V1_SHIFT_TILES` is that number, and it is a
     historical fact about how v1 became v2: it must stay 40 forever, however
     LG.NORTH_WOODS (which happens to be 40 today too) goes on to change.

     A save has exactly three shapes of coordinate in it — a pixel point, a
     tile point, and a rectangle — and every one of them gets the same
     treatment regardless of which villager or object it belongs to, which is
     the point of pulling it out to one place rather than shifting fields by
     hand wherever they turn up. */
  const V1_SHIFT_TILES = 40;
  function shiftPx(n) { return n + V1_SHIFT_TILES * LG.world.TILE; }
  function shiftTile(n) { return n + V1_SHIFT_TILES; }
  function shiftRectV1(r) { return r ? { x: r.x, y: r.y + V1_SHIFT_TILES, w: r.w, h: r.h } : null; }

  /* The order and membership `LG.PLACES` had before the forest and the
     station joined it — a historical fact about what the list *used to be*,
     not a mirror of what it is. It must never be "kept in sync" with the
     array in data.js. Kept only as the snapshot for a raw version-1 file,
     which predates plans recording their own (see `placesSnapshot` below,
     and `LG.chain.generate`'s `attempt()`) — everything generated since
     carries the list it actually needs replayed against, so this one stays
     frozen at exactly 17 entries rather than growing a `PLACES_V2_IDS`
     beside it. */
  const PLACES_V1_IDS = ['pond', 'mine', 'fields', 'green', 'hall', 'woods', 'behind', 'road',
                          'orchard', 'beeyard', 'mill', 'school', 'chapel', 'graves', 'woodpile',
                          'smithy', 'hut'];

  /* `LG.chain.generate` reads `LG.PLACES` only for its length and the order
     of ids in it — see `pick` in chain.js — so a longer list is on its own
     enough to send an unchanged seed's terminal item somewhere else, exactly
     as if the generator's logic had changed. It hasn't; only the list it
     draws from has grown. Replaying the old draw means asking with the same
     list of ids the plan was actually drawn against, which every plan now
     records as its own `placesSnapshot` at generation time — this function
     just restricts `LG.PLACES` to whichever `ids` it's handed for the one
     synchronous call that needs it, so `save.js`'s `restore()` can replay
     any village's original draw this way, new or years old, rather than
     every list-growing change needing its own hardcoded frozen array and
     its own flag to say so (`PLACES_V1_IDS` above is what's left of that,
     kept only for saves too old to carry a `placesSnapshot` at all).

     This is the only place the global gets touched, and only for the one
     synchronous call passed in — put back in a `finally` whether or not
     that call throws. */
  function withPlaces(ids, fn) {
    const real = LG.PLACES;
    const byId = {};
    real.forEach(p => { byId[p.id] = p; });
    LG.PLACES = ids.map(id => byId[id]).filter(Boolean);
    try { return fn(); } finally { LG.PLACES = real; }
  }

  /* Everything else in a save — notes, deeds, the till, the board, who knows
     what — is not shaped like a place, and is left exactly as it was. */
  function migrateV1(data, version) {
    const out = JSON.parse(JSON.stringify(data));
    out.v = version;
    if (out.player) out.player.y = shiftPx(out.player.y);
    Object.keys(out.villagers || {}).forEach(id => {
      const v = out.villagers[id];
      v.y = shiftPx(v.y);
      if (typeof v.ty === 'number') v.ty = shiftTile(v.ty);
      v.patch = shiftRectV1(v.patch);
    });
    const t = out.terminal;
    if (t) {
      t.y = shiftPx(t.y);
      if (typeof t.ty === 'number') t.ty = shiftTile(t.ty);
      if (t.home) t.home = shiftRectV1(t.home);
    }
    return out;
  }

  return { PLACES_V1_IDS, withPlaces, migrateV1 };
})();
