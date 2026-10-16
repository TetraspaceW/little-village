/* mint.js — items the game didn't ship with, made when a villager sells one.

   Stock is a prior, not a manifest (DESIGN.md): a baker plausibly has a
   pain au chocolat whether or not LG.ITEMS lists one. When the traveller
   asks for something like that and the villager agrees to sell it, their
   reply names a tag the game has never seen. Without this, commerce
   dropped the unknown tag and the sale "could not be squared up" while the
   villager went on believing they'd handed it over.

   So an unknown tag in a sale is first matched against what the game
   already has, and failing that the helper model describes the thing
   (LG.llm.mintItem) and it becomes a real entry in LG.ITEMS — an icon, an
   English name, the village's own name for it, and a usual price. From
   then on it's an ordinary item: it sits in the traveller's pockets, can
   be held out, refunded, and resold, eaten, drunk, worn, lit or played if
   it's that kind of thing, and every prompt names it the way it names anything else.

   What a minted item deliberately is not:
   - It has no tags, so the errand generator (which picks by tag) can never
     choose one; a seed builds the same village whatever has been minted.
   - Only the villagers who minted it sell it. Another shop asking the same
     tag gets the same item, and becomes a seller of it too.
   - It belongs to one village: `forget` drops them all when a new village
     starts, and a save carries its own (`saved` / `restore`). */
window.LG = window.LG || {};

