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
   no longer mean what the notebook thinks they mean. */
window.LG = window.LG || {};

LG.save = (function () {
  const VERSION = 1;
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
    const known = [npc.def.home, npc.work, npc.shelter, LG.GREEN]
      .concat(LG.world.buildings.map(b => b.inside));
    return known.find(k => sameRect(k, r)) || { x: r.x, y: r.y, w: r.w, h: r.h };
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
        coins: n.coins,
        stock: Object.assign({}, n.stock),
        sold: Object.assign({}, n.sold),
        till: (n.till || []).slice(),
        history: (n.history || []).slice(),
        met: !!n.metPlayer, traded: !!n.tradeDone,
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
                 digest: digestOf(plan) },
      /* The weather is part of the calendar, not scenery: villagers decide where
         to stand by it, and the snow that is lying took several village days to
         get there. Reloading into a random sky would undo all of that. */
      time: { day: LG.time.day, frac: LG.time.frac, weather: LG.time.weather,
              hold: LG.time.weatherLeft, snow: LG.time.snow },
      player: { x: round(p.px), y: round(p.py), dir: p.dir },
      inventory: Object.assign({}, st.inv),
      notes: st.notes.map(n => ({ id: n.id, text: n.text, ruby: n.ruby || null, done: !!n.done })),
      deeds: st.deeds.slice(),
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

    /* Everything that could refuse the save is asked before anything is touched.
       The village is rebuilt from its seed, so the generator is run once here to
       see whether it still makes the same village — a refusal after the rebuild
       would already have thrown away the one you were in, which matters because
       this can also be a save arriving from the server mid-session. */
    let candidate = null;
    try { candidate = LG.chain.generate({ level: data.village.level, seed: data.village.seed }); }
    catch (e) { return 'the generator could not rebuild that village at all'; }
    if (digestOf(candidate) !== data.village.digest) {
      return 'that village was built by a different version of the generator';
    }

    /* The village is generated out of the difficulty, so that has to be true
       before it is built rather than after. */
    g.settings.lang = data.village.lang;
    g.settings.level = data.village.level;
    g.newVillage(data.village.seed, true);

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
      .map(n => ({ id: n.id, text: n.text, ruby: n.ruby || null, done: !!n.done }));
    st.deeds = (data.deeds || []).slice();
    st.won = !!data.won;

    g.npcs.forEach(n => {
      const s = (data.villagers || {})[n.id];
      if (!s) return;
      n.px = s.x; n.py = s.y; n.tx = s.tx; n.ty = s.ty; n.dir = s.dir || 'down';
      n.facts = (s.facts || []).filter(id => g.plan.facts[id]);
      n.memory = (s.memory || []).slice();
      n.coins = typeof s.coins === 'number' ? s.coins : n.coins;
      n.stock = Object.assign({}, s.stock);
      n.sold = Object.assign({}, s.sold);
      n.till = (s.till || []).slice();
      n.history = (s.history || []).slice();
      n.metPlayer = !!s.met; n.tradeDone = !!s.traded;
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

  /* What has to be true of a file before it is allowed near the game. */
  function check(data) {
    if (!data || typeof data !== 'object') return 'there was nothing readable in it';
    if (data.game !== 'little-village') return 'that is not a village';
    if (data.v !== VERSION) return 'that save is from version ' + data.v + ', and this is version ' + VERSION;
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
           _local: fromLocal, _toLocal: toLocal };
})();
