/* save.js — persists and restores village state (localStorage + server).

   One format: a versioned JSON object built by `snapshot` and read by
   `restore`, written as the same bytes to localStorage and to the log
   server's saves/village.json, so either loads in the other.

   API keys never go in a save; they stay in `lg-settings`. Language and
   difficulty do, since the village is built from them.

   The generated errand (the plan: links, facts and their ids, roles) is
   stored whole, so adding items, places or lines to data.js, or changing
   the generator, leaves existing saves loadable. A save is refused only
   if its plan names an item, villager or place this version doesn't have.
   Saves from before version 3 held only the seed; save-migrate.js
   regenerates their plan once, and they're written back with it. */
window.LG = window.LG || {};

LG.save = (function () {
  /* Version 3: the plan is in the save. Version 2 held a seed and digest;
     version 1 also predates the map moving south. Both are migrated (see
     save-migrate.js). */
  const VERSION = 3;
  const KEY = 'lg-save';                 // localStorage
  const ENDPOINT = '/save';              // the log server, when there is one
  const EVERY = 20;                      // seconds between autosaves

  let since = 0;                         // seconds since the last write
  let server = true;                     // flips false once a server save request fails
  let serverOk = false;                  // true once the server has actually accepted a save
  let lastAt = '';                       // timestamp of the last write, for the settings panel
  let resumed = false;                   // true if this session was restored from a save
  let writes = 0;                        // count of saves written this session
  /* Set by `forget`: the village being played goes on unsaved -- the
     autosave would otherwise put back what was just thrown away within
     EVERY seconds. The next village (or a loaded one) is saved as usual. */
  let off = false;

  function http() {
    return typeof fetch === 'function' &&
           typeof location !== 'undefined' && /^https?:/.test(location.protocol);
  }

  /* ---------------------------------------------------------------- plans
     Why a saved plan can't be used, or null. Only references to things
     this version might not have are checked; everything else in the plan
     is the save's own record. */
  function planProblem(p) {
    if (!p || !Array.isArray(p.links) || !p.links.length || !p.facts || !p.roles || !p.terminal)
      return 'it does not say what the errand was';
    const items = [p.prize, p.terminal.item];
    p.links.forEach(lk => items.push(lk.wants, lk.gives));
    const item = items.find(id => !LG.ITEMS[id]);
    if (item !== undefined) return 'its errand needs ' + item + ', which this version does not have';
    const who = p.links.map(lk => lk.npcId).find(id => !LG.NPCS.some(n => n.id === id));
    if (who !== undefined) return 'its errand needs ' + who + ', who does not live here in this version';
    if (!LG.PLACES.some(pl => pl.id === p.terminal.placeId))
      return 'its errand ends at ' + p.terminal.placeId + ', which this version does not have';
    return null;
  }

  /* Ties a saved plan back to this version's world: where its place is on
     today's map, and a plain role for any villager added since it was saved. */
  function settle(p) {
    p.terminal.rect = LG.PLACES.find(pl => pl.id === p.terminal.placeId).rect;
    p.npcFacts = p.npcFacts || {};
    LG.NPCS.forEach(n => {
      if (!p.roles[n.id]) p.roles[n.id] = { goal: LG.chain.plainGoal(n.id), trade: null, link: -1 };
      if (!p.npcFacts[n.id]) p.npcFacts[n.id] = [];
    });
    return p;
  }

  /* --------------------------------------------------------------- rects
     A villager's `patch` is one of the game's rectangle objects, and npc.js
     compares them by identity, so a saved {x,y,w,h} is matched back to the
     real rectangle with those bounds. */
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
        patch: rectOut(n.patch),
        /* Who they're chasing and why (the route itself is recomputed).
           newVillage always sets Petra off to meet the train, so without
           this a week-old village would have her run to a train long gone. */
        chasing: !!n.followingPlayer, after: n.wentAfter || null, why: n.why || ''
      };
    });

    const t = g.beast
      // `home` changes in play (a returned goat lives in the farmer's yard), so it's saved too.
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
                 plan: JSON.parse(JSON.stringify(plan)) },
      // The sky and the snow lying come back as they were, not re-rolled.
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
     Null on success, or why the save can't be used, which callers show. */
  function restore(data) {
    const why = check(data);
    if (why) return why;
    const g = LG.game;

    /* Everything is checked before any game state is touched, so a refused
       save (possibly from the server, mid-session) leaves the village
       being played standing. `data` itself is never mutated. */
    if (data.v === 1) data = LG.saveMigrate.migrateV1(data, VERSION);
    let plan = data.village.plan ? JSON.parse(JSON.stringify(data.village.plan))
             : data.village.digest ? LG.saveMigrate.regenerate(data.village) : null;
    if (typeof plan === 'string') return plan;
    const bad = planProblem(plan);
    if (bad) return bad;
    plan = settle(plan);

    g.settings.lang = data.village.lang;
    g.settings.level = data.village.level;
    // Lays the save over a village built from its own plan; newVillage doesn't save it bare first.
    g.newVillage(plan.seed, true, plan);

    const tm = data.time || {};
    LG.time.start(tm.day, tm.frac);
    LG.time.setWeather(tm.weather, tm.hold);
    LG.time.setSnow(tm.snow);

    const p = g.player;
    p.px = data.player.x; p.py = data.player.y; p.dir = data.player.dir || 'down';
    p.tx = (p.px / LG.world.TILE) | 0; p.ty = (p.py / LG.world.TILE) | 0;

    const st = g.state;
    st.inv = Object.assign({}, data.inventory);
    // One note per fact, first one kept, as `learn` guarantees in play; a file can say otherwise.
    const noted = new Set();
    st.notes = (data.notes || [])
      .filter(n => g.plan.facts[n.id] && !noted.has(n.id) && noted.add(n.id))
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
      // Older saves kept memories as bare strings: undated, as if long held.
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
      // Nothing in progress comes back (routes, decisions, bubbles, conversations); they think again.
      n.route = null; n.wantsGo = null; n.deciding = false; n.thought = null;
      n.chatting = false; n.frozen = false; n.bubble = null; n.bubbleT = 0;
      /* A chase does come back, from the save, overriding the one newVillage
         gave Petra; a save without chase data has nobody chasing. Its route
         and timeout start afresh. */
      n.followingPlayer = !!s.chasing; n.followFor = 0; n.followCool = 0;
      n.wentAfter = s.after || null;
      n.why = s.why || '';
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
    off = false;
    since = 0;
    g.renderHUD();
    return null;
  }

  /* Validates a save file's basic shape before it's used. Versions 1 and 2
     are accepted and migrated by restore(); anything older, or newer than
     this code, is refused. */
  function check(data) {
    if (!data || typeof data !== 'object') return 'there was nothing readable in it';
    if (data.game !== 'little-village') return 'that is not a village';
    if (data.v !== VERSION && data.v !== 2 && data.v !== 1) {
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
     Both get the same string, and neither is required: no localStorage (a
     private window) or no server, the game goes on. */
  function toLocal(text) {
    try { localStorage.setItem(KEY, text); return true; } catch (e) { return false; }
  }
  function fromLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function toServer(text, leaving) {
    if (!server || !http()) return;
    // A fetch started as the tab closes is usually cut off; a beacon gets there.
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
    if (off) return null;
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

  // Every frame from the loop; saves every EVERY seconds, since the village is always changing anyway.
  function tick(dt) {
    since += dt;
    if (since < EVERY) return;
    since = 0;
    write();
  }

  /* ---------------------------------------------------------- the reading
     The local copy restores at once; the server's is then fetched and used
     only if it's newer (played in another browser, or storage cleared). */
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
      // Anything saved since this was asked for is newer, whatever the server's timestamp.
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
    off = true;
  }

  // A new village is worth saving again, even after `forget`.
  function keep() { off = false; }

  /* Save on tab close. `pagehide` is included because `beforeunload`
     doesn't reliably fire on mobile browsers. */
  if (typeof window !== 'undefined' && window.addEventListener) {
    const bye = () => { if (LG.game && LG.game.saving) write(true); };
    window.addEventListener('beforeunload', bye);
    window.addEventListener('pagehide', bye);
  }

  return { VERSION, snapshot, restore, check, write, tick, resume, forget, keep,
           has: () => !!fromLocal(),
           get forgotten() { return off; },
           get lastAt() { return lastAt; },
           get onServer() { return serverOk; },
           get resumed() { return resumed; },
           _local: fromLocal, _toLocal: toLocal };
})();
