/* smoke.js — run the real game headlessly and check it still works.
 *
 *   node tests/smoke.js
 *
 * The game is plain <script> tags: each file sets window.LG and then reads the
 * bare global LG, which only works when the two are the same object. A vm
 * context reproduces that; require() does not. The files are loaded in the order
 * index.html loads them, read out of index.html, so this cannot drift from what
 * a browser actually does.
 *
 * Nothing here talks to a model. Everything asserted is what the game does with
 * no API key at all. */
const vm = require('vm'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0, checks = 0;
function ok(cond, what) {
  checks++;
  if (!cond) { failures++; console.log('FAILED: ' + what); }
}
function section(name) { console.log('\n-- ' + name); }

/* ------------------------------------------------------------ a fake browser */
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createRadialGradient' || k === 'createLinearGradient')
      return () => ({ addColorStop() {} });
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; }
});

function elem(id) {
  const e = {
    id, textContent: '', innerHTML: '', value: '', checked: false,
    disabled: false, title: '', className: '', dataset: {},
    /* Enough of a CSSStyleDeclaration for both halves: things the game sets by
       name (style.display = …) and the custom properties it publishes the
       visible height through. */
    style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      /* The real toggle takes a second argument that says which way, and the
         game uses it — classList.toggle('cramped', tooShort). A stub that
         always flips turns a settled "still cramped" into "not any more". */
      toggle(c, on) {
        const want = on === undefined ? !this._s.has(c) : !!on;
        if (want) this._s.add(c); else this._s.delete(c);
        return want;
      }
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { width: 900, height: 640, left: 0, top: 0 }; },
    getContext() { return ctx2d; },
    focus() {}
  };
  e.parentElement = e;
  return e;
}

/* A whole browser, built to order. Taking it as a function rather than one
   global lets the test do the thing a save is for: close the tab and open a new
   one, with nothing carried over but what was written down. */
function makeSandbox(store) {
const els = {};
const sandbox = {
  console,
  Math, Date, JSON, Intl, Promise, Set, Map, Array, Object, String, Number,
  RegExp, Error, parseInt, parseFloat, isFinite, isNaN, Uint8Array, Proxy,
  setTimeout, clearTimeout, setInterval, clearInterval,
  devicePixelRatio: 1,
  innerHeight: 900, innerWidth: 1440,   // a desktop window, until a test says otherwise
  performance: { now: () => Date.now() },
  location: { protocol: 'file:', origin: 'null' },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  // the loop is driven by hand below, so frames never fire on their own
  requestAnimationFrame: () => 0,
  addEventListener() {}, removeEventListener() {},
  fetch: () => Promise.reject(new Error('no server in the smoke test')),
  document: {
    getElementById: id => els[id] || (els[id] = elem(id)),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach() {}, length: 0 }),
    createElement: tag => elem(tag),
    addEventListener() {},
    documentElement: elem('html'),   // where --vv-h and --vv-top are published
    activeElement: null,
    body: elem('body')
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
return sandbox;
}

const store = {};
const sandbox = makeSandbox(store);

/* ------------------------------------------------------------------- loading */
section('loading, in index.html order');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = [];
html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => { files.push(src); return m; });
ok(files.length > 5, 'index.html lists its scripts');
for (const f of files) {
  const p = path.join(ROOT, f);
  try { vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f }); }
  catch (e) { ok(false, f + ' threw on load: ' + e.message); }
}
console.log('   ' + files.length + ' files: ' + files.map(f => path.basename(f)).join(' '));

const LG = sandbox.LG;

/* Adding a language means touching five places in data.js — LG.ITEMS,
   LG.PLACENAMES, LG.CONJ, LG.TXN and LG.CHATTER, plus LG.PHRASES for the
   player's own lines — and it is easy to add the fourth without noticing
   the fifth still says nothing in the new language. This walks every
   language in LG.LANGUAGES against every one of those and fails loudly on
   the first gap, rather than leaving a villager to fall back to English
   mid-sentence and nobody finding out until a player does. */
section('every language is complete, everywhere one is expected to speak');
const langCodes = Object.keys(LG.LANGUAGES);
for (const lang of langCodes) {
  for (const id of Object.keys(LG.ITEMS)) {
    ok(typeof LG.ITEMS[id][lang] === 'string' && LG.ITEMS[id][lang].length > 0,
       'LG.ITEMS.' + id + ' has a ' + lang + ' translation');
  }
  for (const key of Object.keys(LG.PLACENAMES)) {
    ok(typeof LG.PLACENAMES[key][lang] === 'string' && LG.PLACENAMES[key][lang].length > 0,
       'LG.PLACENAMES["' + key + '"] has a ' + lang + ' translation');
  }
  ok(typeof LG.CONJ[lang] === 'string' && LG.CONJ[lang].length > 0,
     'LG.CONJ has a ' + lang + ' word for "and"');
  for (const key of Object.keys(LG.TXN)) {
    ok(typeof LG.TXN[key][lang] === 'string' && LG.TXN[key][lang].length > 0,
       'LG.TXN.' + key + ' has a ' + lang + ' line');
  }
  ok(Array.isArray(LG.CHATTER[lang]) && LG.CHATTER[lang].length === LG.CHATTER.en.length,
     'LG.CHATTER has ' + LG.CHATTER.en.length + ' ' + lang + ' mutterings, same as en');
  LG.PHRASES.forEach((ph, i) => ok(typeof ph[lang] === 'string' && ph[lang].length > 0,
     'LG.PHRASES[' + i + '] ("' + ph.en + '") has a ' + lang + ' translation'));
}

/* Start the game the way the page does. No key, so nothing is ever sent. */
sandbox.LG.game.init();
if (LG.game.thoughts !== undefined) LG.game.thoughts = false;   // no narration in a test

/* `node tests/smoke.js --prompts` prints every villager's system prompt for one
   fixed village and stops. Two checkouts dumped this way diff cleanly, which is
   the only way to be sure a refactor left the model looking at the same words. */
if (process.argv.indexOf('--prompts') !== -1) {
  LG.game.newVillage('elder-birch-quiet', true);
  LG.time.start(10, 0.4);
  LG.time.setWeather('clear', 999);                 // weather is rolled, so pin it
  LG.game.npcs.forEach(n => {
    console.log('\n########## ' + n.def.name + '\n');
    console.log(LG.dialogue._debugPrompt(n, null));
  });
  process.exit(0);
}
ok(!!LG.view, 'LG.view exists');
const npcs = LG.game.npcs, plan = LG.game.plan;
ok(npcs.length > 0, 'the village has villagers');
ok(!!plan && plan.links.length > 0, 'an errand chain was built');

/* ------------------------------------------------------------------ the view */
section('one villager, assembled once');
for (const n of npcs) {
  const v = LG.view.of(n, 'player');
  ok(v.name === n.def.name && v.job === n.def.job && !!v.persona,
     v.name + ': identity');
  ok(typeof v.goal === 'string' && v.goal.length > 0, v.name + ': has something to be about');
  ok(Array.isArray(v.knows) && v.knows.every(f => f.id && f.text && f.plain),
     v.name + ': knows is [{id, text, plain}]');
  ok(typeof v.here === 'string' && v.here.length > 0, v.name + ': knows where they are');
  ok(v.trade && typeof v.trade.open === 'boolean' && Array.isArray(v.trade.till),
     v.name + ': has a trade and a till');
}

section('a villager reads their own opinion in the first person');
let opinionsChecked = 0;
for (const id of Object.keys(plan.facts)) {
  const f = plan.facts[id];
  if (f.type !== 'opinion') continue;
  for (const n of npcs) {
    if (n.facts.indexOf(id) === -1) continue;
    if (f.text.indexOf(n.def.name + ' thinks ') !== 0) continue;   // not the one thinking it
    opinionsChecked++;
    const entry = LG.view.of(n).knows.find(k => k.id === id);
    ok(entry && entry.text.indexOf('You think ') === 0,
       n.def.name + ' says "You think" about her own opinion');
    ok(entry && entry.plain === f.text,
       n.def.name + ': the plain wording is kept for anyone reading from outside');
    const prompt = LG.dialogue._debugPrompt(n, null);
    ok(prompt.indexOf(n.def.name + ' thinks ') === -1,
       n.def.name + ' is not told about herself in the third person');
  }
}
ok(opinionsChecked > 0, 'the village has opinions to check at all');

section('the three callers get the amounts they asked for');
for (const n of npcs) {
  const i = LG.view.of(n, 'intent'), c = LG.view.of(n, 'chat'), p = LG.view.of(n, 'player');
  ok(i.knows.length <= LG.view.TRIM.intent.knows, n.def.name + ': intent knows trimmed');
  ok(i.memory.length <= LG.view.TRIM.intent.memory, n.def.name + ': intent memory trimmed');
  ok(i.folk.length <= LG.view.TRIM.intent.folk, n.def.name + ': intent folk trimmed');
  ok(c.knows.length <= LG.view.TRIM.chat.knows, n.def.name + ': chat knows trimmed');
  ok(c.memory.length <= LG.view.TRIM.chat.memory, n.def.name + ': chat memory trimmed');
  ok(p.knows.length === n.facts.length,
     n.def.name + ': the player-facing prompt lists every fact, so every tag is nameable');
}

section('the prompt the player meets');
for (const n of npcs) {
  const prompt = LG.dialogue._debugPrompt(n, null);
  for (const head of ['# Your character', '# What you know', '# Where you are right now',
                      '# The player', '# Your language', '# Reply format']) {
    ok(prompt.indexOf(head) !== -1, n.def.name + ': prompt has ' + head);
  }
  ok(prompt.indexOf('You are ' + LG.view.where(n) + '.') !== -1,
     n.def.name + ': is told where they are standing');
  ok(!/\bundefined\b/.test(prompt), n.def.name + ': no undefined in the prompt');
  ok(!/\b1 coins\b|\b\d+ coin\b(?!s)/.test(prompt.replace(/\b1 coin\b/g, '')),
     n.def.name + ': coins are pluralised');
  n.facts.forEach(id => ok(prompt.indexOf('[' + id + ']') !== -1,
     n.def.name + ': fact ' + id + ' is tagged in the prompt'));
}

section('what brought them here is spent when they get here');
const someone = npcs[0];
someone.wentAfter = npcs[1].def.id;
ok(LG.view.of(someone).errand.after === npcs[1].def.id, 'the errand is readable');
LG.view.arrived(someone);
ok(LG.view.of(someone).errand.after === null, 'and cleared once they have arrived');

/* ------------------------------------------------------------------ the world */
section('the village runs');
const before = npcs.map(n => n.tx + ',' + n.ty);
for (let i = 0; i < 3000; i++) LG.game._debugTick(1 / 30);
const stuck = npcs.filter((n, i) => (n.tx + ',' + n.ty) === before[i]);
ok(stuck.length < npcs.length / 2, 'the village moves without a key');
/* Known, and older than any of this: about one village in eight has somebody
   who cannot move at all. `wander` only steps to a neighbouring tile that is
   both walkable and inside their own patch, so a villager whose patch pins them
   against trees or a wall has nowhere legal to go and stands there. It is the
   same geometry that used to strand Ilya in the woods, in the one place the
   eight-try pathfinding retry does not reach. Reported, not asserted, because
   it is not what this refactor changed — measured at 8/60 villages before and
   7/60 after. */
if (stuck.length) {
  console.log('   KNOWN ISSUE: penned in by their own patch — ' +
              stuck.map(n => n.def.name + ' (' + LG.view.where(n) + ')').join(', '));
}
for (const n of npcs) {
  ok(LG.world.isWalkable(n.tx, n.ty), n.def.name + ' is standing somewhere walkable');
  ok(typeof LG.view.where(n) === 'string', n.def.name + ' can still say where they are');
}

/* Open is not the same as reachable, and a forest is that failure at scale:
   chain.js will happily leave the last item of an errand in a glade, and a
   glade walled in by trees is an errand nobody can finish. Everything the
   game can point you at is checked against a flood fill from the platform —
   the tile the traveller actually starts on — rather than trusted. */
section('everywhere the errand can send you can be got to');
const start = LG.world.nearestOpen(LG.START.x, LG.START.y);
const reachable = LG.world._flood(start.x, start.y);
const canGet = (x, y) => reachable.has(y * LG.world.W + x);

ok(LG.world.get(start.x, start.y) === LG.world.T.PLATFORM,
   'the traveller gets off the train onto the platform');

for (const p of LG.PLACES) {
  let found = false;
  for (let y = p.rect.y; y < p.rect.y + p.rect.h && !found; y++)
    for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++)
      if (canGet(x, y)) { found = true; break; }
  ok(found, 'you can walk to "' + p.en + '"');
}
for (const b of LG.world.buildings) {
  ok(canGet(b.doorX, b.doorY), 'the door of the ' + b.label + ' can be reached');
  ok(canGet(b.inside.x, b.inside.y), 'and you can get inside the ' + b.label);
}
for (const n of npcs) ok(canGet(n.tx, n.ty), n.def.name + ' is somewhere you can walk to');

/* The woods have to actually be woods. A density that quietly drifts to nothing
   would leave the glades sitting in a field, and one that closes up entirely
   would make the tracks the only ground in the north — this pins it between. */
