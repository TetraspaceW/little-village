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
    disabled: false, title: '', className: '', style: {}, dataset: {},
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
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
  /* The one thing about a village that changes while you play it: the thing
     lying at the end of the chain gets collected. */
  if (g.beast) { g.beast.caught = true; g.beast.following = true; }
  else if (g.worldItem) { g.worldItem.taken = true; }

  const before = {
    seed: plan.seed, day: LG.time.day, frac: LG.time.frac,
    weather: LG.time.weather, snow: LG.time.snow,
    inv: JSON.stringify(g.state.inv), notes: JSON.stringify(g.state.notes),
    deeds: JSON.stringify(g.state.deeds),
    px: Math.round(g.player.px * 10) / 10,
    facts: npcs.map(n => n.facts.join(',')).join('|'),
    memory: npcs.map(n => JSON.stringify(n.memory)).join('|'),
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
  ok(JSON.stringify(after.state.deeds) === before.deeds, 'and the same deeds behind you');
  ok(Math.round(after.player.px * 10) / 10 === before.px, 'standing where you were');

  const back = after.npcs;
  ok(back.length === npcs.length, 'the same cast');
  ok(back.map(n => n.facts.join(',')).join('|') === before.facts,
     'everyone knows what they knew');
  ok(back.map(n => JSON.stringify(n.memory)).join('|') === before.memory,
     'and remembers what they had picked up, with when and from whom');
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

  await namesUnknownUntilTold();

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

beliefsRevised().then(villagersTalking);