LG.mint = (function () {
  const made = {};             // id -> the item, as registered in LG.ITEMS
  const pending = {};          // raw tag -> promise, so one tag is minted once

  /* The tag a piece of a reply's `item` field comes down to, the same way
     trade.commerce reads it. Empty for a tag in another script. */
  function slug(raw) {
    return String(raw || '').trim().toLowerCase()
      .replace(/[\s-]+/g, '_').replace(/[^\w]/g, '');
  }

  /* An existing item by tag or by its English name, without asking anyone. */
  function known(raw) {
    const t = slug(raw);
    if (t && LG.ITEMS[t]) return t;
    const plain = String(raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    return Object.keys(LG.ITEMS).find(k => k !== 'coins' &&
      (LG.ITEMS[k].en.toLowerCase() === plain || (LG.ITEMS[k].full || '').toLowerCase() === plain)) || null;
  }

  /* Splits a reply's `item` field into its pieces, the way commerce does,
     but keeps each piece raw so a tag written in the village's script can
     still be minted. */
  function pieces(itemId) {
    return (Array.isArray(itemId) ? itemId : String(itemId || '').split(/[,;+]|\band\b/))
      .map(x => String(x || '').trim()).filter(Boolean);
  }

  function plainText(s, max) {
    return String(s || '').replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]*>/g, '')
      .replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /* An emoji, or the parcel when the model gave anything else. */
  function iconOf(s) {
    const t = String(s || '').trim();
    return t && !/[A-Za-z0-9]/.test(t) && [...t].length <= 4 ? t : '📦';
  }

  /* Puts an item into LG.ITEMS. `by` lists the villagers who sell it. */
  function register(def) {
    if (!def || !def.id || (LG.ITEMS[def.id] && !LG.ITEMS[def.id].minted)) return null;
    const it = LG.ITEMS[def.id] || { tags: [], minted: true, by: [] };
    it.icon = iconOf(def.icon);
    it.en = def.en; it.full = def.full || def.en;
    it.price = Math.max(1, Math.min(30, Math.round(Number(def.price)) || 2));
    if (def.lang && def.name) it[def.lang] = def.name;
    Object.assign(it, usesOf(def));
    (def.by || []).forEach(id => { if (it.by.indexOf(id) === -1) it.by.push(id); });
    LG.ITEMS[def.id] = made[def.id] = it;
    return def.id;
  }

  /* What the traveller can do with it from their pockets (see `use` on
     LG.ITEMS, and ledger.use): eat, drink, wear, light or play it, which
     slot it's worn in, how far it lights, which General MIDI instrument and
     note it sounds (see LG.sound), what's
     left once it's gone, and its gender where "(worn)" or "(lit)" has to
     agree. Anything that isn't one of the values the shipped items use is
     dropped, so a minted item is never half-usable. */
  function slots() {
    const out = [];
    Object.keys(LG.ITEMS).forEach(k => { const s = LG.ITEMS[k].slot; if (s && out.indexOf(s) === -1) out.push(s); });
    return out;
  }
  function containers() {
    const out = [];
    Object.keys(LG.ITEMS).forEach(k => { const c = LG.ITEMS[k].leaves; if (c && LG.ITEMS[c] && out.indexOf(c) === -1) out.push(c); });
    return out;
  }
  /* Every gender "(worn)" or "(lit)" agrees with in this language. */
  function genders(lang) {
    const out = [];
    [LG.WORN, LG.LIT].forEach(table => {
      const t = table && table[lang];
      if (t && typeof t === 'object') Object.keys(t).forEach(g => { if (out.indexOf(g) === -1) out.push(g); });
    });
    return out;
  }
  function instruments() { return (LG.sound && LG.sound.INSTRUMENTS) || []; }
  function usesOf(def) {
    const out = { use: undefined, slot: undefined, leaves: undefined, g: undefined,
                  glow: undefined, gm: undefined, note: undefined, rung: undefined };
    const use = ['eat', 'drink', 'wear', 'light', 'play'].indexOf(def.use) !== -1 ? def.use : null;
    if (use === 'wear') {
      if (slots().indexOf(def.slot) === -1) return out;      // worn with no slot can't be swapped out
      out.use = use; out.slot = def.slot;
    } else if (use === 'light') {
      const glow = Number(def.glow);
      if (!(glow > 0)) return out;                           // a light that lights nothing
      out.use = use; out.glow = Math.max(1.5, Math.min(6, glow));
    } else if (use === 'play') {
      // An instrument and note the soundfont has, or there's nothing to sound it with.
      if (!LG.sound || !LG.sound.known(def.gm, def.note)) return out;
      out.use = use; out.gm = def.gm; out.note = def.note;
      if (def.rung === true) out.rung = true;
    } else if (use) {
      out.use = use;
      if (containers().indexOf(def.leaves) !== -1) out.leaves = def.leaves;
    }
    const g = {};
    Object.keys(def.g || {}).forEach(l => { if (genders(l).indexOf(def.g[l]) !== -1) g[l] = def.g[l]; });
    if (Object.keys(g).length) out.g = g;
    return out;
  }

  /* A free tag for a new item: its English name, made unique if that
     somehow collides with a shipped item of a different name. */
  function freeId(en) {
    const base = slug(en) || 'thing';
    let id = base, n = 2;
    while (LG.ITEMS[id] && !(LG.ITEMS[id].minted && LG.ITEMS[id].en === en)) id = base + '_' + n++;
    return id;
  }

  /* The item a raw tag from `npc`'s sale stands for, minting it if it's
     new. Resolves to an id, or null when there is nothing to hand over. */
  function resolve(npc, raw, said, translation) {
    const have = known(raw);
    if (have) return Promise.resolve(have);
    const key = slug(raw) || String(raw).trim();
    if (!pending[key]) {
      pending[key] = ask(npc, raw, said, translation).finally(() => { delete pending[key]; });
    }
    return pending[key].then(id => {
      if (id && made[id] && made[id].by.indexOf(npc.id) === -1) made[id].by.push(npc.id);
      return id;
    });
  }

  async function ask(npc, raw, said, translation) {
    const cfg = LG.config.llm();
    if (!cfg || !cfg.apiKey) return null;
    const lang = LG.config.settings.lang;
    // Shipped items first and on their own, so that part of the call is cacheable.
    const entry = k => k + ': ' + LG.ITEMS[k].en;
    const ids = Object.keys(LG.ITEMS).filter(k => k !== 'coins');
    const got = await LG.llm.mintItem(cfg, {
      npcName: npc.def.name, tag: raw, said: said, translation: translation,
      known: ids.filter(k => !made[k]).map(entry), minted: ids.filter(k => made[k]).map(entry),
      langName: LG.LANGUAGES[lang].name,
      slots: slots(), containers: containers(), genders: genders(lang), instruments: instruments(),
      genderNote: lang === 'fr' || lang === 'es' ? 'mp and fp are the plurals' : 'p is plural',
      anchor: 'a loaf of bread costs ' + LG.priceOf('bread') + ' coins'
    });
    if (!got || got.thing === false) return null;
    const same = got.same && known(got.same);
    if (same) return same;
    const en = plainText(got.en, 40).toLowerCase();
    if (!en || !/[a-z]/.test(en)) return null;
    const name = plainText(got.name, 40);
    const id = freeId(en);
    register({ id: id, en: en, full: plainText(got.full, 48) || en, icon: got.icon,
               price: got.price, lang: lang !== 'en' && name ? lang : null, name: name,
               use: got.use, slot: got.slot, leaves: got.leaves,
               glow: got.glow, gm: got.gm, note: got.note, rung: got.rung,
               g: got.g ? { [lang]: got.g } : null, by: [npc.id] });
    LG.ledger.log(LG.ITEMS[id].icon + ' ' + npc.def.name + ' has ' + LG.ITEMS[id].full +
                  ' — something new to the game.');
    return id;
  }

  /* Every piece of a sale resolved to an item id — the list commerce gets.
     Pieces that are nothing to hand over are dropped, as commerce would. */
  async function sale(npc, itemId, said, translation) {
    const ids = await Promise.all(pieces(itemId).map(raw =>
      resolve(npc, raw, said, translation).catch(() => null)));
    return ids.filter(Boolean);
  }

  /* What `npc` asks for a minted item, or 0 if they don't sell it. */
  function priceFor(npc, id) {
    const it = made[id];
    return it && it.by.indexOf(npc.id) !== -1 ? it.price : 0;
  }

  /* A new village: the last one's inventions go with it. */
  function forget() {
    Object.keys(made).forEach(id => { delete LG.ITEMS[id]; delete made[id]; });
  }

  function saved() {
    return Object.keys(made).map(id => {
      const it = made[id], out = { id: id, icon: it.icon, en: it.en, full: it.full,
                                   price: it.price, by: it.by.slice(), names: {},
                                   use: it.use || null, slot: it.slot || null,
                                   leaves: it.leaves || null, g: it.g || null,
                                   glow: it.glow || null, gm: it.gm || null, note: it.note || null,
                                   rung: !!it.rung };
      Object.keys(LG.LANGUAGES).forEach(l => { if (l !== 'en' && it[l]) out.names[l] = it[l]; });
      return out;
    });
  }

  function restore(list) {
    forget();
    (Array.isArray(list) ? list : []).forEach(d => {
      if (!d || typeof d.en !== 'string') return;
      const id = register({ id: slug(d.id), en: d.en, full: d.full, icon: d.icon,
                            price: d.price, use: d.use, slot: d.slot, leaves: d.leaves, g: d.g,
                            glow: d.glow, gm: d.gm, note: d.note, rung: d.rung,
                            by: Array.isArray(d.by) ? d.by : [] });
      if (id) Object.keys(d.names || {}).forEach(l => {
        if (LG.LANGUAGES[l]) LG.ITEMS[id][l] = plainText(d.names[l], 40);
      });
    });
  }

  return { sale, resolve, known, priceFor, forget, saved, restore };
})();