let trees = 0, north = 0;
for (let y = 2; y < LG.NORTH_WOODS; y++) for (let x = 2; x < LG.world.W - 2; x++) {
  north++;
  if (LG.world.get(x, y) === LG.world.T.TREE) trees++;
}
const cover = trees / north;
ok(cover > 0.40 && cover < 0.75,
   'the forest is a forest: ' + Math.round(cover * 100) + '% tree cover north of the village');
console.log('   ' + trees + ' trees over ' + north + ' tiles of forest');

/* Every named place is somewhere a villager could stand and an animal could
   potter, which is what the glades are cleared outright for. */
for (const p of LG.PLACES) {
  let open = 0;
  for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++)
    for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++)
      if (LG.world.isWalkable(x, y)) open++;
  ok(open >= 2, '"' + p.en + '" has room to stand in (' + open + ' tiles)');
}

/* The map is drawn from a switch over tile types and a switch over prop types,
   and a new arm of either is a runtime error nobody sees until they walk that
   far. Draw the whole thing, in every language, dry and under snow and after
   dark, with the viewport wide enough that nothing is culled. */
section('the whole map draws');
{
  const cam = { x: 0, y: 0 };
  const fullW = LG.world.W * LG.world.TILE, fullH = LG.world.H * LG.world.TILE;
  let drew = 0;
  for (const lang of Object.keys(LG.LANGUAGES)) {
    for (const snow of [0, 0.8]) {
      LG.time.setSnow(snow);
      LG.world.drawGround(ctx2d, cam, fullW, fullH);
      LG.world.drawBuildings(ctx2d, LG.world.buildings[0], cam, fullW, fullH);
      LG.world.drawSigns(ctx2d, cam, fullW, fullH, lang, false);
      LG.world.drawSigns(ctx2d, cam, fullW, fullH, lang, true);
      drew++;
    }
  }
  LG.time.setSnow(0);
  ok(drew === Object.keys(LG.LANGUAGES).length * 2, 'drew the map ' + drew + ' times without throwing');

  // Every tile type the map actually contains has been through drawTile above.
  const present = new Set();
  for (let y = 0; y < LG.world.H; y++) for (let x = 0; x < LG.world.W; x++)
    present.add(LG.world.get(x, y));
  ok(present.has(LG.world.T.PLATFORM), 'the platform is on the map');
  ok(present.has(LG.world.T.RAIL), 'so is the line');
  ok(present.has(LG.world.T.TREE) && present.has(LG.world.T.WATER),
     'and the ordinary ground it used to have');

  // A sign is only clickable if it left a box behind to be clicked.
  LG.world.drawSigns(ctx2d, cam, fullW, fullH, 'ru', false);
  const st = LG.world._signs().find(s => s.key === 'Station');
  ok(st && LG.world.overSign(st.x, st.y - 10), 'the station nameboard can be clicked');
  ok(!LG.world.overSign(0, 0), 'and the empty corner of the map cannot');

  /* A board is sized by measureText and everything else out here is sized by
     the tile grid, so a board is the one thing that can come to rest between
     device pixels — where it stays, softening, because draw() snaps the camera
     and so never walks it back onto the grid. Give it a deliberately awkward
     width at the pixel ratios real screens actually report, and check all four
     edges landed on whole device pixels anyway. */
  const measured = ctx2d.measureText;
  ctx2d.measureText = () => ({ width: 37.3183 });
  for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3]) {
    LG.world.drawSigns(ctx2d, cam, fullW, fullH, 'ja', false, dpr);
    const boxes = LG.world._signBoxes();
    const adrift = boxes.filter(b => [b.x, b.y, b.x + b.w, b.y + b.h]
      .some(v => Math.abs(v * dpr - Math.round(v * dpr)) > 1e-6));
    ok(boxes.length > 0 && adrift.length === 0,
       'at dpr ' + dpr + ', every nameboard edge is on a whole device pixel' +
       (adrift.length ? ' (' + adrift.length + ' of ' + boxes.length + ' adrift)' : ''));
  }
  ctx2d.measureText = measured;
}

/* The thing that flashes on a phone is filled *curves*, and the count that
   matters is how many of them a frame asks the rasteriser for — not how many
   fill() calls they are batched into, which is what an earlier attempt counted
   and why it did not help. Trees and fog are stamped from a sprite instead, so
   count the curves and notice if a well-meant tidy ever puts them back. */
section('the woods and the fog are stamped, not drawn');
{
  const cam = { x: 0, y: 0 };
  const fullW = LG.world.W * LG.world.TILE, fullH = LG.world.H * LG.world.TILE;
  /* The sprites are cut on a canvas of their own, which in here is this same
     stub — so their own curves are counted too, and the few they cost are the
     point: it is once each, not once per tree. */
  function curves(draw) {
    let n = 0;
    ctx2d.arc = () => { n++; };
    ctx2d.ellipse = () => { n++; };
    draw();
    delete ctx2d.arc; delete ctx2d.ellipse;
    return n;
  }

  const drawn = curves(() => LG.world.drawGround(ctx2d, cam, fullW, fullH));
  const stamped = curves(() => LG.world.drawGround(ctx2d, cam, fullW, fullH, 2));
  ok(drawn > 200, 'the map has round things enough for this to matter (' + drawn + ' curves)');
  console.log('   ' + drawn + ' curves drawn by hand, ' + stamped + ' when stamped');
  ok(stamped * 5 < drawn,
     'given a pixel ratio the ground costs ' + stamped + ' curves, not ' + drawn);

  const wasWeather = LG.time.weather;
  LG.time.setWeather('fog', 999);
  for (let i = 0; i < 60; i++) LG.sky.step(1 / 60, 900, 640);
  const fogDrawn = curves(() => LG.sky.draw(ctx2d, 900, 640, null));
  const fogStamped = curves(() => LG.sky.draw(ctx2d, 900, 640, null, 2));
  ok(fogDrawn >= 20, 'fog is a screenful of big ellipses (' + fogDrawn + ')');
  ok(fogStamped <= 1, 'and one sprite once it has a pixel ratio (' + fogStamped + ')');
  console.log('   fog: ' + fogDrawn + ' ellipses a frame, ' + fogStamped + ' when stamped');
  LG.time.setWeather(wasWeather || 'clear', 999);
}

section('every building says what it is, in the language you are learning');
const signs = LG.world._signs();
for (const b of LG.world.buildings) {
  ok(signs.some(s => s.key === b.label), 'the ' + b.label + ' has a sign outside it');
}
for (const key of ['Noticeboard', 'Station']) {
  ok(signs.some(s => s.key === key), key + ' has a sign');
}
/* A sign with no translation falls back to English, which is silent and
   wrong: the whole point is that the map is in their language. */
for (const s of signs) {
  const p = LG.PLACENAMES[s.key];
  ok(p, s.key + ' has a name to put on its sign');
  if (p) for (const lang of Object.keys(LG.LANGUAGES)) {
    ok(p[lang], '"' + s.key + '" is written in ' + lang);
  }
}

section('trading still squares up');
LG.time.start(LG.time.day, 0.5);                       // the middle of the day
/* Nothing the errand needs, or the villager rightly refuses to buy it. */
const chainItem = {};
plan.links.forEach(lk => { chainItem[lk.wants] = chainItem[lk.gives] = true; });
chainItem[plan.terminal.item] = chainItem[plan.prize] = true;

/* Not a chain item either way: a villager rightly refuses to buy back something
   the traveller is carrying for somebody else, which is a different test. */
const shop = npcs.find(n => (n.def.sells || []).some(w => !chainItem[w.i]));
if (shop) {
  const ware = shop.def.sells.find(w => !chainItem[w.i]);
  LG.game.state.inv.coins = 20;
  const sold = LG.game.commerce(shop, 'sell', ware.i, ware.p);
  ok(sold, shop.def.name + ' sold a ' + LG.ITEMS[ware.i].en);
  ok(LG.game.count(ware.i) === 1, 'and the traveller is holding it');
  ok(LG.game.commerce(shop, 'buy', ware.i, ware.p), 'and took it back when asked');
}

/* What a villager buys they hold, know they hold, and can say so. */
const buyer = npcs.find(n => (n.def.buys || []).some(w => !chainItem[w.i]));
if (buyer) {
  const want = buyer.def.buys.find(w => !chainItem[w.i]);
  LG.game.give(want.i, 1);
  const bought = LG.game.commerce(buyer, 'buy', want.i, want.p);
  ok(bought, buyer.def.name + ' bought a ' + LG.ITEMS[want.i].en + ' off the traveller');
  ok((buyer.stock[want.i] || 0) === 1, 'and is holding it now');
  const v = LG.view.of(buyer, 'player');
  ok(v.trade.stock.some(it => it.id === want.i),
     'and the view says so, so the villager can say so');
  ok(LG.dialogue._debugPrompt(buyer, null).indexOf('In your hands right now') !== -1,
     'and it reaches the prompt');
  ok(LG.dialogue._debugPrompt(buyer, null).indexOf('# The till') !== -1,
     'and the till records what actually happened');
}

/* -------------------------------------------------------- one sale, rung twice
   Straight out of a session log. Tomas agreed a knife for two coins and flagged
   the sale on the turn he agreed it; the traveller then held out the coins, as
   anyone would who had just been told to, and the sale went through again. Two
   knives, four coins. A repeat on the very next turn is one sale counted twice;
   a repeat later is somebody wanting another knife. */
section('the same sale does not go through twice');
{
  LG.time.start(LG.time.day, 0.5);
  const who = npcs.find(n => (n.def.sells || []).some(w => !chainItem[w.i]));
  ok(!!who, 'somebody in the village keeps a stall');
  if (who) {
    const ware = who.def.sells.find(w => !chainItem[w.i]);
    who.till = []; who.sold = {}; who.stock = {};
    LG.game.state.inv.coins = 20;
    const held = () => LG.game.count(ware.i);
    const purse = () => LG.game.count('coins');

    who.turns = 1;
    ok(LG.game.commerce(who, 'sell', ware.i, ware.p), 'the sale goes through');
    const after = purse(), got = held();

    who.turns = 2;                                   // the very next turn
    ok(LG.game.commerce(who, 'sell', ware.i, ware.p) === false,
       'and the same one on the next turn is refused');
    ok(purse() === after && held() === got, 'nothing was taken and nothing handed over');
    ok(who.till[who.till.length - 1].failed, 'and the refusal is in the till where they can read it');

    who.turns = 9;                                   // later, on purpose
    ok(LG.game.commerce(who, 'sell', ware.i, ware.p), 'wanting another one later still works');
    ok(held() === got + 1, 'and they have two of them now');

    /* What the villager is told they are holding has to say how many, or the
       ledger says two sales and the summary beside it names one object. */
    const v = LG.view.of(who, 'player');
    const entry = v.trade.sold.find(it => it.id === ware.i);
    ok(entry && entry.n === 2, 'the returnable record counts them');
    ok(LG.dialogue._debugPrompt(who, null).indexOf('2 \u00d7 ' + LG.ITEMS[ware.i].en) !== -1,
       'and the prompt says two, not one');

    ok(LG.game.commerce(who, 'buy', ware.i, ware.p), 'one of them can be handed back');
    ok(held() === got, 'and only one went back');
    ok(LG.view.of(who, 'player').trade.sold.find(it => it.id === ware.i).n === 1,
       'leaving one still returnable');
  }
}

/* ------------------------------------------------------------- a spent errand
   A finished exchange has to stop being what the villager is about. Everything
   that turns over on a completed trade used to be the deal block alone, which
   only the player-facing prompt renders — so the two calls that decide where a
   villager walks and what they say to each other went on being handed a goal
   that wanted a thing already sitting in the villager's own house, and facts
   saying they still held what they had just given away. */
section('a finished errand stops being what they want');
{
  const lk = plan.links[plan.links.length - 1];       // the deepest link: no chain of its own to disturb
  const who = npcs.find(n => n.def.id === lk.npcId);
  ok(!!who, 'the deepest link belongs to somebody in the village');
  if (who) {
    const role = plan.roles[who.def.id];
    const before = LG.view.of(who, 'player').goal;
    const mine = who.facts.filter(id => {
      const f = plan.facts[id];
      return f && f.link === role.link && f.type !== 'opinion';
    });
    ok(mine.length > 0, who.def.name + ' holds the facts of their own link');

    LG.game.give(lk.wants, lk.wantsCount || 1);
    LG.game.doTrade(who, role.trade);

    const after = LG.view.of(who, 'player').goal;
    ok(who.tradeDone, 'the trade completed');
    ok(after !== before, 'and what they are about has changed with it');
    ok(after.indexOf('Your own work') === 0,
       'they are a villager with a job again, not one still wanting it');
    ok(mine.every(id => who.facts.indexOf(id) === -1),
       'the facts of the spent link are gone from what they know');
    ok(who.memory.some(m => m.text.indexOf('That is done with') !== -1),
       'and they remember doing it, so it is theirs to pass on');

    /* The goal is what reaches the two calls that had no other way of knowing. */
    ok(LG.view.of(who, 'chat').goal === after, 'the chatter call sees it too');
    ok(LG.view.of(who, 'intent').goal === after, 'and so does the one that walks them about');
  }
}

/* ------------------------------------------------------------ the reply schema
   The prompt block and the JSON Schema are rendered from one field list, so the
   thing worth checking is that they cannot disagree: every key the villager is
   shown is a key the provider is told to enforce. The gate is checked too — a
   model nobody has looked up must read as "no schema", because sending one to a
   provider that cannot take it fails the whole request rather than being
   ignored. */
