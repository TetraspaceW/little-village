/* save.js — persists and restores village state (localStorage + server).

   A village's full state — its errand chain, calendar, purse, notebook,
   and 13 villagers' memories — lives only in memory otherwise, so nothing
   survives closing the tab. That matters because an errand is meant to
   span multiple in-game days and a villager's memory of the player is
   meant to persist.

   One format, in one place. Every save is a plain versioned JSON object,
   built by exactly one function (`snapshot`) and restored by exactly one
   function (`restore`). Both storage backends — this browser's
   localStorage, and the log server's `saves/` directory — store and
   return the identical bytes, so a save written by either is readable by
   the other with no conversion step. That symmetry is the reason for
   this design, rather than having the server maintain its own
   representation of a village.

   What's excluded: API keys. Saves may end up written to disk and copied
   around, so keys stay only in `lg-settings` with the rest of the
   settings. Language and difficulty ARE included, since the village is
   generated from them — loading a save under a different language/
   difficulty would produce a different village despite the same seed.

   The village itself isn't stored — only its generation seed. The
   generator is deterministic: the same seed + difficulty always
   regenerates the same chain, facts (with the same ids), and cast. So a
   save stores the seed plus a digest of what the generator produced, and
   `restore` regenerates the village from the seed and checks the digest
   matches. If a newer version of the generator produces something
   different from the same seed, the save is refused explicitly rather
   than being loaded against a chain whose fact ids no longer mean what
   the notebook thinks they mean.

   Exception: differences this version knows how to migrate. When the map
   was shifted south to make room for the forest, that changed what a
   save's stored coordinates mean without changing the village they
   describe — `migrateV1` below handles that one specific, known case.
   This is a one-off compatibility shim for that change, not a general
   guarantee that saves stay loadable across all future versions. */
window.LG = window.LG || {};

