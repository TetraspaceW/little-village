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
     station joined it. `LG.chain.generate` picks the terminal item's home
     with `pick(LG.PLACES..., rnd)`, which reads nothing but the list's
     length and order — so growing the list from 17 places to 24 is, on its
     own, enough to send the same seed's item somewhere else. A save written
     under the old list is not wrong, it is answering a question that has
     since changed shape, and the only way to still get its answer is to ask
     the old question — see `withPlacesV1` below.

     This is a historical fact about what `LG.PLACES` *used to be*, not a
     mirror of what it is — it must never be "kept in sync" with the array in
     data.js. */
  const PLACES_V1_IDS = ['pond', 'mine', 'fields', 'green', 'hall', 'woods', 'behind', 'road',
                          'orchard', 'beeyard', 'mill', 'school', 'chapel', 'graves', 'woodpile',
                          'smithy', 'hut'];

  /* `LG.chain.generate` reads `LG.PLACES` only for its length and the order
     of ids in it — see `pick` in chain.js — so a longer list is on its own
     enough to send an unchanged seed's terminal item somewhere else, exactly
     as if the generator's logic had changed. It hasn't; only the list it
     draws from has grown. Replaying the old draw means asking with the old
     list, which is what `PLACES_V1_IDS` is for.

     This is not only asked of a raw version-1 file. Once a village has been
     migrated it goes on saving as version 2 — its coordinates really are
     version 2 now — but its seed still only ever produced this exact plan
     under the old list, forever: `LG.PLACES` is longer with every passing
     version, potentially, and this plan is pinned to how long it was the day
     this village was born. So the plan itself carries `_placesV1`, and
     `save.js`'s `snapshot` writes it into `village.placesV1` on every single
     save from then on, and `restore` reads it back rather than inferring it
     from `v`. Without that, the second time this village was ever closed and
     reopened would regenerate it against a `LG.PLACES` that had grown again,
     fail the digest it had itself just written, and refuse a save that was
     never wrong — see the round trip this is tested against in the smoke
     test.

     This function is the only place the global gets touched, and only for
     the one synchronous call that needs it — put back in a `finally`
     whether or not that call throws. */
  function withPlacesV1(fn) {
    const real = LG.PLACES;
    const byId = {};
    real.forEach(p => { byId[p.id] = p; });
    LG.PLACES = PLACES_V1_IDS.map(id => byId[id]).filter(Boolean);
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

  return { PLACES_V1_IDS, withPlacesV1, migrateV1 };
})();