section('the prompt and the schema are the same list');
{
  const n = npcs[0];
  const built = LG.dialogue._debugReply(n, null);
  ok(typeof built.text === 'string' && built.text.length > 0, 'a prompt came back');
  ok(LG.dialogue._debugPrompt(n, null) === built.text,
     'and the string-returning wrapper is the same text');

  const sc = built.schema;
  ok(sc && sc.type === 'object', 'a schema came back');
  ok(sc.additionalProperties === false, 'closed to fields nobody asked for');

  // the keys the villager is actually shown, read back out of the block
  const block = built.text.split('# Reply format')[1].split('}')[0];
  const shown = [];
  block.replace(/^ {2}"([a-z]+)":/gm, (m, k) => { shown.push(k); return m; });
  ok(shown.length >= 6, 'the reply block names its fields');
  ok(shown.every(k => k in sc.properties), 'every field shown is a field typed');
  ok(shown.every(k => sc.required.indexOf(k) !== -1), 'and every one is required');
  ok(Object.keys(sc.properties).every(k => shown.indexOf(k) !== -1),
     'and nothing is typed that the villager was never shown');

  ok(sc.properties.understood.enum.join() === 'full,partial,none', 'understood is an enum');
  ok(sc.properties.action.enum.indexOf('none') !== -1, 'action can always be none');
  const nullable = k => [].concat(sc.properties[k].type).indexOf('null') !== -1;
  ok(nullable('remember'), 'the optional fields are nullable rather than absent');
  ok(!nullable('say') && !nullable('translation'), 'and the ones that always come are not');
}

section('a model nobody has looked up gets no schema');
{
  ok(LG.llm.schemaOK({ provider: 'openrouter', model: 'nobody/never-heard-of-it' }) === false,
     'unknown reads as no');
  ok(LG.llm.schemaOK({ provider: 'anthropic', model: 'claude-opus-5' }) === false,
     'and so does a real model that has not been probed in this session');
  ok(LG.llm.schemaOK({ provider: 'logfare', model: 'logfare/auto' }) === false,
     'Logfare has no catalogue to check, so it fails closed the same way');
}

section('speech input is progressive enhancement — off in a browser without it');
{
  // This sandbox never defines window.SpeechRecognition, the same as
  // Firefox or Safari as of writing — so the module should settle into the
  // same "not here" state a real unsupported browser leaves it in.
  ok(LG.speech.available() === false, 'unavailable in a browser (or sandbox) with no SpeechRecognition');
  ok(LG.speech.listen('ru', () => {}, () => {}) === false,
     'asking it to listen anyway is refused rather than throwing');
  ok(LG.speech.listening === false, 'and it never claims to be listening');
  LG.speech.stop();   // idempotent — nothing to stop, nothing to throw either
}

section('the cost meter: exact where a provider says, estimated where it has to');
{
  const before = LG.llm.totals;
  ok(before.calls === 0 && before.inputTokens === 0 && before.cost === 0,
     'nothing spent before the first call');

  // A model this game prices itself (see REFERENCE_PRICING) with no usage.cost
  // of its own — 1M in, 1M out at $3/$15 per million is $18 exactly.
  LG.llm._debugRecord('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 1e6 });
  let t = LG.llm.totals;
  ok(t.calls === 1, 'one call recorded');
  ok(t.inputTokens === 1e6 && t.outputTokens === 1e6, 'and its tokens counted');
  ok(Math.abs(t.cost - 18) < 1e-9, 'priced off the reference table: $3+$15 per million');
  ok(t.estimated === true, 'flagged as a guess, not a receipt');

  // A provider that hands back its own usage.cost is taken at its word, added
  // on top rather than re-derived.
  LG.llm._debugRecord('anthropic/claude-sonnet-5', { input_tokens: 500, output_tokens: 500, cost: 0.02 });
  t = LG.llm.totals;
  ok(t.calls === 2, 'the second call counts too');
  ok(Math.abs(t.cost - 18.02) < 1e-9, 'its exact cost is added to the estimate, not replacing it');

  // A model nobody has priced, on a provider that did not say either — tokens
  // are still counted, but it does not silently read as free.
  LG.llm._debugRecord('nobody/never-heard-of-it', { input_tokens: 100, output_tokens: 100 });
  t = LG.llm.totals;
  ok(t.calls === 3 && t.inputTokens === 1e6 + 600, 'its tokens are still on the running total');
  ok(Math.abs(t.cost - 18.02) < 1e-9, 'but it added nothing to the cost, priced or not');
  ok(t.unpriced === 1, 'and is called out as unpriced rather than folded into the total silently');

  {
    LG.game.openSettings(false);
    const note = sandbox.document.getElementById('setUsage').textContent;
    ok(note.indexOf('3 calls') !== -1, 'the settings panel shows the running total');
    ok(note.indexOf('~$18.02') !== -1, 'with the ~ once any part of it is a guess');
    ok(note.indexOf('1 call on an unpriced model') !== -1,
       'and says outright that one call is not in that figure');
    sandbox.document.getElementById('settings').classList.remove('open');
  }
}

section('pinyin, syllable by syllable, into zhuyin');
{
  const zy = LG.dialogue._pinyinToZhuyin;
  // one of each tone, and the worked example the game's own romanNote uses
  ok(zy('mā') === 'ㄇㄚ', 'first tone carries no mark');
  ok(zy('wén') === 'ㄨㄣˊ', 'second tone');
  ok(zy('hǎo') === 'ㄏㄠˇ', 'third tone');
  ok(zy('xiè') === 'ㄒㄧㄝˋ', 'fourth tone');
  ok(zy('ma') === '˙ㄇㄚ', 'no mark at all reads as neutral, dot first');
  ok(zy('nǐ') === 'ㄋㄧˇ', 'and the pair the romanNote itself is worked from');
  // the buzzed finals: zhi/chi/shi/ri/zi/ci/si carry no vowel symbol of their own
  ok(zy('shì') === 'ㄕˋ', 'shi is ㄕ alone, not ㄕ plus ㄧ');
  ok(zy('zhōng') === 'ㄓㄨㄥ', 'zhong keeps its final — the buzzed rule is "i" only');
  ok(zy('rì') === 'ㄖˋ', 'ri, the same as shi');
  // y/w/vowel-only spellings, which are not an initial-plus-final at all
  ok(zy('wǒ') === 'ㄨㄛˇ', 'wo aliases to the uo final');
  ok(zy('yī') === 'ㄧ', 'yi aliases to the bare i final');
  ok(zy('ān') === 'ㄢ', 'an has no initial and needs no alias either');
  ok(zy('yuǎn') === 'ㄩㄢˇ', 'yuan aliases to üan');
  // ü: dropped from the spelling after j/q/x, kept after n/l
  ok(zy('jué') === 'ㄐㄩㄝˊ', 'jue is j + üe, spelled without the umlaut');
  ok(zy('xuǎn') === 'ㄒㄩㄢˇ', 'xuan is x + üan, same rule');
  ok(zy('nǚ') === 'ㄋㄩˇ', 'nü keeps the umlaut — nu and nü are different syllables');
  ok(zy('lüè') === 'ㄌㄩㄝˋ', 'so does lüe');
  ok(zy('gū') === 'ㄍㄨ', 'plain u after a normal initial is u, not ü');
  // failure is null, not a guess — the caller's fallback depends on that
  ok(zy('xi\'an') === null, 'an inner apostrophe is not a letter this parses');
  ok(zy('') === null, 'nor is nothing at all');
}

section('a sentence and its pinyin, zipped into ruby — or not, safely');
{
  const zhRuby = LG.dialogue._zhRuby;
  const pinyin = zhRuby('你好', 'nǐ hǎo', 'pinyin');
  ok(pinyin === '<ruby>你<rt>nǐ</rt></ruby><ruby>好<rt>hǎo</rt></ruby>',
     'one ruby per character, in the pinyin the model actually wrote');
  const zhuyin = zhRuby('你好', 'nǐ hǎo', 'zhuyin');
  ok(zhuyin === '<ruby>你<rt>ㄋㄧˇ</rt></ruby><ruby>好<rt>ㄏㄠˇ</rt></ruby>',
     'or converted to zhuyin, character for character the same');
  ok(zhRuby('你好吗？', 'nǐ hǎo', 'pinyin') === null,
     'a character the pinyin has no syllable for (a dropped 吗, say) fails closed rather than misaligning');
  ok(zhRuby('你好', 'nǐhǎo', 'pinyin') === null,
     'so does the ordinary way pinyin is actually typed, run together with no spaces');
  ok(zhRuby('你好', '', 'pinyin') === null, 'and an empty roman line');
  ok(zhRuby('', 'nǐ hǎo', 'pinyin') === null, 'or an empty sentence');
  ok(zhRuby('hello', 'nǐ hǎo', 'pinyin') === null,
     'no hanzi in the sentence at all — nothing to annotate, so nothing is');
  // non-hanzi characters pass through untouched, only the hanzi get wrapped
  ok(zhRuby('¤10, 你好!', 'nǐ hǎo', 'pinyin') ===
     '¤10, <ruby>你<rt>nǐ</rt></ruby><ruby>好<rt>hǎo</rt></ruby>!',
     'currency, digits and punctuation are carried through, not annotated');

  const html = LG.dialogue.zhRubyHTML('你好', 'nǐ hǎo', 'pinyin');
  ok(html === '<ruby>你<rt>nǐ</rt></ruby><ruby>好<rt>hǎo</rt></ruby>',
     'zhRubyHTML is zhRuby run through the same sanitiser furigana uses');
  ok(LG.dialogue.zhRubyHTML('你好', 'nǐhǎo', 'pinyin') === null,
     'and passes the null straight through on a line that does not line up');
}

section('metBeforeLine: a plain fact, dated or not, never a summons to recap');
{
  const line = LG.dialogue._metBeforeLine;
  ok(line(null, 'Mira') === null, 'nothing to say about somebody never met');
  const today = LG.time.day;
  const now = line({ day: today, at: '09:14' }, 'Mira');
  ok(now === 'You have talked with Mira before, earlier today at 09:14.',
     'names them and the time, when it was today');
  const before = line({ day: today - 1, at: '09:14' }, 'Mira');
  ok(before === 'You have talked with Mira before.',
     'and drops the clock reading rather than claim "today" for an earlier day');
}

/* ------------------------------------------------------- what they believe now
   Villagers are not a table of rows to expire. They hold things, each with a
   time and a source, and when something arrives that overtakes one of them they
   rewrite that one — "Yuri is looking for shoes" becomes "Yuri was looking for
   shoes and has them now", which is still worth passing on. A chain fact keeps
   its id through that, because the notebook is built on ids. */
section('everything they hold says when it arrived and who from');
{
  const n = npcs.find(x => x.facts.length > 0) || npcs[0];
  LG.game.remember(n, 'the traveller is looking for a saw', 'the traveller');
  const v = LG.view.of(n, 'player');
  const lines = LG.view.held(v), entries = LG.view.heldEntries(v);
  ok(lines.length === entries.length, 'the lines and the things they name line up');
  ok(lines.every(l => /^\([^)]+\) /.test(l)), 'every line opens with where it came from');
  ok(lines.some(l => l.indexOf('from the traveller') !== -1), 'a source is named when there is one');
  ok(lines.some(l => l.indexOf('(a while now)') !== -1),
     'and what they have always had says so rather than inventing a time');

  const prompt = LG.dialogue._debugPrompt(n, null);
  ok(prompt.indexOf('# What you have picked up lately') === -1,
     'there is no second-class list of things they merely heard');
  ok(prompt.indexOf('Everything you have picked up, with when you came by it and who from.') !== -1,
     'and the one list says what it is');
}

/* ----------------------------------------------------- the notebook and truth
   A note records that you were told something. Whether it is still worth acting
   on is read off the world, not stored on the note — so there is no way to write
   one that claims to be a live lead when the thing it describes has already
   happened. That used to be possible: a villager could tell you "Yuri is looking
   for a pair of shoes" after you had given Yuri the shoes, and it went in as a
   fresh lead, because the writing path knew about one kind of resolution and not
   the other. */
section('a spent lead cannot be written as a live one');
{
  const g = LG.game;
  const ownFacts = n => (n.facts || []).filter(id => {
    const f = plan.facts[id];
    return f && f.link === (plan.roles[n.def.id] || {}).link && f.type !== 'opinion';
  });
  // an earlier section already settled one link, so take a villager still owed theirs
  const who = npcs.find(n => !n.tradeDone && (plan.roles[n.def.id] || {}).trade &&
                             ownFacts(n).length > 0);
  ok(!!who, 'somebody still has a deal of their own outstanding');
  if (who) {
    const lk = plan.links[plan.roles[who.def.id].link];
    const id = ownFacts(who)[0];

    ok(g.factSpent(id) === false, 'before the deal, the fact is live');
    g.state.notes = [];
    g.learn(id, null, 'told about it');
    ok(g.hasNote(id), 'and a note can be taken about it');
    ok(g.factSpent(id) === false, 'which reads as live');

    g.give(lk.wants, lk.wantsCount || 1);
    g.doTrade(who, plan.roles[who.def.id].trade);

    ok(g.factSpent(id) === true, 'once the deal is done the fact is spent');
    ok(g.hasNote(id), 'and the note is still there — a line that vanishes reads as a bug');

    /* The point of the change: the same write, after the fact is spent, cannot
       produce a live lead. There is no argument to `learn` that would let it. */
    g.state.notes = [];
    g.learn(id, null, 'told about it again, too late');
    ok(g.hasNote(id), 'you can still be told, and it is still recorded');
    ok(g.factSpent(id) === true, 'but it is spent the moment it is written');
    ok(g.state.notes.every(n => !('done' in n)),
       'and the note carries no doneness of its own to disagree with the world');
  }
}

