/* save.js — one village, written down.

   A village is a chain, a calendar, a purse, a notebook, and thirteen people
   with memories. All of that is in memory and none of it survived closing the
   tab, which made a long game impossible: the errand is meant to take days of
   village time and a villager's memory of you is meant to be worth something.

   **One format, in one place.** Everything here is a plain JSON object with a
   version on it, and there is exactly one function that builds it (`snapshot`)
   and one that puts it back (`restore`). The two sinks — this browser's
   localStorage and the log server's `saves/` directory — are handed the same
   bytes, so a save written by one is readable by the other. Copy the file into
   localStorage or post localStorage's copy to the server; either works, because
   there is nothing to convert. That is the whole point of doing it this way
   rather than having the server keep its own idea of what a village is.

   **What is not in it.** No API keys. The save is a file that gets written to
   disk by a server and may well be copied about; the keys live in `lg-settings`
   with the other settings and stay there. Language and difficulty *are* in it,
   because the village is generated out of them and a save that loaded into the
   wrong language would be a different village wearing the same seed.

   **The village is not stored, only its seed.** The generator is deterministic:
   the same seed and difficulty give the same chain, the same facts with the same
   ids, and the same cast. So the save carries the seed and a digest of what the
   generator produced from it, and the digest is checked on the way back in. If a
   later version of the generator builds something different from that seed the
   save is refused, out loud, rather than loaded on top of a chain whose fact ids
   no longer mean what the notebook thinks they mean.

   **Except when the difference is one this version knows how to undo.** The
   map moving south for the forest changed what a save's numbers mean without
   changing the village they describe, and `migrateV1` says so explicitly
   rather than making that save collateral damage of a change that had
   nothing to do with it. That is a deliberate, one-off act of translation —
   not a promise that every future save is forwards-readable forever. */
window.LG = window.LG || {};

