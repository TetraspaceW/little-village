/* view.js — the one assembly of "who this villager is and what they know"
   for every prompt: talking to the player (dialogue.js), to another
   villager (LG.llm.converse), and deciding where to go (LG.llm.intent).
   Separate copies drifted (see DESIGN.md), so each caller renders the parts
   it needs from `of`, and how much of each it gets is set in TRIM.

   A villager's stock is a prior, not an inventory: a baker has whatever a
   baker would, via def.sells / def.sellsTags. */
window.LG = window.LG || {};

LG.view = (function () {
  const W = LG.world;

  /* How much of `knows`/`memory`/`folk` each caller gets; 0 is all. The
     player-facing prompt gets every fact, since it may cite any by tag; the
     helper calls make one small decision and get a trimmed list. */
  const TRIM = {
    all:    { knows: 0, memory: 0,  folk: 0 },
    player: { knows: 0, memory: 12, folk: 0 },
    intent: { knows: 6, memory: 8,  folk: 6 },
    chat:   { knows: 5, memory: 4,  folk: 0 },
    board:  { knows: 6, memory: 6,  folk: 0 }
  };
  const TILL = 8;                 // how many recent till entries to include
  const SIGHT = 26;               // tiles — range for folk() to consider someone visible

  /* Facts are read oldest-first (the errand played out in that order);
     memory is read newest-first (recent events are most salient). */
  function firstOf(list, n) { return n ? list.slice(0, n) : list.slice(); }
  function lastOf(list, n) { return n ? list.slice(-n) : list.slice(); }

  function plan() { return LG.game && LG.game.plan; }
  function roleOf(n) {
    const p = plan();
    return (p && p.roles[n.def.id]) || { goal: '', trade: null, link: -1 };
  }

  /* ------------------------------------------------------------ where they are */
  /* Location as a phrase for the prompt (e.g. "inside the Bakery"), not
     tile coordinates. */
  function where(n) {
    const b = W.buildingUnder(n);
    if (b) return 'inside the ' + b.label;
    if (W.inRect(n, LG.GREEN)) return 'on the village green';
    if (n.def && W.inRect(n, n.def.home)) return 'at home';
    return 'out in the village';
  }

  // Trade is open anywhere; only night shuts it.
  function open() { return !LG.time.isNight(); }

  /* Whether they're physically at their workplace — affects flavor and
     stock availability. */
  function atCounter(n) { return W.inRect(n, n.work); }

  function near(a, b, tiles) {
    return Math.hypot(a.px - b.px, a.py - b.py) < tiles * W.TILE;
  }

  /* ------------------------------------------------------------ what they know */
  /* Opinions are stored in the third person ("Mira thinks Wren talks too
     much"); handed back to Mira they read "You think…", or she'd read her
     own opinion as something she was told. */
  function ownVoice(n, text) {
    const head = n.def.name + ' thinks ';
    return (text && text.indexOf(head) === 0)
      ? 'You think ' + text.slice(head.length)
      : text;
  }

  /* Each fact has `text`, as this villager holds it (ownVoice, or their own
     revised wording in `note`), and `plain`, as written, for anything
     reasoning about them from outside. `id` never changes; the notebook
     is keyed on it. */
  function knows(n) {
    const p = plan();
    if (!p) return [];
    const when = n.factAt || {}, mine = n.factNote || {};
    return (n.facts || [])
      .map(id => {
        const f = p.facts[id];
        if (!f) return null;
        const src = when[id] || {};
        return { id: id, text: ownVoice(n, mine[id] || f.text), plain: f.text,
                 revised: !!mine[id], at: src.at || null, from: src.from || null };
      })
      .filter(Boolean);
  }

  // Who they can see, and where, so "Sanna has the cards" can be acted on.
  function folk(n) {
    const all = (LG.game && LG.game.npcs) || [];
    return all.filter(o => o !== n && near(n, o, SIGHT))
              .map(o => ({ id: o.def.id, name: o.def.name, job: o.def.job, where: where(o) }));
  }

  /* Everyone else in the village by name, job and character: what years of
     living alongside them would tell anyone. Where they are and what
     they're doing today stays with `folk` and what they've been told. */
  function roster(n) {
    const all = (LG.game && LG.game.npcs) || [];
    return all.filter(o => o !== n)
      .map(o => ({ id: o.def.id, name: o.def.name, job: o.def.job, persona: o.def.persona }));
  }

  /* --------------------------------------------------------- what they hold */
  function itemised(counts, extra) {
    const c = counts || {};
    return Object.keys(c)
      .filter(k => LG.ITEMS[k] && (extra ? extra(c[k]) : c[k] > 0))
      .map(k => Object.assign({ id: k, en: LG.ITEMS[k].en, full: LG.ITEMS[k].full },
                              typeof c[k] === 'number' ? { n: c[k] } : c[k]));
  }
  function stock(n) { return itemised(n.stock); }
  function sold(n)  { return itemised(n.sold, v => v && v.n > 0); }

  // The animal following the player, if any: anyone talking to the player can see it.
  function companion() {
    const beast = LG.game && LG.game.beast;
    return (beast && beast.following) ? { name: beast.name, item: beast.item } : null;
  }

  // Why they're here, and who they came after, if anyone (cleared by `arrived`).
  function errand(n) {
    return { why: n.why || '', after: n.wentAfter || null };
  }

  // Once they've arrived and had the conversation, so "I came looking for you" isn't said twice.
  function arrived(n) { n.wentAfter = null; }

  /* One entry with its date and source in front, so two about the same
     thing can be told apart. Which is current is the model's call, not
     this code's. `held` puts facts and memories in one list: the game
     doesn't treat them differently, and neither should the villager. */
  function sourced(e) {
    const when = e.at ? (e.from ? e.at + ', from ' + e.from : e.at)
                      : (e.from ? 'from ' + e.from : 'a while now');
    return '(' + when + ') ' + (e.id ? '[' + e.id + '] ' : '') + (e.text || '');
  }
  function heldEntries(v) { return (v.knows || []).concat(v.memory || []); }
  function held(v) { return heldEntries(v).map(sourced); }

  /* ---------------------------------------------------------------- assembly */
  function of(n, kind) {
    const t = TRIM[kind] || TRIM.all;
    const r = roleOf(n);
    const d = n.def;
    return {
      id: d.id, name: d.name, job: d.job, persona: d.persona,
      // Their errand's goal until their trade is done, then their ordinary work (r.settled).
      goal: (n.tradeDone && r.settled) ? r.settled : (r.goal || ''),
      knows: firstOf(knows(n), t.knows),
      memory: lastOf(n.memory || [], t.memory),
      here: where(n),
      when: LG.time.describe(),
      folk: firstOf(folk(n), t.folk),
      roster: roster(n),
      errand: errand(n),
      companion: companion(),
      /* `sells` is their stock-in-trade and `sellsTags` their line of
         business; `stock` is what they've actually bought off the traveller
         and can't claim not to have. */
      trade: {
        open: open(),
        atCounter: atCounter(n),
        sells: d.sells || [],
        sellsTags: d.sellsTags || [],
        buys: d.buys || [],
        buysTags: d.buysTags || [],
        stock: stock(n),
        sold: sold(n),
        till: lastOf(n.till || [], TILL),
        deal: n.tradeDone ? null : (r.trade || null),
        done: n.tradeDone ? (r.trade || null) : null
      }
    };
  }

  return { of, where, open, atCounter, arrived, knows, folk, roster, ownVoice, near, sourced, held, heldEntries,
           companion, TRIM, SIGHT };
})();