section('an opinion is never spent');
{
  const op = Object.keys(plan.facts).find(id => plan.facts[id].type === 'opinion');
  ok(!!op, 'the village has opinions');
  if (op) ok(LG.game.factSpent(op) === false, 'and no amount of trading settles one');
}

section('an opinion never reaches the notebook');
{
  const g = LG.game;
  const op = Object.keys(plan.facts).find(id => plan.facts[id].type === 'opinion');
  const holder = npcs.find(n => op && n.facts.indexOf(op) !== -1);
  ok(!!holder, 'somebody in earshot actually holds the opinion');
  if (op && holder) {
    g.state.notes = [];
    g.learn(op, holder, 'told about it');
    ok(!g.hasNote(op), 'gossip does not get written down');
    ok(g.state.notes.length === 0, 'the notebook stays a list of the errand, not the village talking');
  }
}

section('a fact teaches its word too, read off the chain link rather than parsed');
{
  const g = LG.game;
  const wantId = Object.keys(plan.facts).find(id => plan.facts[id].type === 'want');
  ok(!!wantId, 'the village has at least one want fact');
  if (wantId) {
    const f = plan.facts[wantId];
    const lk = plan.links[f.link];
    const holder = npcs.find(n => n.facts.indexOf(wantId) !== -1);
    g.state.words = [];
    g.state.notes = [];
    g.learn(wantId, holder, 'told about it');
    if (lk.wants === 'coins') {
      ok(g.state.words.length === 0, 'coins are never added — see game.js\'s itemForFact');
    } else {
      ok(g.hasWord(lk.wants), 'the item that fact concerns is now on the word list');
      const before = g.state.words.length;
      g.state.notes = [];
      g.learn(wantId, holder, 'told about it again');
      ok(g.state.words.length === before, 'and telling you again does not teach it twice');
    }
  }
}

section('the word list, from holding a thing rather than being told about it');
{
  const g = LG.game;
  g.state.words = [];
  ok(!g.hasWord('shiny_rock'), 'nothing logged yet');
  g.give('shiny_rock', 1, 'picked up');
  ok(g.hasWord('shiny_rock'), 'holding an item teaches its word');
  ok(g.state.words[0].how === 'picked up', 'and remembers how it arrived');
  const n = g.state.words.length;
  g.give('shiny_rock', 1, 'picked up again');
  ok(g.state.words.length === n, 'a second one does not teach the word twice');
  ok(!g.hasWord('coins'), 'coins start off the list');
  g.give('coins', 5);
  ok(!g.hasWord('coins'), 'and stay off it even once you are actually holding some');

  g.renderWords();
  const html = sandbox.document.getElementById('wordsList').innerHTML;
  ok(html.indexOf(LG.itemName('shiny_rock', g.settings.lang)) !== -1,
     'the panel shows the word in the language you are learning');
  ok(html.indexOf('shiny rock') !== -1,
     'and its English gloss, unblurred — a study aid, not the same test the notebook is');
  ok(html.indexOf('picked up') !== -1, 'and how it was learned');
}

section('spaced repetition on the word list: due, graded, and due again later — or not');
{
  const g = LG.game;
  g.state.words = [];
  g.give('shiny_rock', 1, 'picked up');
  const w = g.state.words[0];
  ok(w.level === 0 && typeof w.due === 'number' && w.due <= Date.now(),
     'a freshly-learned word starts at level 0, due immediately');
  ok(g.dueWords().indexOf(w) !== -1, 'so it shows up as due right away');

  g.gradeWord(w, true);
  ok(w.level === 1, 'graded "Good", it moves up a level');
  ok(w.due > Date.now(), 'and is not due again until later — real time, not the village clock');
  ok(g.dueWords().indexOf(w) === -1, 'so it drops out of what is due right now');

  g.gradeWord(w, false);
  ok(w.level === 0 && w.due <= Date.now(),
     'graded "Again" instead, it resets to level 0, due immediately — a level 1 mistake is not remembered as level 1');

  // A whole session: two words due, one graded wrong once before it is
  // graded right, the queue only empties once every word has actually been
  // gotten right at least once this session.
  g.give('beans', 1, 'picked up');
  const w2 = g.state.words[1];
  ok(g.dueWords().length === 2, 'both words are due to start the session');
  g.startReview();
  ok(g.reviewQueue.length === 2, 'the session queue starts with everything due');
  g.reviewGrade(false);                 // the first word, gotten wrong
  ok(g.reviewQueue.length === 2, 'gotten wrong, it goes to the back of the queue rather than off it');
  ok(g.reviewQueue[1] === w, 'specifically the one just answered, not the other one');
  g.reviewGrade(true);                  // now the second word (w2), gotten right
  ok(g.reviewQueue.length === 1 && g.reviewQueue[0] === w,
     'gotten right, it leaves the queue — only the missed one is left');
  g.reviewGrade(true);                  // w, tried again, gotten right this time
  ok(g.reviewQueue === null, 'and the session ends once nothing is left in it');

  // Rendered, not just in the data: the button, and the card itself.
  g.state.words = [];
  g.give('shiny_rock', 1, 'picked up');
  g.renderWords();
  let html = sandbox.document.getElementById('wordsReview').textContent;
  ok(html.indexOf('1 due') !== -1, 'the button counts what is actually due');

  g.startReview();
  html = sandbox.document.getElementById('wordsList').innerHTML;
  ok(html.indexOf(LG.itemName('shiny_rock', g.settings.lang)) !== -1,
     'the card shows the word to be recalled');
  ok(html.indexOf('display:none') !== -1,
     'but the answer stays display:none until "Show answer" is pressed');
  // getElementById auto-vivifies an id nobody has asked for in this fake DOM
  // (see elem() at the top of this file), so "is it there" has to be read
  // off the rendered markup itself, not off whether a lookup came back truthy.
  ok(html.indexOf('id="wordsShow"') !== -1, 'a way to ask for it');
  ok(html.indexOf('id="wordsGood"') === -1 && html.indexOf('id="wordsAgain"') === -1,
     'and no way to grade a card not yet shown');

  sandbox.document.getElementById('wordsShow').onclick();
  html = sandbox.document.getElementById('wordsList').innerHTML;
  ok(html.indexOf('id="wordsGood"') !== -1 && html.indexOf('id="wordsAgain"') !== -1,
     'showing the answer is what reveals the grading buttons');
  ok(html.indexOf('shiny rock') !== -1, 'and the answer itself');

  sandbox.document.getElementById('wordsGood').onclick();
  ok(g.reviewQueue === null, 'grading the only card due ends the session');

  g.state.words = [];
}

/* ------------------------------------------------------------------- saving
   One format, both ways round. What is checked here is that a village survives
   being written down and read back — not that localStorage works, but that
   everything the player has done is in the file and comes out the other side.
   The same bytes are what the log server keeps in saves/village.json, so a
   round trip through a string is the file, exactly. */
