/* view.js — one villager, as they see themselves.

   Three separate things ask a model to be a villager: talking to the player
   (dialogue.js), talking to another villager (LG.llm.converse), and deciding
   where to stand (LG.llm.intent). Each of them used to assemble "who this is and
   what they know" from scratch, and the three copies drifted apart — different
   slices of the same memory, different amounts of the same knowledge, and an
   opinion-of-oneself repair that only ever landed in one of them, so Mira read
   her own opinion of Wren in the third person whenever the player was in front
   of her.

   This is the single assembly. It answers, for one villager, everything a model
   might want in order to be them; each caller renders the parts it needs. Where
   they deliberately want different amounts, the numbers sit together in TRIM
   below, so the next divergence between them is a decision rather than an
   accident.

   What it is not: an inventory. A villager's stock is a prior, not a manifest —
   the baker has whatever a baker would have, and if the traveller asks for a
   pain au chocolat then of course she has one. That looseness lives in
   def.sells / def.sellsTags and is passed through untouched. */
window.LG = window.LG || {};

LG.view = (function () {
  const W = LG.world;

  /* The deliberate differences. Talking to the player lists every fact, because
     the villager has to be able to name one by its tag afterwards; the two
     helper-model calls get a trim, because they are making one small decision
     and a long list crowds it out. A zero means "all of them". */
  const TRIM = {
    all:    { knows: 0, memory: 0,  folk: 0 },
    player: { knows: 0, memory: 12, folk: 0 },
    intent: { knows: 6, memory: 8,  folk: 6 },
    chat:   { knows: 5, memory: 4,  folk: 0 }
  };
  const TILL = 8;                 // how far back the ledger is worth reading
  const SIGHT = 26;               // tiles — far enough down the street to see who that is

  /* Facts are read oldest-first (the errand was dealt in order); memory is read
     newest-first (what they picked up lately is what is on their mind). */
  function firstOf(list, n) { return n ? list.slice(0, n) : list.slice(); }
  function lastOf(list, n) { return n ? list.slice(-n) : list.slice(); }

  function plan() { return LG.game && LG.game.plan; }
  function roleOf(n) {
    const p = plan();
    return (p && p.roles[n.def.id]) || { goal: '', trade: null, link: -1 };
  }

  /* ------------------------------------------------------------ where they are */
  /* In words, the way they would say it — this is what goes into a prompt, so
     "inside the Bakery" rather than a pair of tile coordinates. */
  function where(n) {
    const b = W.buildingUnder(n);
    if (b) return 'inside the ' + b.label;
    if (W.inRect(n, LG.GREEN)) return 'on the village green';
    if (n.def && W.inRect(n, n.def.home)) return 'at home';
    return 'out in the village';
  }

  /* Somebody's trade goes with them: the baker will sell you bread on the street
     as readily as across her counter. Only the small hours close the shop —
     which makes this a fact about the clock and not about the villager, so it
     takes no argument. */
  function open() { return !LG.time.isNight(); }

  /* Whether they are physically at their workplace — flavour, and a fuller stock. */
  function atCounter(n) { return W.inRect(n, n.work); }

  function near(a, b, tiles) {
    return Math.hypot(a.px - b.px, a.py - b.py) < tiles * W.TILE;
  }

  /* ------------------------------------------------------------ what they know */
  /* An opinion is stored as "Mira thinks Wren talks too much", because that is
     how it reads to everybody else. Handed back to Mira it has to become "You
     think Wren talks too much" — otherwise she reads about herself in the third
     person and repeats her own view as something she heard somewhere. */
  function ownVoice(n, text) {
    const head = n.def.name + ' thinks ';
    return (text && text.indexOf(head) === 0)
      ? 'You think ' + text.slice(head.length)
      : text;
  }

  /* `text` is the fact as this villager would say it; `plain` is the fact as it
     is written down. Both are needed: being the villager wants the first, and
     anyone reasoning *about* the villager from outside — the reader that works
     out what two of them said to each other — wants the second, or it is handed
     a list of "You think..." with no idea whose "you" that is. */
  /* A fact carries when they came by it and who from, the same as anything else
     they have picked up — and `note` is their own version of it, if they have
     since revised it. The id never moves, because the notebook is built on ids;
     what changes is the sentence they would actually say. */
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

  /* Who they can see, and where those people are. Knowing that Sanna has the
     cards is worth nothing without a way to say "go and find Sanna". */
  function folk(n) {
    const all = (LG.game && LG.game.npcs) || [];
    return all.filter(o => o !== n && near(n, o, SIGHT))
              .map(o => ({ id: o.def.id, name: o.def.name, job: o.def.job, where: where(o) }));
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

  /* Why they are standing here, and whether they came looking for someone.

     `after` used to be set when they set off and never unset, so a villager who
     once walked over to Mira greeted her with "I came looking for you" every
     time the two of them met for the rest of the day. It is discharged now by
     whoever reads it — see LG.view.arrived. */
  function errand(n) {
    return { why: n.why || '', after: n.wentAfter || null };
  }

  /* They got where they were going and had the conversation they came for. What
     brought them here stops being news. */
  function arrived(n) { n.wentAfter = null; }

  /* When they came by it and who from, in front of the thing itself, so two
     entries can be told apart at a glance. Nothing here says which to believe: a
     villager holding a date on each of two claims is a person in the ordinary
     situation of having heard two things, and they are a language model playing
     a person. What they make of it is theirs.

     `held` is the whole of it, facts and picked-up alike, in one list — because
     they are the same kind of object and dressing one of them as knowledge and
     the other as gossip is the scaffold telling the villager something that is
     not true. */
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
      /* A finished errand has to stop being what they are about. `deal` and
         `done` below already turned over on tradeDone and `goal` did not, so a
         beekeeper who had his pig back and had handed the teapot over went on
         being told he was worried about his pig and would give a teapot to
         whoever found it — with the memory of getting the pig back sitting a few
         lines underneath it. He offered the reward again, in public, and then
         asked where his pig was. The deal block only ever reached the
         player-facing prompt, so the two calls that made him walk about and talk
         to people were the two that never heard the errand had ended. */
      goal: (n.tradeDone && r.settled) ? r.settled : (r.goal || ''),
      knows: firstOf(knows(n), t.knows),
      memory: lastOf(n.memory || [], t.memory),
      here: where(n),
      when: LG.time.describe(),
      folk: firstOf(folk(n), t.folk),
      errand: errand(n),
      /* What a villager may sell is a prior, not a list: `sells` is what they
         plainly keep and `sellsTags` is the run of the trade. `stock` is the
         separate, harder fact of what they are actually holding because they
         took it off the traveller — the thing they used to deny having. */
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

  return { of, where, open, atCounter, arrived, knows, folk, ownVoice, near, sourced, held, heldEntries,
           TRIM, SIGHT };
})();