LG.save = (function () {
  /* 2: the map grew — forest to the north, the railway halt to the east, and
     the village itself shifted south to make room. A version 1 save is not
     refused for that on its own: everything coordinate-shaped in it moves by
     the same fixed amount the village did, in `migrateV1` below, and the one
     part that isn't a coordinate — where the errand's last item ended up —
     is re-derived under the old rules rather than shifted, because it was
     never a coordinate to begin with. See `migrateV1`. */
  const VERSION = 2;
  const KEY = 'lg-save';                 // localStorage
  const ENDPOINT = '/save';              // the log server, when there is one
  const EVERY = 20;                      // seconds between autosaves

  let since = 0;                         // seconds since the last write
  let server = true;                     // until it tells us otherwise
  let serverOk = false;                  // it has actually taken one
  let lastAt = '';                       // when we last wrote, for the settings panel
  let resumed = false;                   // this session came out of a save
  let writes = 0;                        // how many saves this session has written

  function http() {
    return typeof fetch === 'function' &&
           typeof location !== 'undefined' && /^https?:/.test(location.protocol);
  }

  /* ------------------------------------------------------------- digest
     A cheap fingerprint of what the generator made: the cast, the trades and
     the fact ids, in order. Not a checksum of the file — a checksum of the
     village, which is what has to still be true for the notebook to make
     sense. */
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
     A villager's patch is a rectangle they were handed — their own home, the
     inside of the bakery, the green. It goes out as four numbers and comes back
     matched against the rectangles that actually exist, so that the identity
     comparisons in npc.js ("am I already in the patch I was going to?") still
     line up after a reload rather than seeing a stranger with the same corners. */
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

  /* `LG.chain.generate` reads `LG.PLACES` only for its length and the order
     of ids in it — see `pick` in chain.js — so a longer list is on its own
     enough to send an unchanged seed's terminal item somewhere else, exactly
     as if the generator's logic had changed. It hasn't; only the list it
     draws from has grown. Replaying the old draw means asking with the old
     list, which is what `LG.PLACES_V1_IDS` is for.

     This is not only asked of a raw version-1 file. Once a village has been
     migrated it goes on saving as version 2 — its coordinates really are
     version 2 now — but its seed still only ever produced this exact plan
     under the old list, forever: `LG.PLACES` is longer with every passing
     version, potentially, and this plan is pinned to how long it was the day
     this village was born. So the plan itself carries `_placesV1`, and
     `snapshot` writes it into `village.placesV1` on every single save from
     then on, and `restore` reads it back rather than inferring it from `v`.
     Without that, the second time this village was ever closed and reopened
     would regenerate it against a `LG.PLACES` that had grown again, fail the
     digest it had itself just written, and refuse a save that was never
     wrong — see the round trip this is tested against in the smoke test.

     This function is the only place the global gets touched, and only for
     the one synchronous call that needs it — put back in a `finally`
     whether or not that call throws. */
  function withPlacesV1(fn) {
    const real = LG.PLACES;
    const byId = {};
    real.forEach(p => { byId[p.id] = p; });
    LG.PLACES = LG.PLACES_V1_IDS.map(id => byId[id]).filter(Boolean);
    try { return fn(); } finally { LG.PLACES = real; }
  }

  /* Everything else in a save — notes, deeds, the till, the board, who knows
     what — is not shaped like a place, and is left exactly as it was. */
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
      /* `home` is where the animal potters about when nobody is holding it,
         and it moves: hand the goat back to the farmer and her patch becomes his
         yard rather than the hillside she strayed onto. Saving only where she
         was standing would send her back to the hillside on the next reload. */
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
      /* The weather is part of the calendar, not scenery: villagers decide where
         to stand by it, and the snow that is lying took several village days to
         get there. Reloading into a random sky would undo all of that. */
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
     Returns null on success, or a sentence saying why not — the caller says it
     out loud rather than failing silently, because a save that quietly does not
     load looks exactly like a save that was never written. */
  function restore(data) {
    const why = check(data);
    if (why) return why;
    const g = LG.game;

    /* Two separate questions, easy to conflate because the same file answers
       both of them today. "Is this a raw version-1 file" decides whether its
       coordinates need shifting — a one-off, done at most once for any given
       save, since the result is written back out as version 2. "Was this
       village's plan built under the old place list" decides how to *ask*
       for that plan, and stays true forever once it is — see `withPlacesV1`.
       A raw v1 file is both; a v2 resave of a village that started as one is
       only the second. `data` itself is never touched by the shift: this is
       a save arriving from the server as easily as from disk, and mutating
       the caller's object would be a surprise for whoever sent it. */
    const isRawV1 = data.v === 1;
    const usePlacesV1 = isRawV1 || !!(data.village && data.village.placesV1);
    data = isRawV1 ? migrateV1(data) : data;

    /* Everything that could refuse the save is asked before anything is touched.
       The village is rebuilt from its seed, so the generator is run once here to
       see whether it still makes the same village — a refusal after the rebuild
       would already have thrown away the one you were in, which matters because
       this can also be a save arriving from the server mid-session. */
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

    /* The village is generated out of the difficulty, so that has to be true
       before it is built rather than after. `newVillage` builds its own plan
       from the seed rather than being handed `candidate` above, so it needs
       the same place list in scope for this call too — otherwise the digest
       above would have verified one plan while the game went on to build a
       different one from the same seed. The plan it builds is tagged with
       how it was asked for, so every save this village makes from here goes
       on asking the same way. */
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
      /* Memories were bare strings before they carried a time and a source. An
         older save still loads: an undated line is one they have simply had a
         while, which is true of anything written down before this existed. */
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
      /* Everything they were in the middle of is dropped. A route, a bubble, a
         decision the model had not answered yet and a conversation with someone
         who is now standing somewhere else are all about a moment that is over;
         they get to think again, which they would have done anyway. */
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

  /* What has to be true of a file before it is allowed near the game.

     Version 1 is let through here on purpose — `restore` migrates it rather
     than refusing it — so this is the one place "current version" and
     "loadable version" are different questions. Anything older than that, or
     from a future version this code does not know how to read backwards, is
     still refused outright: a migration path is something this version
     writes on purpose, not something owed to every version forever. */
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
     Both are handed the same string. Neither is allowed to be a dependency:
     no localStorage (a private window, say) and no server are both ordinary,
     and the game carries on either way. */
  function toLocal(text) {
    try { localStorage.setItem(KEY, text); return true; } catch (e) { return false; }
  }
  function fromLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function toServer(text, leaving) {
    if (!server || !http()) return;
    /* A request started as the tab closes is usually cancelled halfway. A beacon
       is the one kind the browser promises to finish, so the file on disk ends
       up agreeing with localStorage rather than trailing it by an autosave. */
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

  /* Called from the game loop. The village is never still — people are walking
     about and thinking things — so there is nothing to be gained by tracking
     whether anything changed, and a save every twenty seconds costs less than
     the arithmetic to decide it was not needed. */
  function tick(dt) {
    since += dt;
    if (since < EVERY) return;
    since = 0;
    write();
  }

  /* ---------------------------------------------------------- the reading
     The local copy is read first and put back straight away, because it is
     there and it is instant. The server is asked in the same breath, and its
     copy wins only if it is genuinely newer — which happens when you played in
     another browser, or cleared this one, and is exactly the case where you
     would want it to. Both sinks are written in lockstep, so the usual answer
     is that they are the same save and nothing further happens. */
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
      if (have && remote.saved <= have) return;         // the same save, or an older one
      /* The answer can arrive after the game has moved on — a fresh village was
         rolled and saved while this was in the air. Whatever has been written
         since is the newer village, whatever the timestamps in the file say. */
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

  /* When the tab goes away. `pagehide` is the one that fires on a phone. */
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