section('a village, written down and read back');
{
  const g = LG.game;
  g.settings.apiKey = 'sk-not-a-real-key';        // must not reach the file
  g.settings.ttsKey = 'sk_not-a-real-voice-key';
  g.state.deeds.push('Gave Mira a pie, got a shell.');
  g.give('coins', 7);
  const someFact = Object.keys(plan.facts)[0];
  const holder = npcs.find(n => n.facts.indexOf(someFact) !== -1);
  if (holder) {
    g.learn(someFact, holder);
    LG.game.remember(holder, 'the traveller cannot say much yet', 'the traveller');
  }
  npcs[0].coins = 41;
  npcs[0].stock.apple = 2;
  /* Petra meets the train, once, when the village is new — and this village is
     not new any more: she has long since said hello and gone back to running
     about. The other half of the same state is somebody who really is on their
     way over right now, so both halves get written down and read back. */
  const petra = npcs.find(n => n.def.id === 'petra');
  if (petra) {
    petra.followingPlayer = false; petra.wentAfter = null; petra.why = '';
  }
  const chaser = npcs.find(n => n.def.id !== 'petra');
  if (chaser) {
    chaser.followingPlayer = true; chaser.wentAfter = 'player';
    chaser.why = 'wants to know what the traveller made of the bread';
  }
  /* The one thing about a village that changes while you play it: the thing
     lying at the end of the chain gets collected. */
  if (g.beast) { g.beast.caught = true; g.beast.following = true; }
  else if (g.worldItem) { g.worldItem.taken = true; }
  // guaranteed non-empty regardless of what f0 happened to be about above
  g.learnWord('shiny_rock', 'test fixture');
  // same reason — this round trip runs before any villager has actually
  // talked to another one, so metWith would otherwise be empty on both sides
  npcs[0].metWith = {}; npcs[0].metWith[npcs[1].def.id] = { day: LG.time.day, at: '12:00' };
  // distinct from LG.time.day, so a restore that quietly dropped it or
  // quietly recomputed it from the current day would both show up
  g.state.arrivedDay = LG.time.day - 3;

  const before = {
    seed: plan.seed, day: LG.time.day, frac: LG.time.frac,
    weather: LG.time.weather, snow: LG.time.snow, arrivedDay: g.state.arrivedDay,
    inv: JSON.stringify(g.state.inv), notes: JSON.stringify(g.state.notes),
    words: JSON.stringify(g.state.words),
    deeds: JSON.stringify(g.state.deeds),
    px: Math.round(g.player.px * 10) / 10,
    facts: npcs.map(n => n.facts.join(',')).join('|'),
    memory: npcs.map(n => JSON.stringify(n.memory)).join('|'),
    metWith: npcs.map(n => JSON.stringify(n.metWith || {})).join('|'),
    till: npcs.map(n => JSON.stringify(n.till || [])).join('|'),
    where: npcs.map(n => n.tx + ',' + n.ty).join('|')
  };

  const shot = LG.save.snapshot();
  ok(shot && shot.v === LG.save.VERSION && shot.game === 'little-village',
     'a snapshot is a versioned little-village save');
  ok(LG.save.check(shot) === null, 'and it is one this version will take back');
  ok(shot.village.seed === plan.seed && shot.village.level === g.settings.level &&
     shot.village.lang === g.settings.lang,
     'it carries the seed, the difficulty and the language the village was built from');
  ok(Object.keys(shot.villagers).length === npcs.length, 'and every villager');

  const text = JSON.stringify(shot);
  ok(text.indexOf('sk-not-a-real-key') === -1 && text.indexOf('sk_not-a-real-voice-key') === -1,
     'no API keys go into a file that gets written to disk');
  console.log('   ' + Math.round(text.length / 1024) + 'kB of village, ' +
              Object.keys(shot.villagers).length + ' villagers, ' +
              shot.notes.length + ' notes');

  // somewhere else entirely, so a restore that quietly did nothing would show
  g.newVillage('quite-another-village', true);
  ok(LG.game.plan.seed !== before.seed, 'a different village, to lose the first one in');

  // through a string and back: this is the file, not a live object
  const why = LG.save.restore(JSON.parse(text));
  ok(why === null, 'the save loads' + (why ? ': ' + why : ''));

  const after = LG.game;
  ok(after.plan.seed === before.seed, 'the same village came back');
  ok(LG.save.digestOf(after.plan) === shot.village.digest,
     'and the generator built the same chain from the seed');
  ok(LG.time.day === before.day && Math.abs(LG.time.frac - before.frac) < 1e-9,
     'on the same day, at the same hour');
  ok(LG.time.weather === before.weather && Math.abs(LG.time.snow - before.snow) < 1e-9,
     'under the same sky, with the same snow lying');
  ok(JSON.stringify(after.state.inv) === before.inv, 'with the same pockets');
  ok(JSON.stringify(after.state.notes) === before.notes, 'the same notebook');
  ok(JSON.stringify(after.state.words) === before.words, 'and the same word list');
  ok(JSON.stringify(after.state.deeds) === before.deeds, 'and the same deeds behind you');
  ok(after.state.arrivedDay === before.arrivedDay,
     'and the same arrival day, so the ending screen still counts the errand right');
  ok(Math.round(after.player.px * 10) / 10 === before.px, 'standing where you were');

  const back = after.npcs;
  ok(back.length === npcs.length, 'the same cast');
  ok(back.map(n => n.facts.join(',')).join('|') === before.facts,
     'everyone knows what they knew');
  ok(back.map(n => JSON.stringify(n.memory)).join('|') === before.memory,
     'and remembers what they had picked up, with when and from whom');
  ok(back.map(n => JSON.stringify(n.metWith || {})).join('|') === before.metWith,
     'and who they have talked with before, and when');
  ok(back.map(n => JSON.stringify(n.till || [])).join('|') === before.till,
     'the tills square up');
  ok(back.map(n => n.tx + ',' + n.ty).join('|') === before.where,
     'and everybody is standing where they were left');
  ok(back[0].coins === 41 && back[0].stock.apple === 2, 'purses and stock come back');
  ok(after.beast ? (after.beast.caught && after.beast.following)
                 : (after.worldItem && after.worldItem.taken),
     'and the thing at the end of the chain is still collected, not lying there again');
  ok(back.every(n => !n.route && !n.frozen && !n.chatting),
     'nobody comes back mid-errand, mid-freeze or mid-conversation');
  /* The village a restore lands on is a brand new one, and Petra sets off to
     meet the train in every brand new village. Reopening a village you have
     been living in for days is not an arrival, and she should not treat it as
     one. */
  const petraBack = back.find(n => n.def.id === 'petra');
  ok(petraBack && !petraBack.followingPlayer && !petraBack.wentAfter && !petraBack.why,
     'Petra does not come running to greet you off a train you got off days ago');
  const chaserBack = chaser && back.find(n => n.id === chaser.id);
  ok(!chaser || (chaserBack && chaserBack.followingPlayer &&
                 chaserBack.wentAfter === 'player' && chaserBack.why === chaser.why),
     'and somebody who really was on their way over is still coming, and still knows why');
  ok(!chaserBack || !chaserBack.followFor,
     'with the chase timed from now rather than from before the reload');
  ok(back.every(n => LG.world.isWalkable(n.tx, n.ty)),
     'and everybody comes back somewhere they can stand');
  ok(back.every(n => n.patch && typeof n.patch.x === 'number'),
     'their patch is a rectangle again, not four loose numbers');

  const known = [back[0].def.home, back[0].work, back[0].shelter, LG.GREEN]
    .concat(LG.world.buildings.map(b => b.inside));
  ok(!known.some(r => r && r.x === back[0].patch.x && r.y === back[0].patch.y &&
                      r.w === back[0].patch.w && r.h === back[0].patch.h) ||
     known.indexOf(back[0].patch) !== -1,
     'a patch that is one of the real rectangles comes back as that rectangle');

  /* A save written before any of this was recorded says nothing about who is
     chasing whom, and the answer to that is nobody — not "whoever this new
     village just sent to the platform". */
  {
    const older = JSON.parse(text);
    Object.keys(older.villagers).forEach(id => {
      delete older.villagers[id].chasing;
      delete older.villagers[id].after;
      delete older.villagers[id].why;
    });
    ok(LG.save.restore(older) === null, 'a save from before chases were written down loads');
    ok(LG.game.npcs.every(n => !n.followingPlayer && !n.wentAfter),
     'and nobody in it is chasing the traveller');
    ok(LG.save.restore(JSON.parse(text)) === null, 'and the newer save loads again after it');
  }

  section('a save this version cannot use is refused, out loud');
  ok(typeof LG.save.check({}) === 'string', 'something that is not a village');
  ok(typeof LG.save.check(Object.assign({}, shot, { v: shot.v + 1 })) === 'string',
     'a save from a later version');
  ok(typeof LG.save.check(Object.assign({}, shot, { village: Object.assign({}, shot.village, { level: 'impossible' }) })) === 'string',
     'a difficulty this version does not have');
  const tampered = JSON.parse(text);
  tampered.village.digest = 'notthedigest';
  const standing = LG.game.plan.seed;
  const refused = LG.save.restore(tampered);
  ok(typeof refused === 'string' && refused.indexOf('generator') !== -1,
     'and a village the generator would no longer build the same way');
  ok(LG.game.plan.seed === standing,
     'and being refused leaves the village you were in standing');
  ok(LG.save.restore(JSON.parse(text)) === null, 'the good save still loads afterwards');

  /* A version-1 save is a save from the map before the forest and the
     station — every coordinate in it means somewhere 40 tiles further north
     than it should. It is not hand-built by loading the old code (heavy, and
     not what a real v1 save looks like from the outside): it is built the
     way `restore` itself would check one, by generating a plan under the old
     LG.PLACES order and taking its digest, then shifting a couple of
     coordinates back by hand to stand in for what an old save's numbers
     would have been. */
  section('a version-1 save is migrated, not refused');
  {
    // A requested seed is not always the seed a village ends up with — an
    // unsolvable draw gets retried under a suffixed one (see chain.js), so
    // what a save actually names is whatever `plan.seed` came back as, the
    // same as `snapshot` reads off the live plan rather than off a request.
    const v1Plan = LG.save._withPlacesV1(() =>
      LG.chain.generate({ level: 'beginner', seed: 'migration-check-' + plan.seed }));
    const v1Digest = LG.save.digestOf(v1Plan);

    const mira = LG.NPCS.find(n => n.id === 'mira');
    const oldHome = { x: mira.home.x, y: mira.home.y - 40, w: mira.home.w, h: mira.home.h };

    const v1save = {
      v: 1, game: 'little-village', saved: new Date().toISOString(),
      village: { seed: v1Plan.seed, level: 'beginner', lang: 'en', digest: v1Digest },
      time: { day: 3, frac: 0.4, weather: 'clear', hold: 0, snow: 0 },
      player: { x: 200, y: 300, dir: 'down' },
      inventory: { coins: 7 },
      notes: [], deeds: [], board: [], won: false,
      terminal: null,
      villagers: {
        mira: { x: 400, y: 400, tx: 12, ty: 12, dir: 'down', facts: [], memory: [],
                factAt: {}, factNote: {}, coins: 5, stock: {}, sold: {}, till: [],
                history: [], met: false, traded: false, patch: oldHome }
      }
    };

    ok(typeof LG.save.check(v1save) !== 'string', 'check() lets a v1 shape through');
    const why = LG.save.restore(v1save);
    ok(why === null, 'a v1 save is accepted rather than refused' + (why ? ': ' + why : ''));
    ok(LG.game.plan.seed === v1Plan.seed, 'and it is the village the save actually named');

    ok(LG.game.player.py === 300 + 40 * 32, 'the player comes back 40 tiles further south');
    ok(LG.game.player.px === 200, 'and not shifted east or west, which never moved');

    const back = LG.game.npcs.find(n => n.id === 'mira');
    ok(back.py === 400 + 40 * 32 && back.ty === 12 + 40, 'the villager moves by the same amount');
    ok(back.patch === back.def.home,
       'and her old home rectangle resolves to her actual, current home — not a lookalike copy');

    /* The village now saves as version 2 — its coordinates really are v2 —
       but its seed only ever produced this plan under the *old* LG.PLACES,
       and LG.PLACES has grown again since (the platform and the six glades
       joined it this same change). Losing track of that would make the
       *second* close-and-reopen of a migrated village fail exactly the
       failure this whole feature exists to avoid: a save that is still
       correct being refused for a change that has nothing to do with it. */
    const resaved = LG.save.snapshot();
    ok(resaved.v === LG.save.VERSION, 'the next save this village writes is tagged current');
    ok(resaved.village.placesV1 === true,
       'and still says which place list its seed has to be replayed against');
    ok(LG.save.restore(JSON.parse(JSON.stringify(resaved))) === null,
       'so closing and reopening it a second time still works');
    ok(LG.game.plan.seed === v1Plan.seed, 'as the same village, not a refusal or a new one');
  }

  section('a save this version cannot read backwards is still refused');
  ok(typeof LG.save.check(Object.assign({}, shot, { v: 0 })) === 'string',
     'nothing this old has a migration');

  /* `learn` guarantees at most one note per fact id, but only on the path
     that goes through it. A save file reaches `state.notes` a different
     way, and nothing before this stopped one from naming the same fact
     twice — hand-edited, or some future bug that writes a duplicate. */
  section('a fact never ends up with two notes');
  {
    ok(after.state.notes.length === new Set(after.state.notes.map(n => n.id)).size,
       'the notebook restored above has no fact id twice');
    ok(after.state.notes.every(n => !!plan.facts[n.id]),
       'and every note in it names a fact that actually exists');

    const dupe = JSON.parse(text);
    dupe.notes = [{ id: someFact, text: 'first telling', ruby: null },
                  { id: someFact, text: 'second telling', ruby: null }];
    ok(LG.save.restore(dupe) === null, 'a save with the same fact noted twice still loads');
    const mine = LG.game.state.notes.filter(n => n.id === someFact);
    ok(mine.length === 1, 'but only one note survives for that fact');
    ok(mine[0].text === 'first telling', 'and it is the first telling that wins, not the last');

    ok(LG.save.restore(JSON.parse(text)) === null, 'the untampered save still loads afterwards');
  }

  section('both sinks are handed the same bytes');
  const written = LG.save.write();
  ok(!!written, 'a write produces a save');
  ok(JSON.stringify(LG.save._local()) === JSON.stringify(written),
     'and what went into localStorage is what the log server was posted');
  ok(LG.save.has(), 'so there is a village to come back to');
  LG.save.forget();
  ok(!LG.save.has(), 'and a way to be rid of it');
}

/* --------------------------------------------------- closing the tab
   The half that in-process round trips cannot reach: a browser that has never
   seen this village starts up with nothing but what was written to storage, and
   has to arrive in the village rather than roll a new one. This is the path the
   player actually takes, and the one that breaks when init() changes. */
section('closing the tab and opening it again');
{
  const written = LG.save.write();                 // as the autosave would have
  const store2 = {
    'lg-save': JSON.stringify(written),
    'lg-settings': JSON.stringify(LG.game.settings)
  };
  const s2 = makeSandbox(store2);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), s2, { filename: f });
  }
  s2.LG.game.init();
  s2.LG.game.thoughts = false;                     // no narration in a test
  s2.LG.game.settings.npcChatter = false;          // and nothing sent, key or no key

  ok(s2.LG.save.resumed, 'a fresh browser came back into the saved village');
  ok(s2.LG.game.plan.seed === written.village.seed,
     'the same village, not a new one: ' + s2.LG.game.plan.seed);
  ok(s2.LG.time.day === written.time.day &&
     Math.abs(s2.LG.time.frac - written.time.frac) < 1e-9, 'on the same day and hour');
  ok(s2.LG.time.weather === written.time.weather, 'under the same sky');
  ok(JSON.stringify(s2.LG.game.state.inv) === JSON.stringify(written.inventory),
     'with what you were carrying');
  ok(s2.LG.game.state.notes.length === written.notes.length, 'and the notebook you had');
  ok(s2.LG.game.npcs.every(n => n.facts.join(',') === written.villagers[n.id].facts.join(',')),
     'and everyone still knows what they knew');

  // and it keeps running: the village that came back is a village, not a photograph
  for (let i = 0; i < 600; i++) s2.LG.game._debugTick(1 / 30);
  ok(s2.LG.game.npcs.every(n => s2.LG.world.isWalkable(n.tx, n.ty)),
     'and it carries on from there without anyone walking into a wall');

  const again = s2.LG.save.snapshot();
  ok(again.village.digest === written.village.digest,
     'a save of the resumed village is a save of the same village');
}

/* ------------------------------------------------ a reason, shown or withheld
   Every model-driven move comes back with a `why`, and it used to reach only
   the console — see game.js's `think`. It reaches the player's own event log
   now, close up and only once, which is the part actually worth pinning down:
   a villager put back on the dice table between one decision and the next
   must not have an old reason read out over an arrival it had nothing to do
   with. */
section('the reason a villager went somewhere, told to a nearby player once');
{
  const g = LG.game;
  // read fresh rather than trusting the copy taken at the top of the file —
  // the cast has been rebuilt by a restore since then (see villagersTalking's
  // own version of this note)
  const n = g.npcs[0];
  const readLog = () => sandbox.document.getElementById('log').innerHTML;
  const countMentions = html => (html.match(/heard bread was in/g) || []).length;

  const restorePlayer = { px: g.player.px, py: g.player.py };
  const restoreN = { patch: n.patch, why: n.why, whyPatch: n.whyPatch,
                     wasWalking: n.wasWalking, route: n.route, frozen: n.frozen,
                     followingPlayer: n.followingPlayer };
  const restoreChatter = g.settings.npcChatter;
  // `frozen` keeps A.routine (and, through it, a real decideWhereToGo call —
  // this test does not mock LG.llm.intent) from touching n.patch/n.route out
  // from under the fixture below; npcChatter off keeps A.meet from pulling n
  // into a conversation of its own mid-test. Neither affects the "arrives"
  // check itself, which reads state routine() would only have overwritten.
  n.frozen = true;
  g.settings.npcChatter = false;

  g._debugPlayerAt(n.px, n.py);            // close enough to overhear
  const rectA = { x: 1, y: 1, w: 2, h: 2 }, rectB = { x: 9, y: 9, w: 2, h: 2 };

  // a model decision just landed, and the walk it started has just finished
  n.followingPlayer = false; n.route = [];
  n.patch = rectA; n.why = 'heard bread was in'; n.whyPatch = rectA;
  n.wasWalking = true;
  g._debugTick(1 / 30);
  const first = readLog();
  ok(countMentions(first) === 1, 'the reason for the arrival it was actually for reaches the log');
  ok(!n.why && !n.whyPatch, 'and is consumed — not still sitting there for the next one');

  // the dice table moves them again, with nothing behind it — routine's own
  // fallback never sets whyPatch, which this reproduces directly
  n.patch = rectB; n.why = 'heard bread was in'; n.whyPatch = rectA; // stale, from the first move
  n.wasWalking = true; n.route = [];
  g._debugTick(1 / 30);
  const second = readLog();
  ok(countMentions(second) === countMentions(first),
     'a reason for a different patch is not read out over an unrelated arrival — no new copy of the line');

  Object.assign(n, restoreN);
  g.settings.npcChatter = restoreChatter;
  g._debugPlayerAt(restorePlayer.px, restorePlayer.py);
}

