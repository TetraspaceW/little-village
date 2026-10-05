/* save-migrate.js — turning an old save into the shape this version reads.

   Saves before version 3 held only the village's seed, plus a digest of
   what the generator built from it; version 1 also predates the map moving
   south for the forest. Everything that knows those shapes lives here, so
   save.js only ever deals with the current one. */
window.LG = window.LG || {};

LG.saveMigrate = (function () {
  /* ------------------------------------------------------- migrating v1
     The village moved 40 tiles south as a block, so migrating a v1 save is
     adding the same number to every y. This is a fact about how v1 became
     v2 and stays 40 whatever LG.NORTH_WOODS becomes. */
  const V1_SHIFT_TILES = 40;
  function shiftPx(n) { return n + V1_SHIFT_TILES * LG.world.TILE; }
  function shiftTile(n) { return n + V1_SHIFT_TILES; }
  function shiftRectV1(r) { return r ? { x: r.x, y: r.y + V1_SHIFT_TILES, w: r.w, h: r.h } : null; }

  /* LG.PLACES as it was before the forest and station joined it: what a v1
     save's seed was drawn against. Frozen; never keep it in step with
     data.js. */
  const PLACES_V1_IDS = ['pond', 'mine', 'fields', 'green', 'hall', 'woods', 'behind', 'road',
                          'orchard', 'beeyard', 'mill', 'school', 'chapel', 'graves', 'woodpile',
                          'smithy', 'hut'];

  /* Runs `fn` with LG.PLACES restricted to `ids`, in that order: the
     generator's pick() reads only the list's length and order, so this
     replays an old draw. Put back in `finally` whatever happens. */
  function withPlaces(ids, fn) {
    const real = LG.PLACES;
    const byId = {};
    real.forEach(p => { byId[p.id] = p; });
    LG.PLACES = ids.map(id => byId[id]).filter(Boolean);
    try { return fn(); } finally { LG.PLACES = real; }
  }

  /* Shifts the coordinates, and notes that the seed was drawn against the v1
     place list. Notes, deeds, tills and the rest are left as they were. */
  function migrateV1(data, version) {
    const out = JSON.parse(JSON.stringify(data));
    out.v = version;
    if (out.village && !out.village.plan) out.village.placesV1 = true;
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

  /* ------------------------------------------------- saves without a plan
     The fingerprint a pre-v3 save kept of its generated village (cast,
     trades, fact ids and text). */
  function digestOf(plan) {
    if (!plan) return '';
    const parts = [plan.seed, plan.level, plan.prize, plan.terminal.item, plan.terminal.placeId];
    plan.links.forEach(lk => parts.push(lk.npcId + '>' + lk.wants + ':' + lk.wantsCount +
                                        '>' + lk.gives + ':' + lk.givesCount));
    Object.keys(plan.facts).forEach(id => parts.push(id + '=' + plan.facts[id].text));
    let h = 2166136261;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  /* Rebuilds the plan a pre-v3 save's seed produced, against the place list
     it was drawn from: its own `placesSnapshot`, or the v1 list for a v1
     save or one flagged `placesV1`. Returns the plan, or why it can't: if
     the generator or its content has changed since, the seed no longer
     builds the village the notebook refers to. */
  function regenerate(village) {
    const list = village.placesSnapshot || (village.placesV1 ? PLACES_V1_IDS : null);
    const build = () => LG.chain.generate({ level: village.level, seed: village.seed });
    let plan;
    try { plan = list ? withPlaces(list, build) : build(); }
    catch (e) { return 'the generator could not rebuild that village at all'; }
    if (digestOf(plan) !== village.digest) return 'that village was built by a different version of the generator';
    return plan;
  }

  return { PLACES_V1_IDS, withPlaces, migrateV1, digestOf, regenerate };
})();