LG.save = (function () {
  /* Version 2: the map grew (forest to the north, railway halt to the
     east), shifting the whole village south. Version 1 saves aren't
     refused for this alone — `migrateV1` below shifts every coordinate
     field by the same fixed amount the village moved. The one non-
     coordinate exception is where the errand's terminal item ended up,
     which gets re-derived under the old place list instead (see
     `migrateV1` / `withPlacesV1`). */
  const VERSION = 2;
  const KEY = 'lg-save';                 // localStorage
  const ENDPOINT = '/save';              // the log server, when there is one
  const EVERY = 20;                      // seconds between autosaves

  let since = 0;                         // seconds since the last write
  let server = true;                     // flips false once a server save request fails
  let serverOk = false;                  // true once the server has actually accepted a save
  let lastAt = '';                       // timestamp of the last write, for the settings panel
  let resumed = false;                   // true if this session was restored from a save
  let writes = 0;                        // count of saves written this session

  function http() {
    return typeof fetch === 'function' &&
           typeof location !== 'undefined' && /^https?:/.test(location.protocol);
  }

  /* ------------------------------------------------------------- digest
     Cheap fingerprint of the generated village (cast, trades, fact ids —
     not the save file itself), used to detect when a seed no longer
     regenerates the same village the notebook was built against. */
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

  /* --------------------------------------------------------------- rects
     A villager's `patch` is a reference to one of the game's actual
     rectangle objects (their home, a shop interior, the green). Saved as
     plain {x,y,w,h} numbers and, on load, matched back to the real
     rectangle object with the same bounds — needed because npc.js does
     identity comparisons (`want === a.patch`) that a freshly-deserialized
     plain object with matching coordinates wouldn't pass. */
  function rectOut(r) { return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null; }
  function sameRect(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }
  function rectIn(npc, r) {
    if (!r) return npc.def.home;
    const known = [npc.def.home, npc.work, npc.shelter, LG.GREEN, LG.BOARD_SPOT]
      .concat(LG.world.buildings.map(b => b.inside));
    return known.find(k => sameRect(k, r)) || { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  /* ------------------------------------------------------- migrating v1
     The village moved 40 tiles south as a block (no rotation/resizing),
     so migration is just "add 40 to every y". `V1_SHIFT_TILES` is a fixed
     historical constant describing the v1→v2 change specifically — it
     must stay 40 forever regardless of what LG.NORTH_WOODS (currently
     also 40) changes to later.

     A save's coordinates only ever take one of three shapes — pixel
     point, tile point, or rectangle — so those three shift helpers are
     applied uniformly wherever a coordinate appears, rather than
     hand-shifting each field inline. */
  const V1_SHIFT_TILES = 40;
  function shiftPx(n) { return n + V1_SHIFT_TILES * LG.world.TILE; }
  function shiftTile(n) { return n + V1_SHIFT_TILES; }
  function shiftRectV1(r) { return r ? { x: r.x, y: r.y + V1_SHIFT_TILES, w: r.w, h: r.h } : null; }

  /* `LG.chain.generate` picks the terminal item's place using only
     `LG.PLACES`'s length and id order (see `pick` in chain.js) — so if
     that list has grown since a village was generated, regenerating from
     the same seed would pick a different place, even though nothing about
     the generator's logic changed. `LG.PLACES_V1_IDS` is the frozen v1
     list, used via `withPlacesV1` to replay the original draw.

     This applies beyond raw v1 files: once a village has been migrated,
     it keeps saving as version 2 (its coordinates really are v2 now), but
     its seed was always drawn against the *old* place list, permanently —
     `LG.PLACES` may keep growing in later versions. So the plan carries a
     `_placesV1` flag, `snapshot` writes it into `village.placesV1` on
     every subsequent save, and `restore` reads that flag rather than
     inferring it from the save's version number. Without this, reopening
     such a village a second time would regenerate it against a
     since-grown `LG.PLACES`, produce a different digest than the one it
     had itself just written, and refuse a perfectly valid save. (Covered
     by the round-trip case in the smoke test.)

     This is the only place `LG.PLACES` is mutated, and only for the
     single synchronous call passed in — always restored in `finally`,
     even if that call throws. */
  function withPlacesV1(fn) {
    const real = LG.PLACES;
    const byId = {};
    real.forEach(p => { byId[p.id] = p; });
    LG.PLACES = LG.PLACES_V1_IDS.map(id => byId[id]).filter(Boolean);
    try { return fn(); } finally { LG.PLACES = real; }
  }

  /* Everything else in a save (notes, deeds, till, board, who knows what)
     doesn't contain coordinates and is left untouched. */
  function migrateV1(data) {
    const out = JSON.parse(JSON.stringify(data));
    out.v = VERSION;
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

  /* ------------------------------------------------------------ snapshot */
  function snapshot() {
    const g = LG.game, plan = g.plan;
    if (!plan) return null;
    const st = g.state, p = g.player;

    const villagers = {};
    g.npcs.forEach(n => {
      villagers[n.id] = {
        x: round(n.px), y: round(n.py), tx: n.tx, ty: n.ty, dir: n.dir,
        facts: n.facts.slice(),
        memory: (n.memory || []).slice(),
        factAt: Object.assign({}, n.factAt),
        factNote: Object.assign({}, n.factNote),
        coins: n.coins,
        stock: Object.assign({}, n.stock),
        sold: Object.assign({}, n.sold),
        till: (n.till || []).slice(),
        history: (n.history || []).slice(),
        met: !!n.metPlayer, traded: !!n.tradeDone, named: !!n.nameKnown,
        patch: rectOut(n.patch)
      };
    });

    const t = g.beast
      /* `home` is the area the creature wanders when unheld, and it can
         change during play (e.g. returning the goat updates its home from
         the hillside it strayed to, to the farmer's yard). Must be saved
         explicitly — saving only its current position would put it back
         at the old home area on reload. */
      ? { kind: 'beast', x: round(g.beast.px), y: round(g.beast.py),
          tx: g.beast.tx, ty: g.beast.ty, home: rectOut(g.beast.home),
          caught: !!g.beast.caught, following: !!g.beast.following }
      : g.worldItem
        ? { kind: 'item', x: round(g.worldItem.px), y: round(g.worldItem.py),
            taken: !!g.worldItem.taken }
        : null;

    return {
      v: VERSION,
      game: 'little-village',
      saved: new Date().toISOString(),
      village: { seed: plan.seed, level: g.settings.level, lang: g.settings.lang,
                 digest: digestOf(plan), placesV1: !!plan._placesV1 },
      /* Weather affects villager behavior (see byDice() in npc.js) and
         accumulated snow depth takes multiple in-game days to build up —
         both must be restored exactly, not re-randomized on load. */
      time: { day: LG.time.day, frac: LG.time.frac, weather: LG.time.weather,
              hold: LG.time.weatherLeft, snow: LG.time.snow },
      player: { x: round(p.px), y: round(p.py), dir: p.dir },
      inventory: Object.assign({}, st.inv),
      // no `done`: whether a lead is spent is read off the world, not stored
      notes: st.notes.map(n => ({ id: n.id, text: n.text, ruby: n.ruby || null })),
      deeds: st.deeds.slice(),
      board: (st.board || []).map(b => ({ npcId: b.npcId, name: b.name, text: b.text,
                                          translation: b.translation || '', roman: b.roman || '',
                                          factIds: (b.factIds || []).slice(), at: b.at || '' })),
      won: !!st.won,
      terminal: t,
      villagers: villagers
    };
  }

  function round(n) { return Math.round(Number(n) * 10) / 10; }

  /* ------------------------------------------------------------- restore
     Returns null on success, or a human-readable string explaining the
     failure — callers display this rather than failing silently, so a
     rejected save is distinguishable from one that was simply never
     written. */
  function restore(data) {
    const why = check(data);
    if (why) return why;
    const g = LG.game;

    /* Two distinct questions, easy to conflate since one file can answer
       both: (1) "is this a raw v1 file?" — determines whether coordinates
       need shifting (a one-time operation; the result is always written
       back as v2), and (2) "was this village's plan built under the old
       place list?" — determines how to regenerate that plan (see
       `withPlacesV1`), and stays true permanently once set. A raw v1 file
       is both; a v2 resave of a formerly-v1 village is only the second.
       `data` itself isn't mutated by migration — it may have come from
       the server, and mutating the caller's object would be a surprise. */
    const isRawV1 = data.v === 1;
    const usePlacesV1 = isRawV1 || !!(data.village && data.village.placesV1);
    data = isRawV1 ? migrateV1(data) : data;

    /* All validation happens before any game state is touched. The
       generator runs once here purely to check the digest still matches —
       validating only after mutating state would risk discarding the
       currently-running village on a rejected load, which matters since
       this can be called with a save arriving from the server mid-session. */
    let candidate = null;
    try {
      candidate = usePlacesV1
        ? withPlacesV1(() => LG.chain.generate({ level: data.village.level, seed: data.village.seed }))
        : LG.chain.generate({ level: data.village.level, seed: data.village.seed });
    }
    catch (e) { return 'the generator could not rebuild that village at all'; }
    if (digestOf(candidate) !== data.village.digest) {
      return 'that village was built by a different version of the generator';
    }

    /* Difficulty/language must be set before newVillage() runs, since the
       village is generated from them. newVillage() builds its own plan
       from the seed rather than reusing `candidate` above, so it needs
       withPlacesV1 applied too — otherwise it could build a different plan
       from the same seed than the one just verified against the digest.
       The resulting plan is tagged with _placesV1 so future saves of this
       village keep using the same place list. */
    g.settings.lang = data.village.lang;
    g.settings.level = data.village.level;
    if (usePlacesV1) withPlacesV1(() => g.newVillage(data.village.seed, true));
    else g.newVillage(data.village.seed, true);
    g.plan._placesV1 = usePlacesV1;

    const tm = data.time || {};
    LG.time.start(tm.day, tm.frac);
    LG.time.setWeather(tm.weather, tm.hold);
    LG.time.setSnow(tm.snow);

    const p = g.player;
    p.px = data.player.x; p.py = data.player.y; p.dir = data.player.dir || 'down';
    p.tx = (p.px / LG.world.TILE) | 0; p.ty = (p.py / LG.world.TILE) | 0;

    const st = g.state;
    st.inv = Object.assign({}, data.inventory);
    st.notes = (data.notes || []).filter(n => g.plan.facts[n.id])
      .map(n => ({ id: n.id, text: n.text, ruby: n.ruby || null }));
    st.deeds = (data.deeds || []).slice();
    st.board = (data.board || []).map(b => ({
      npcId: b.npcId, name: b.name, text: b.text,
      translation: b.translation || '', roman: b.roman || '',
      factIds: (b.factIds || []).filter(id => g.plan.facts[id]), at: b.at || ''
    }));
    st.won = !!data.won;

    g.npcs.forEach(n => {
      const s = (data.villagers || {})[n.id];
      if (!s) return;
      n.px = s.x; n.py = s.y; n.tx = s.tx; n.ty = s.ty; n.dir = s.dir || 'down';
      n.facts = (s.facts || []).filter(id => g.plan.facts[id]);
      /* Older saves stored memory entries as bare strings, before they
         gained `at`/`from` fields. Normalize on load so older saves still
         work — an undated entry is treated as one the villager has simply
         had for a while. */
      n.memory = (s.memory || []).map(m =>
        typeof m === 'string' ? { at: null, text: m, from: null } : m).filter(m => m && m.text);
      n.factAt = Object.assign({}, s.factAt);
      n.factNote = Object.assign({}, s.factNote);
      n.coins = typeof s.coins === 'number' ? s.coins : n.coins;
      n.stock = Object.assign({}, s.stock);
      n.sold = Object.assign({}, s.sold);
      n.till = (s.till || []).slice();
      n.history = (s.history || []).slice();
      n.metPlayer = !!s.met; n.tradeDone = !!s.traded; n.nameKnown = !!s.named;
      n.patch = rectIn(n, s.patch);
      /* Any in-progress state (route, pending decision, active bubble/
         conversation) is discarded rather than restored — it refers to a
         moment that's now over, and the villager will simply reconsider
         on the next tick, same as they normally would. */
      n.route = null; n.wantsGo = null; n.deciding = false; n.thought = null;
      n.chatting = false; n.frozen = false; n.bubble = null; n.bubbleT = 0;
    });

    const t = data.terminal;
    if (t && t.kind === 'beast' && g.beast) {
      g.beast.px = t.x; g.beast.py = t.y; g.beast.tx = t.tx; g.beast.ty = t.ty;
      g.beast.caught = !!t.caught; g.beast.following = !!t.following;
      if (t.home) g.beast.home = rectOut(t.home);
    } else if (t && t.kind === 'item' && g.worldItem) {
      g.worldItem.px = t.x; g.worldItem.py = t.y; g.worldItem.taken = !!t.taken;
    }

    resumed = true;
    since = 0;
    g.renderHUD();
    return null;
  }

  /* Validates a save file's basic shape before it's used.

     Version 1 is deliberately accepted here (restore() migrates it rather
     than rejecting it) — this is the one place where "current version"
     and "loadable version" differ. Anything older, or from a future
     version this code can't read, is rejected: migration support is
     added deliberately per-version, not owed indefinitely. */
  function check(data) {
    if (!data || typeof data !== 'object') return 'there was nothing readable in it';
    if (data.game !== 'little-village') return 'that is not a village';
    if (data.v !== VERSION && data.v !== 1) {
      return 'that save is from version ' + data.v + ', and this is version ' + VERSION;
    }
    const v = data.village || {};
    if (!v.seed) return 'it does not say which village it is';
    if (!LG.LEVELS[v.level]) return 'it is at a difficulty this version does not have';
    if (!LG.LANGUAGES[v.lang]) return 'it is in a language this version does not speak';
    if (!data.player || !data.villagers) return 'it is missing half of itself';
    return null;
  }

  /* ---------------------------------------------------------------- sinks
     Both backends are given the identical serialized string. Neither is a
     hard requirement — no localStorage (e.g. a private window) and no
     server are both handled gracefully; the game keeps working either way. */
  function toLocal(text) {
    try { localStorage.setItem(KEY, text); return true; } catch (e) { return false; }
  }
  function fromLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function toServer(text, leaving) {
    if (!server || !http()) return;
    /* A normal fetch started as the tab is closing is usually aborted
       mid-flight. sendBeacon is guaranteed by the browser to complete, so
       the server's copy doesn't end up lagging localStorage by up to one
       autosave interval. */
    if (leaving && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try { navigator.sendBeacon(ENDPOINT, new Blob([text], { type: 'application/json' })); return; }
      catch (e) { /* fall through and try it the ordinary way */ }
    }
    fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
      .then(r => { if (r.ok || r.status === 204) serverOk = true; else server = false; })
      .catch(() => { server = false; });     // no server, or not that sort of server
  }
  function fromServer() {
    if (!server || !http()) return Promise.resolve(null);
    return fetch(ENDPOINT, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  /* ----------------------------------------------------------- the writing */
  function write(leaving) {
    const shot = snapshot();
    if (!shot) return null;
    const text = JSON.stringify(shot);
    toLocal(text);
    toServer(text, leaving);
    lastAt = shot.saved;
    since = 0;
    writes++;
    return shot;
  }

  /* Called from the game loop every frame. Doesn't try to detect whether
     anything actually changed since the last save — the village is always
     changing (villagers walking, thinking) — an unconditional save every
     EVERY seconds is cheaper than tracking dirty state. */
  function tick(dt) {
    since += dt;
    if (since < EVERY) return;
    since = 0;
    write();
  }

  /* ---------------------------------------------------------- the reading
     Loads the local copy first (synchronous, immediately available), then
     asynchronously checks the server copy and switches to it only if its
     timestamp is strictly newer — the case where the player last played
     in a different browser, or cleared this one's storage. Since both
     backends are written together, they're usually identical and the
     server check is a no-op. */
  function resume(say) {
    const local = fromLocal();
    const wrote = writes;
    let have = local ? local.saved : '';
    if (local) {
      const why = restore(local);
      if (why) { have = ''; say('¤ The saved village would not load: ' + why + '.'); }
      else if (local.v === 1) say('¤ Back — the map has grown since you were last here, ' +
                                  'so everyone has been moved to where they now stand.');
      else say('¤ Back in ' + LG.time.season().name.toLowerCase() + ', where you left off.');
    }
    fromServer().then(remote => {
      if (!remote || !remote.saved) return;
      if (have && remote.saved <= have) return;         // same save, or an older one — skip
      /* The server response may arrive after the game has already moved on
         (e.g. a new village was rolled and saved while this request was in
         flight). If any save has been written since this request started,
         trust that instead, regardless of what timestamp the server sent. */
      if (writes !== wrote) return;
      const why = restore(remote);
      if (why) say('¤ The server\'s saved village would not load: ' + why + '.');
      else if (remote.v === 1) say('¤ Picked up the village the log server had kept — ' +
                                   'the map has grown since, so everyone has moved to match.');
      else say('¤ Picked up the village the log server had kept.');
    });
    return !!local && resumed;
  }

  function forget() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    if (server && http()) fetch(ENDPOINT, { method: 'DELETE' }).catch(() => {});
    resumed = false;
    lastAt = '';
  }

  /* Save on tab close. `pagehide` is included because `beforeunload`
     doesn't reliably fire on mobile browsers. */
  if (typeof window !== 'undefined' && window.addEventListener) {
    const bye = () => { if (LG.game && LG.game.saving) write(true); };
    window.addEventListener('beforeunload', bye);
    window.addEventListener('pagehide', bye);
  }

  return { VERSION, snapshot, restore, check, write, tick, resume, forget, digestOf,
           has: () => !!fromLocal(),
           get lastAt() { return lastAt; },
           get onServer() { return serverOk; },
           get resumed() { return resumed; },
           _local: fromLocal, _toLocal: toLocal,
           // so a test can build a plan the way a v1 save's digest was built
           _withPlacesV1: withPlacesV1 };
})();