/* ------------------------------------------------------- nothing left behind */
section('the old copies are gone');
const src = {};
for (const f of files) src[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
const all = Object.values(src).join('\n');
ok(!/function atWork\b|function behindTheCounter\b|function describeWhere\b/.test(all),
   'atWork / behindTheCounter / describeWhere have one home');
ok((all.match(/function inRect\(/g) || []).length === 1, 'inRect is defined once');
ok((all.match(/function nearRect\(/g) || []).length === 1, 'nearRect is defined once');
ok(!/"exchanged"|\.exchanged\b/.test(all), 'the exchange field nobody read is gone');
ok(!/o\.purse|o\.wares|o\.theirs/.test(all), 'the unwired trade branches are gone');
ok(!/\bctx\.factsOf\b|\bctx\.aKnows\b|\bctx\.soughtBy\b/.test(all),
   'the conversation takes view snapshots, not callbacks');

/* --------------------------------------------------- two villagers talking
   The one path that cannot be reached without a key, so the model is replaced
   by a stub that records what it was handed. What is being checked is the
   plumbing: that a conversation is given two villagers who know who they are. */
async function beliefsRevised() {
  section('a villager can rewrite what they held');

  const n = npcs.find(x => x.facts.length > 0);
  ok(!!n, 'somebody holds a chain fact');
  if (n) {
    const id = n.facts[0];
    const before = LG.view.of(n, 'player').knows.find(f => f.id === id);
    const real = LG.llm.revise;

    // the reader says line 1 has been overtaken, and gives it back rewritten
    LG.llm.revise = async () => ({ n: 1, line: 'that was so, and has since been settled' });
    await LG.dialogue._reviseHeld(n, 'the traveller settled it just now');
    const after = LG.view.of(n, 'player').knows.find(f => f.id === id);

    ok(n.facts.indexOf(id) !== -1, 'the fact is still theirs — nothing was deleted');
    ok(after.text !== before.text, 'but they say it differently now');
    ok(after.revised === true, 'and the view knows it is their own wording');
    ok(after.plain === before.plain, 'while the canonical text is untouched, so ids still mean what they meant');
    ok(LG.dialogue._debugPrompt(n, null).indexOf('has since been settled') !== -1,
       'and it is what reaches the prompt');

    // nothing overtaken is the ordinary answer, and must leave them alone
    const held = LG.view.of(n, 'player').knows.find(f => f.id === id).text;
    LG.llm.revise = async () => null;
    await LG.dialogue._reviseHeld(n, 'the weather is grey');
    ok(LG.view.of(n, 'player').knows.find(f => f.id === id).text === held,
       'a reader that finds nothing out of date changes nothing');

    LG.llm.revise = async () => { throw new Error('no key'); };
    await LG.dialogue._reviseHeld(n, 'anything at all');
    ok(LG.view.of(n, 'player').knows.find(f => f.id === id).text === held,
       'and a failed call leaves them believing what they believed');
    LG.llm.revise = real;
  }
}

async function villagersTalking() {
  section('two villagers stop for a word');
  const seen = [];
  LG.llm.converse = async (cfg, opts) => {
    seen.push(opts);
    return { say: 'Доброе утро.', translation: 'Good morning.' };
  };
  let recalled = null;
  LG.llm.recall = async (cfg, opts) => { recalled = opts; return null; };
  LG.llm.intent = async () => null;                 // nobody wanders off mid-test

  // the cast is rebuilt by a restore, so read it now rather than trusting the
  // copy taken at the top of the file
  const cast = LG.game.npcs;
  const a = cast[0], b = cast[1];
  LG.game.settings.apiKey = 'not-a-real-key';       // both stubs above, so nothing is sent
  LG.game.settings.npcChatter = true;
  LG.dialogue.turnHold = 0;
  LG.dialogue._chatReset();
  a.frozen = b.frozen = false;
  a.chatting = b.chatting = false;
  a.route = b.route = null;
  b.px = a.px + 8; b.py = a.py;
  b.tx = a.tx; b.ty = a.ty;
  a.gossipCool = b.gossipCool = 0;
  a.wentAfter = b.def.id;                            // a came looking for b

  for (let i = 0; i < 400 && seen.length < 2; i++) {
    LG.game._debugTick(1 / 30);
    await new Promise(r => setTimeout(r, 0));
  }

  ok(seen.length >= 2, 'they got as far as talking to each other');
  if (seen.length >= 2) {
    const first = seen[0];
    ok(first.me && first.me.name && first.me.job && first.me.persona,
       'the speaker knows who they are');
    ok(first.them && first.them.name, 'and who they are talking to');
    ok(Array.isArray(first.held) && first.held.every(k => typeof k === 'string'),
       'their knowledge arrives as lines, not objects');
    ok(first.held.every(k => /^\(/.test(k)),
       'and every line says when they came by it');
    ok(typeof first.here === 'string' && first.here.length > 0,
       'they know where the two of them are standing');
    ok(seen.some(o => o.sought === true), 'and that one of them came looking for the other');
    ok(seen[0].me.name !== seen[1].me.name, 'they take turns');
  }
  ok(a.wentAfter === null && b.wentAfter === null,
     'and what brought them is spent, so the next meeting is a coincidence again');

  for (let i = 0; i < 600 && !recalled; i++) {
    LG.game._debugTick(1 / 30);
    await new Promise(r => setTimeout(r, 0));
  }
  ok(!!recalled, 'and afterwards somebody works out what they took away');
  if (recalled) {
    const flat = JSON.stringify(recalled);
    ok(flat.indexOf('You think') === -1,
       'the reader gets the facts as written, not in either villager\'s own voice');
  }

  section('and they remember having talked, next time');
  ok(!!(a.metWith && a.metWith[b.def.id]), 'a now has b on their own metWith');
  ok(!!(b.metWith && b.metWith[a.def.id]), 'and b has a on theirs — each side keeps its own copy');
  if (a.metWith && a.metWith[b.def.id])
    ok(a.metWith[b.def.id].day === LG.time.day, 'dated to today, the day this meeting happened');
  {
    const seen2 = [];
    LG.llm.converse = async (cfg, opts) => {
      seen2.push(opts);
      return { say: 'Опять ты.', translation: 'You again.' };
    };
    a.chatting = b.chatting = false; a.frozen = b.frozen = false;
    await LG.dialogue._startChat({ a, b, ctx: { a: LG.view.of(a, 'chat'), b: LG.view.of(b, 'chat') } });
    ok(seen2.length >= 2, 'a second conversation between the same two happens too');
    if (seen2.length >= 2) {
      ok(typeof seen2[0].metBefore === 'string' && seen2[0].metBefore.indexOf(b.def.name) !== -1,
         'and this time the first line carries that they have talked before, naming who');
      ok(seen2[0].metBefore.indexOf('today') !== -1,
         'dated, since — in this fake, instant-turnaround test — it really was earlier today');
      ok(typeof seen2[1].metBefore === 'string' && seen2[1].metBefore.indexOf(a.def.name) !== -1,
         'and the other side of the conversation gets its own version, naming the other name');
    }
  }

  await namesUnknownUntilTold();
  await peopleRoster();
  await gentleCorrections();
  await noCrutchesAtAdvanced();
  await micButton();
  await touchControls();
  await roomForTheComposer();
  whatYouCanSee();

  console.log('\n' + (failures ? failures + ' of ' + checks + ' CHECKS FAILED'
                               : 'SMOKE TEST PASSED (' + checks + ' checks)'));
  process.exit(failures ? 1 : 0);
}

/* Everywhere the game speaks in its own voice about a villager — the
   nametag, the dialogue header, the hint, the log — has to fall back to
   their job until that particular villager has actually said their name to
   the player. Nothing else should be able to set it: not a fact arriving
   from someone else, not talking to them about something other than who
   they are. */
async function namesUnknownUntilTold() {
  section('names are unknown until you are told them');
  const g = LG.game, npc = g.npcs.find(n => !n.nameKnown) || g.npcs[0];
  npc.nameKnown = false;                              // in case an earlier section set it

  ok(g.displayName(npc) === npc.def.job, 'unmet, the game calls them by their job');
  ok(g.nameOrEmoji(npc) === npc.def.emoji, 'and a native-language line uses the emoji, not English');

  // Being told about them by someone else does not count — only they can tell you.
  g.remember(npc, 'somebody else told the traveller this villager\'s name is ' + npc.def.name, 'a bystander');
  ok(!npc.nameKnown, 'hearsay about their name is not the same as being told it');

  const real = LG.llm.speak;

  // A reply that never states their own name teaches nothing.
  LG.llm.speak = async () => ({ say: 'Hmm?', translation: 'What do you want?', understood: 'full' });
  LG.dialogue.open(npc);
  await LG.dialogue.send('Hello!');
  ok(!npc.nameKnown, 'an ordinary reply does not reveal it');
  ok(sandbox.document.getElementById('dlgName').textContent === '?',
     'and the open dialogue panel marks the name unknown rather than repeating the job line beneath it');
  LG.dialogue.close();

  // Asking outright, and being told, does.
  LG.llm.speak = async () => ({
    say: 'stand-in for a line in the village\'s language', understood: 'full',
    translation: 'My name is ' + npc.def.name + ', nice to meet you.'
  });
  LG.dialogue.open(npc);
  await LG.dialogue.send('What is your name?');
  ok(npc.nameKnown, 'stating their own name in the translation is what teaches it');
  ok(sandbox.document.getElementById('dlgName').textContent === npc.def.name,
     'and the panel already open updates mid-conversation, without being reopened');
  ok(g.displayName(npc) === npc.def.name, 'from here on the game uses their name');
  ok(g.nameOrEmoji(npc) === npc.def.name, 'in every language, not only English');
  LG.dialogue.close();

  // It survives a save and comes back, the same as anything else about them.
  const shot = LG.save.snapshot();
  const why = LG.save.restore(JSON.parse(JSON.stringify(shot)));
  ok(why === null, 'the village reloads' + (why ? ': ' + why : ''));
  const back = LG.game.npcs.find(n => n.id === npc.id);
  ok(back.nameKnown === true, 'and a name once learned is not forgotten on reload');

  LG.llm.speak = real;
}

async function peopleRoster() {
  section('the villager roster: a face until met, a job and maybe a name after');
  const g = LG.game;
  g.npcs.forEach(n => { n.metPlayer = false; n.nameKnown = false; });

  g.openPeople();
  let html = sandbox.document.getElementById('peopleList').innerHTML;
  ok(g.npcs.every(n => html.indexOf(n.def.job) === -1),
     'nobody unmet gives up their job just by being listed');
  ok((html.match(/class="person muted"/g) || []).length === g.npcs.length,
     'every row starts muted, before anyone has been spoken to');

  const met = g.npcs[0], stillUnmet = g.npcs[1];
  met.metPlayer = true;
  g.renderPeople();
  html = sandbox.document.getElementById('peopleList').innerHTML;
  ok(html.indexOf(met.def.job) !== -1, 'met, their job shows up');
  ok(html.indexOf(g.displayName(met)) !== -1,
     'and the row reads the same name-or-job the dialogue box and nametag would');
  ok(html.indexOf(stillUnmet.def.job) === -1,
     'someone else stays a face regardless — meeting one villager does not out the rest');

  met.nameKnown = true;
  g.renderPeople();
  html = sandbox.document.getElementById('peopleList').innerHTML;
  ok(html.indexOf(met.def.name) !== -1, 'and their actual name appears once they have given it');
}

/* Off by default, and never in the villager's own mouth — see llm.js's
   correct and dialogue.js's offerCorrection. */
async function gentleCorrections() {
  section('a gentle correction, footnoted under your own line');
  const g = LG.game, npc = g.npcs[0];
  const realSpeak = LG.llm.speak, realCorrect = LG.llm.correct;
  LG.llm.speak = async () => ({ say: 'stand-in', translation: 'stand-in', understood: 'full' });
  const dlgLog = sandbox.document.getElementById('dlgLog');
  const wasOn = g.settings.corrections;

  let calls = 0;
  LG.llm.correct = async () => { calls++; return null; };

  g.settings.corrections = false;
  LG.dialogue.open(npc);
  await LG.dialogue.send('a line, off by default');
  await LG.dialogue.settled();
  ok(calls === 0, 'off by default, nothing extra is asked at all');
  LG.dialogue.close();

  g.settings.corrections = true;
  calls = 0;
  LG.dialogue.open(npc);
  await LG.dialogue.send('', 'coins');
  await LG.dialogue.settled();
  ok(calls === 0, 'a pure item offer, no words of its own, is not sent for checking');
  LG.dialogue.close();

  let seenSaid = null;
  LG.llm.correct = async (cfg, said) => {
    calls++; seenSaid = said;
    return { correction: 'the tidied-up line', note: 'a small fix' };
  };
  calls = 0;
  LG.dialogue.open(npc);
  // the player's own row, not the villager's reply that lands right after it
  const playerRowIdx = dlgLog.children.length;
  await LG.dialogue.send('a line worth fixing');
  await LG.dialogue.settled();
  ok(calls === 1, 'with the setting on, a typed line is checked');
  ok(seenSaid === 'a line worth fixing', 'the exact line typed, not the reply or anything else');
  const row = dlgLog.children[playerRowIdx];
  ok(!!(row && row._correction && row._correction.style.display === ''),
     'the correction footnote is shown');
  ok(!!(row && row._correction &&
        row._correction.textContent.indexOf('the tidied-up line') !== -1 &&
        row._correction.textContent.indexOf('a small fix') !== -1),
     'carrying both the corrected line and why');
  LG.dialogue.close();

  LG.llm.correct = async () => null;
  LG.dialogue.open(npc);
  const playerRowIdx2 = dlgLog.children.length;
  await LG.dialogue.send('a line that was already fine');
  await LG.dialogue.settled();
  const row2 = dlgLog.children[playerRowIdx2];
  ok(!!(row2 && row2._correction && row2._correction.style.display === 'none'),
     'and nothing shows at all when there was nothing to fix');
  LG.dialogue.close();

  g.settings.corrections = wasOn;
  LG.llm.speak = realSpeak;
  LG.llm.correct = realCorrect;
}

/* The interface's own difficulty knob — see data.js's LEVELS.advanced and
   game.js's crutchesOff. `spread`/`taper`/`gossip` are exercised by the
   chain-generation fuzz test elsewhere; this is the one that changes what
   gets drawn, so it is checked by rendering something and reading the
   result back rather than by inspecting a generated plan. */
async function noCrutchesAtAdvanced() {
  section('no crutches at advanced: translations locked, phrasebook empty');
  const g = LG.game;
  const wasLevel = g.settings.level, wasTrans = g.settings.showTranslation;

  g.settings.level = 'beginner';
  ok(g.crutchesOff() === false, 'beginner keeps its crutches');
  g.settings.level = 'intermediate';
  ok(g.crutchesOff() === false, 'so does intermediate');
  g.settings.level = 'advanced';
  ok(g.crutchesOff() === true, 'advanced does not');

  // The notebook: locked even with the setting on, and the tooltip stops
  // being a second way to read the answer without clicking through it.
  // A non-opinion fact specifically — learn() silently declines opinions
  // (see "an opinion never reaches the notebook" above), and npc.facts[0]
  // is not guaranteed to be one of the facts it will actually take.
  const factId = Object.keys(plan.facts).find(id => plan.facts[id].type !== 'opinion');
  const npc = (factId && g.npcs.find(n => n.facts.indexOf(factId) !== -1)) || g.npcs[0];
  if (factId && npc.facts.indexOf(factId) !== -1) {
    g.state.notes = g.state.notes.filter(n => n.id !== factId);
    g.settings.showTranslation = true;
    g.learn(factId, npc, 'told about it');
    const html = sandbox.document.getElementById('notebook').innerHTML;
    ok(html.indexOf('hidden-tr') !== -1, 'the gloss stays blurred even with translations switched on');
    ok(html.indexOf('title="no translations at this difficulty"') !== -1,
       'and the tooltip does not just hand the answer over on hover');
  }

  // The dialogue box: same lock, read off the row object directly rather
  // than through a fake DOM's inert querySelectorAll (see addLine).
  const realSpeak = LG.llm.speak;
  LG.llm.speak = async () => ({ say: 'stand-in', translation: 'a plain English gloss', understood: 'full' });
  g.settings.showTranslation = true;
  LG.dialogue.open(npc);
  await LG.dialogue.send('hello');
  const dlgLog = sandbox.document.getElementById('dlgLog');
  const npcRow = dlgLog.children[dlgLog.children.length - 1];
  ok(!!(npcRow && npcRow._trans && npcRow._trans.className.indexOf('hidden-tr') !== -1),
     'the reply\'s own translation is locked too, "show translations" or not');
  ok(!!(npcRow && npcRow._trans && npcRow._trans.onclick === null),
     'and there is no handler left to click past it with');
  LG.dialogue.close();
  LG.llm.speak = realSpeak;

  // The phrase tray: nothing to lean on.
  LG.dialogue.open(npc);
  ok(sandbox.document.getElementById('dlgPhrases').innerHTML.indexOf('Nothing to start from') !== -1,
     'no phrase chips at this difficulty');
  LG.dialogue.close();

  g.settings.level = 'intermediate';
  LG.dialogue.open(npc);
  ok(sandbox.document.getElementById('dlgPhrases').innerHTML.indexOf('Nothing to start from') === -1,
     'but they are back the moment the difficulty is');
  LG.dialogue.close();

  g.settings.level = wasLevel;
  g.settings.showTranslation = wasTrans;
}

/* LG.speech itself is exercised above, on its own, in a browser (this
   sandbox) with no SpeechRecognition to give it. This is the wiring on the
   other side of that: dialogue.js's _toggleMic, driven through a stand-in
   LG.speech so the behaviour is checked independently of whether this
   particular browser actually has the real thing. */
async function micButton() {
  section('the mic button: what it hears lands in the box, never sends itself');
  const npc = LG.game.npcs[0];
  const realSpeech = LG.speech;
  LG.dialogue.open(npc);

  const langsAsked = [];
  let listeningFlag = false, onResult = null, onEnd = null;
  LG.speech = {
    available: () => true,
    get listening() { return listeningFlag; },
    listen: (lang, res, end) => {
      langsAsked.push(lang);
      listeningFlag = true;
      onResult = res; onEnd = end;
      return true;
    },
    stop: () => { listeningFlag = false; }
  };

  const mic = sandbox.document.getElementById('dlgMic');
  const dlgLog = sandbox.document.getElementById('dlgLog');
  const rowsBefore = dlgLog.children.length;

  LG.dialogue._toggleMic();
  ok(langsAsked.length === 1 && langsAsked[0] === LG.LANGUAGES[LG.game.settings.lang].tag,
     'starting listens once, in the language the village actually speaks');
  ok(mic.classList.contains('listening'), 'the button shows it is listening');

  sandbox.document.getElementById('dlgInput').value = '';
  onResult('a misheard line, maybe');
  ok(sandbox.document.getElementById('dlgInput').value === 'a misheard line, maybe',
     'what it heard fills the box, the same as a phrase chip would');
  ok(dlgLog.children.length === rowsBefore,
     'and nothing at all gets sent on the player\'s behalf — they still have to say it themselves');

  LG.dialogue._toggleMic();
  ok(!mic.classList.contains('listening'), 'a second tap stops it early');

  LG.dialogue._toggleMic();
  ok(langsAsked.length === 2, 'and it can be started again');
  onEnd();
  ok(!mic.classList.contains('listening'), 'and stops showing as listening when the browser ends it unprompted');

  LG.dialogue.close();
  ok(!listeningFlag, 'closing the conversation stops it too, mid-listen or not');

  LG.speech = realSpeech;
}

/* The phone half of the controls. Nothing here dispatches a PointerEvent —
   there is no browser in this sandbox to build one — so the gesture is driven
   through the same three calls the real handlers make, which is where all the
   deciding happens anyway: whether a finger is walking or pointing, where the
   stick's middle has got to, and what was under the fingertip. */
async function touchControls() {
  section('a thumb walks, and a tap talks');
  const g = LG.game, T = LG.touch, W = LG.world, TILE = W.TILE;
  g._debugOpenTheDoor();                       // the tap path is dead behind the gate

  /* ------------------------------------------------------------- the stick */
  ok(T.axis === null, 'nothing is pushing until a finger is');
  T._begin(1, 200, 200, 0);
  ok(T.axis === null, 'a finger that has only landed is still a maybe');
  T._move(1, 200 + T.DEAD - 2, 200);
  ok(T.axis === null, 'and a wobble inside the dead zone is not a walk');

  T._move(1, 200 + T.RANGE + 40, 200);
  ok(T.axis && T.axis.x > 0.99 && Math.abs(T.axis.y) < 1e-9,
     'past the rim is due east at full speed');
  ok(!!T._ring, 'and there is a stick on screen to explain why you are walking');

  /* The origin does not creep out to meet an overshooting finger — dragging it
     along used to mean a stride forward, a step back, and a stride forward
     again walked the base across the screen chasing its own trail. */
  ok(T._ring.x === 200 && T._ring.y === 200,
     'the origin stays where the finger first landed even past the rim');
  T._move(1, 200 - T.RANGE, 200);
  ok(T.axis && T.axis.x < -0.99, 'the same fixed origin reads a finger on the far side as due west');
  T._move(1, 200, 200);
  ok(T.axis === null, 'and coming back to the middle stops you');
  ok(!!T._ring, 'without the stick blinking out from under your thumb');
  T._end(1, 200, 200, 900);
  ok(T.axis === null && T._ring === null, 'lifting puts both away');

  /* --------------------------------------------------------------- the tap */
  // Somebody standing outdoors: a villager behind their own wall is not drawn,
  // and what is not drawn cannot be aimed at. Put on the green rather than
  // trusted to already be there — by this point in the suite the clock has
  // run through thousands of ticks fired by earlier sections, easily enough
  // to reach night, when every villager is home and indoors (see game.js's
  // Autonomy note), which silently broke `g.npcs.find(n => !W.buildingUnder(n))
  // || g.npcs[0]` the way this used to read: no outdoor villager existed, the
  // fallback npc was indoors like everyone else, and every tap on them below
  // failed the same way a tap through a wall correctly should have.
  const npc = g.npcs[0];
  const npcWasAt = { px: npc.px, py: npc.py, tx: npc.tx, ty: npc.ty };
  const spot0 = W.nearestOpen(LG.GREEN.x + (LG.GREEN.w / 2 | 0), LG.GREEN.y + (LG.GREEN.h / 2 | 0));
  npc.px = spot0.x * TILE + TILE / 2; npc.py = spot0.y * TILE + TILE / 2;
  npc.tx = spot0.x; npc.ty = spot0.y;
  ok(!W.buildingUnder(npc), 'the green is outdoors, so the fixture above actually holds');
  const screen = a => ({ x: a.px - g.cam.x, y: a.py - g.cam.y });
  /* Held still for the rest of this test. `_debugTick` below runs the real
     village along with the camera it exists to move, and nobody else's
     position is asserted on — but npc's is, on both sides of every tap. */
  const npcWasFrozen = npc.frozen;
  npc.frozen = true;

  g._debugPlayerAt(npc.px + 20, npc.py);
  g._debugTick(1 / 60);                        // the camera catches up with them
  let p = screen(npc);
  T._begin(2, p.x, p.y, 0); T._end(2, p.x, p.y, 90);
  ok(LG.dialogue.isOpen(), 'a tap on the villager beside you opens the conversation');
  LG.dialogue.close();
  npc.frozen = true;   // close() rightly un-freezes them — hold still again for what follows

  T._begin(3, p.x, p.y, 0); T._move(3, p.x + 60, p.y); T._end(3, p.x + 60, p.y, 90);
  ok(!LG.dialogue.isOpen(), 'but a drag that starts on them walks past them instead');
  ok(T.axis === null, 'and lets go at the end of it');

  T._begin(4, p.x, p.y, 0); T._end(4, p.x, p.y, T.TAP_MS + 200);
  ok(!LG.dialogue.isOpen(), 'a finger left resting on someone is neither one nor the other');

  // Out of arm's reach a tap is a question, not a conversation — and it says so,
  // because a tap that does nothing at all reads as a broken button.
  g._debugPlayerAt(npc.px + TILE * 6, npc.py);
  g._debugTick(1 / 60);
  p = screen(npc);
  T._begin(5, p.x, p.y, 0); T._end(5, p.x, p.y, 90);
  ok(!LG.dialogue.isOpen(), 'tapping someone across the green does not start a conversation');
  g._debugTick(1 / 60);
  const hintText = sandbox.document.getElementById('hint').textContent;
  ok(/Walk over to/.test(hintText),
     'it says to walk over rather than going quiet');
  npc.frozen = npcWasFrozen;
  Object.assign(npc, npcWasAt);

  /* --------------------------------------------------- and it actually walks */
  // A stretch of ground with room to walk four tiles east, found rather than
  // assumed: the map is generated and no fixed spot is clear in every village.
  let spot = null;
  for (let ty = 1; ty < W.H - 2 && !spot; ty++) {
    for (let tx = 1; tx < W.W - 5 && !spot; tx++) {
      let clear = true;
      for (let i = 0; i <= 4 && clear; i++)
        if (W.isSolid(tx + i, ty) || W.isSolid(tx + i, ty + 1)) clear = false;
      if (clear) spot = { x: tx * TILE + 16, y: ty * TILE + 16 };
    }
  }
  ok(!!spot, 'the village has somewhere to walk');
  if (spot) {
    const run = lean => {
      g._debugPlayerAt(spot.x, spot.y);
      const from = g.player.px;
      T._begin(8, 100, 100, 0);
      T._move(8, 100 + T.DEAD + (T.RANGE - T.DEAD) * lean, 100);
      for (let i = 0; i < 30; i++) g._debugTick(1 / 60);   // half a second of it
      T._end(8, 100, 100, 9e5);
      return g.player.px - from;
    };
    const hard = run(1), gentle = run(0.25);
    ok(hard > 10, 'a thumb held out to the rim walks you east (' + hard.toFixed(1) + 'px)');
    ok(gentle > 0 && gentle < hard,
       'and a gentler lean walks you slower, not just in a different direction (' +
       gentle.toFixed(1) + 'px)');
  }
}

/* How much screen there is decides what the dialogue card can afford, and it is
   a fact about the screen rather than about what has focus. That distinction is
   the whole point of this section: the first version of this keyed the card's
   layout off the input having focus, and tapping "Say it" takes focus off the
   box while the keyboard stays up — so the card sprang back to its roomy layout
   in a space that had not grown, and pushed the composer it had just used off
   the bottom of the screen.

   The layout itself is CSS and there is no layout engine here to check it in.
   What is checked here is the measurement the CSS hangs off: that the classes
   go on and come off at the right heights, and that they never depend on focus,
   which this file cannot give or take anyway. */
async function roomForTheComposer() {
  section('how much room there is for the composer');
  const g = LG.game, body = sandbox.document.body;
  const at = h => { sandbox.innerHeight = h; g._debugViewport();
                    return { cramped: body.classList.contains('cramped'),
                             tight: body.classList.contains('tight') }; };

  const roomy = at(900);
  ok(!roomy.cramped && !roomy.tight, 'a desktop window is neither');
  const phone = at(839);
  ok(!phone.cramped && !phone.tight, 'nor is a phone with no keyboard up');

  const kbd = at(380);
  ok(kbd.cramped, 'a phone with the keyboard up is cramped');
  ok(!kbd.tight, 'but not so cramped that the phrases have to go');

  const sideways = at(212);
  ok(sideways.cramped && sideways.tight, 'a phone on its side with the keyboard up is both');

  /* Coming back is the half that broke: the keyboard goes down and the card has
     to be allowed its full layout again. A classList.toggle that ignores the
     second argument passes the way down and fails here. */
  const back = at(839);
  ok(!back.cramped && !back.tight, 'and the keyboard going away gives it all back');

  /* The flick keyboard. Japanese input puts a strip of suggestions above the
     keys the moment there is a word to choose and takes it away again the
     moment you commit one, so the visible window gains and loses a row of it
     every few characters — and a card pinned to the bottom of that window hops
     up and down under the sentence you are reading back. What is checked here
     is that the height the overlays are laid out to follows the window down
     and not straight back up, and that a keyboard actually going away is still
     believed at once. */
  section('a keyboard that changes height as you type');
  const doc = sandbox.document;
  const vvh = () => parseFloat(doc.documentElement.style['--vv-h']);
  let blurred = false;
  const box = { tagName: 'TEXTAREA', blur() { blurred = true; } };

  at(839);                                    // a phone, no keyboard, nothing focused
  LG.touch._setMode(true);
  doc.activeElement = box;

  at(380);
  ok(vvh() === 380, 'the keyboard comes up and the card takes the room that is left');
  at(428);                                    // the suggestion strip goes away
  ok(vvh() === 380, 'a suggestion strip going away does not move the card');
  ok(!blurred, 'nor does it count as the keyboard going down');
  at(380);                                    // and comes back for the next word
  ok(vvh() === 380, 'and it comes back to a card that never left');
  at(366);                                    // a taller keyboard: still followed down
  ok(vvh() === 366, 'but a keyboard that grows is followed down at once');

  at(839);
  ok(vvh() === 839, 'and the keyboard going away gives the room straight back');
  ok(blurred, 'which is also what finally lets the box go');

  /* The hold is only ever allowed to say "still typing". With nothing focused
     the real measurement is used, so letting go of the box while the keys are
     still up can never lay the card out in a space it does not have. */
  doc.activeElement = null;
  at(380);
  at(428);
  ok(vvh() === 428, 'with nothing focused the card is laid out to what is really there');

  /* The keyboard's own opening animation is not one clean reading either:
     visualViewport is documented to report it dipping past its resting
     height before climbing back to where it actually settles. A card that
     latched onto the dip on the way down used to stay there, a keystroke's
     worth of paper short of the room the keyboard had actually left it, for
     the rest of the conversation. What is checked here is that a recovery
     which is not the keyboard fully going away still gets there — just not
     at once, and never while a fresh dip keeps arriving to cancel the wait. */
  section('a keyboard that overshoots on the way up');
  const box2 = { tagName: 'TEXTAREA', blur() {} };
  doc.activeElement = box2;

  at(839);                                    // starting fresh, no keyboard
  at(700); at(560); at(460); at(400);         // the animation, dipping past rest
  ok(vvh() === 400, 'the card follows the dip down like anything else');
  at(415);                                    // climbing back towards where it rests
  ok(vvh() === 400, 'a recovery is not believed at once, in case it dips again');
  at(428);                                    // settles here and stays
  ok(vvh() === 400, 'nor is a second, taller recovery, for the same reason');
  await new Promise(r => setTimeout(r, 260));
  ok(vvh() === 428, 'but once it has held still a beat, the room is given back');

  at(380);                                    // the ordinary suggestion-strip bounce
  ok(vvh() === 380, 'a fresh dip afterwards is still followed down at once');
  at(428);
  await new Promise(r => setTimeout(r, 100));
  at(380);                                    // the next word's dip, inside the wait
  await new Promise(r => setTimeout(r, 260));
  ok(vvh() === 380, 'typing through the wait never lets a recovery through');

  LG.touch._setMode(false);
  at(900);                                    // leave it as it was found
}

/* The canvas is fixed to the page and fills it, and on a phone the page is not
   the glass: a browser toolbar leaves the window onto the page scrolled some
   way down it, and viewport-fit=cover paints the bottom of the canvas
   underneath Android's navigation buttons. The camera used to centre the
   player in the canvas, so the bottom row of the village was behind the
   buttons and the top row behind the toolbar, with no way to walk them out.
   What is checked here is the framing that replaced it: the player is centred
   in the part of the canvas somebody can actually see, and the edges of the
   world stop against that band rather than against the canvas. */
function whatYouCanSee() {
  section('framing the village in the part of the screen you can see');
  const g = LG.game, W = LG.world, TILE = W.TILE;
  const vw = 900, vh = 640;                     // what the fake canvas measures
  const bottomEdge = W.H * TILE, rightEdge = W.W * TILE;
  /* Far enough into the corner that the camera has stopped and the player is
     walking the last stretch on their own — which is the case that broke. */
  const atCorner = () => { g._debugPlayerAt(rightEdge - TILE, bottomEdge - TILE);
                           g._debugTick(1 / 60); };

  const plain = g._debugSeen();
  ok(plain.top === 0 && plain.bottom === vh && plain.left === 0 && plain.right === vw,
     'a desktop window can see the whole canvas');
  atCorner();
  ok(g.cam.y === bottomEdge - vh, 'and the camera stops at the edge of the world');

  /* A phone with three navigation buttons along the bottom. env() is a CSS
     value, so the game reads it off a box in the page whose padding is the
     four insets — which is all the fake browser has to answer here. */
  const NAV = 48;
  sandbox.getComputedStyle = () => ({
    paddingTop: '0px', paddingRight: '0px',
    paddingBottom: NAV + 'px', paddingLeft: '0px'
  });
  g._debugViewport();
  ok(g._debugSeen().bottom === vh - NAV, 'the buttons take the bottom of the canvas');
  atCorner();
  ok(g.cam.y === bottomEdge - (vh - NAV),
     'so the camera stops that much earlier and the last row of the village clears them');
  const y = (bottomEdge - TILE) - g.cam.y;
  ok(y > 0 && y <= vh - NAV, 'the player standing there is above the buttons, not behind them');

  /* And the other end: the window onto the page scrolled down, which is where
     a conversation leaves it once the keyboard has been and gone. */
  sandbox.visualViewport = { width: 412, height: 540, offsetTop: 100, scale: 1,
                             addEventListener() {} };
  g._debugViewport();
  ok(g._debugSeen().top === 100, 'a window scrolled down the page hides the top of the canvas');
  g._debugPlayerAt(TILE, TILE);
  g._debugTick(1 / 60);
  ok(g.cam.y === -100,
     'and the camera stops that much earlier at the top, so the first row is on screen');

  /* A keyboard coming up is not the village being reframed: the band stays
     where it was, and the dialogue card is what deals with the keys. */
  const settled = JSON.stringify(g._debugSeen());
  sandbox.visualViewport.height = 240;
  g._debugViewport();
  ok(JSON.stringify(g._debugSeen()) === settled,
     'a keyboard over the page leaves the framing alone');

  delete sandbox.visualViewport;
  sandbox.getComputedStyle = () => ({ paddingTop: '0px', paddingRight: '0px',
                                      paddingBottom: '0px', paddingLeft: '0px' });
  g._debugViewport();
  const back = g._debugSeen();
  ok(back.top === 0 && back.bottom === vh, 'and it all comes back');
}

section('the same seed builds the same village, twice');
{
  const seed = 'smoke-test-reproducibility';
  const a = LG.chain.generate({ level: 'intermediate', seed });
  const b = LG.chain.generate({ level: 'intermediate', seed });
  ok(a.seed === seed && b.seed === seed, 'both plans kept the seed they were asked for');
  ok(a.terminal.item === b.terminal.item && a.terminal.placeId === b.terminal.placeId,
     'the same errand ends the same way both times');
  ok(a.links.length === b.links.length &&
     a.links.every((lk, i) => lk.npcId === b.links[i].npcId && lk.wants === b.links[i].wants
                            && lk.gives === b.links[i].gives),
     'and every link in the chain is identical, villager for villager, item for item');
  ok(Object.keys(a.facts).length === Object.keys(b.facts).length,
     'the same number of facts were dealt out');

  const c = LG.chain.generate({ level: 'intermediate', seed: seed + '-different' });
  ok(c.terminal.item !== a.terminal.item || c.links.length !== a.links.length ||
     c.links.some((lk, i) => !a.links[i] || lk.npcId !== a.links[i].npcId),
     'a different seed is, in practice, a different village');
}

/* This is the last section that touches LG.game.newVillage — deliberately
   placed after everything else, since replacing the village mid-suite is
   exactly the stale-reference trap this file's own comments warn about
   elsewhere (see the top-level `npcs`/`plan` this file no longer reads by
   this point). beliefsRevised and villagersTalking, below, read their own
   npc off the *original* village captured when this file first read
   LG.game.npcs — not off LG.game.npcs itself — which is precisely what
   keeps them safe to run after this. */
section('the village seed: read off the current plan, and re-enterable to reproduce it');
{
  LG.game.openSettings(false);
  ok(sandbox.document.getElementById('setSeedShow').value === LG.game.plan.seed,
     "the settings panel shows this village's actual seed");

  // No navigator at all in this sandbox — the same "not here" shape as the
  // SpeechRecognition check earlier — so the copy button has nothing to
  // copy with and must not throw, or claim it copied something it didn't.
  sandbox.document.getElementById('setSeedCopy').onclick();
  ok(sandbox.document.getElementById('setSeedCopied').hidden === true,
     'and says nothing happened, rather than claiming a copy with nowhere to put it');

  const seed = LG.chain.makeSeed();
  sandbox.document.getElementById('setSeedInput').value = seed;
  sandbox.document.getElementById('setSeedGo').onclick();
  // Usually exactly the typed seed — but LG.chain.generate() reuses it
  // verbatim only on a first roll that validates; a seed whose first roll
  // comes back degenerate is retried under seed+"~1", seed+"~2", and so on
  // (see chain.js's own generate()), so that is a real outcome here too,
  // not just a typed one.
  ok(LG.game.plan.seed === seed || LG.game.plan.seed.indexOf(seed + '~') === 0,
     'typing a seed and pressing Go starts exactly that village');
  ok(!sandbox.document.getElementById('settings').classList.contains('open'),
     'and the settings panel closes behind it');

  // Pressing Go with nothing typed must not rebuild the village under you.
  const before = LG.game.plan.seed;
  sandbox.document.getElementById('setSeedInput').value = '   ';
  sandbox.document.getElementById('setSeedGo').onclick();
  ok(LG.game.plan.seed === before, 'an empty seed is not a request for a new village');
}

section('the ending screen counts the errand, not just announces it');
{
  const g = LG.game;
  g.newVillage('ending-stats-village', true);
  const stats = () => g._debugEndingStats();

  g.state.words.length = 0;
  g.npcs.forEach(n => { n.metPlayer = false; });
  g.state.arrivedDay = LG.time.day;
  ok(stats() === '1 day, 0 of ' + g.npcs.length + ' villagers spoken to, 0 words learned along the way.',
     'nothing yet, on the day you arrived, reads as singular and zero rather than "0 days"');

  g.learnWord('shiny_rock', 'test fixture');
  g.npcs[0].metPlayer = true;
  ok(stats() === '1 day, 1 of ' + g.npcs.length + ' villagers spoken to, 1 word learned along the way.',
     'one of each stays singular');

  g.npcs[1].metPlayer = true;
  g.learnWord('bread', 'test fixture');
  LG.time.start(LG.time.day + 4, LG.time.frac);
  ok(stats() === '5 days, 2 of ' + g.npcs.length + ' villagers spoken to, 2 words learned along the way.',
     'and the day count is inclusive — arriving and leaving on the same day is one day, not zero');

  // A save from before endingStats existed has no `time.arrived` to read —
  // restore() falls back to the day the save was made on, not day 0, so an
  // old save's own ending screen undercounts to "1 day" rather than
  // overcounting into the hundreds. See save.js's restore().
  const shot = LG.save.snapshot();
  delete shot.time.arrived;
  const why = LG.save.restore(shot);
  ok(why === null && LG.game.state.arrivedDay === shot.time.day,
     "a save with no arrival day of its own falls back to the day it was saved on, not 0");
}

beliefsRevised().then(villagersTalking);
