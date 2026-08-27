/* view.js — builds the "who this villager is and what they know" data
   passed into LLM prompts, for one villager at a time.

   Three call sites need this: talking to the player (dialogue.js), talking
   to another villager (LG.llm.converse), and deciding where to stand
   (LG.llm.intent). They used to each assemble it independently, which let
   the copies drift apart — different slices of memory, different amounts
   of knowledge, and a self-reference fix (see `ownVoice`) that only got
   applied in one of the three, so a villager could read their own opinion
   of someone else in the third person when talking to the player.

   This module is the single shared assembly (`of`). Each caller renders
   only the parts it needs; where callers deliberately want different
   amounts of data, that's controlled centrally via TRIM below, so any
   future difference between them is a deliberate choice, not drift.

   Not included: an inventory system. A villager's stock is a prior, not a
   fixed list — a baker has whatever a baker would plausibly have, so if
   asked for a pastry she has one. That's handled via def.sells /
   def.sellsTags and passed through as-is. */
window.LG = window.LG || {};

LG.view = (function () {
  const W = LG.world;

  /* Per-caller limits on how much of `knows`/`memory`/`folk` to include.
     0 means "all of them". Talking to the player gets the full fact list
     (they need to be able to reference any fact by its tag); the helper
     calls (intent, chat, board) get a trimmed list because they're making
     one small decision and a long list would crowd out the prompt. */
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

  /* Villagers can trade wherever they are, not just at their shop — only
     nighttime closes trading, so this depends only on the clock, not on
     which villager is asking. */
  function open() { return !LG.time.isNight(); }

  /* Whether they're physically at their workplace — affects flavor and
     stock availability. */
  function atCounter(n) { return W.inRect(n, n.work); }

  function near(a, b, tiles) {
    return Math.hypot(a.px - b.px, a.py - b.py) < tiles * W.TILE;
  }

  /* ------------------------------------------------------------ what they know */
  /* Opinions are stored third-person ("Mira thinks Wren talks too much")
     since that's how they read to everyone else. When handing facts back
     to Mira herself, rewrite to second person ("You think Wren talks too
     much") — otherwise she'd read her own opinion back as something she
     was told by someone else. */
  function ownVoice(n, text) {
    const head = n.def.name + ' thinks ';
    return (text && text.indexOf(head) === 0)
      ? 'You think ' + text.slice(head.length)
      : text;
  }

  /* Each returned fact has both `text` (as this villager would say it,
     post-ownVoice) and `plain` (the fact as written, third-person). Both
     are needed: prompting-as-the-villager needs `text`; anything reasoning
     about the villager from the outside (e.g. summarizing a conversation
     between two villagers) needs `plain`, since a list of "You think..."
     strings is ambiguous about whose "you" it is.
     `id` never changes (the notebook is keyed on it); `note`, if set, is
     the villager's own revised phrasing of the fact. */
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

  /* People currently within SIGHT range and where they are — needed so a
     villager can act on a fact like "Sanna has the cards" by saying where
     to find Sanna. */
  function folk(n) {
    const all = (LG.game && LG.game.npcs) || [];
    return all.filter(o => o !== n && near(n, o, SIGHT))
              .map(o => ({ id: o.def.id, name: o.def.name, job: o.def.job, where: where(o) }));
  }

  /* Everyone else in the village, by name and job — unlike a chain fact,
     or a name the *player* has to be told directly (see `nameKnown`), a
     villager doesn't need this told to them: they've lived alongside these
     people for years and would obviously know who the blacksmith is.
     Deliberately excludes current location — that's `folk`, kept separate
     because a villager can know who someone is without knowing where they
     currently are. */
  function roster(n) {
    const all = (LG.game && LG.game.npcs) || [];
    return all.filter(o => o !== n).map(o => ({ id: o.def.id, name: o.def.name, job: o.def.job }));
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

  /* Why this villager is standing here, and who (if anyone) they walked
     over to find.

     `after` (n.wentAfter) must be cleared once read (see `arrived` below).
     It used to be set when the villager set off and never cleared, so a
     villager who'd once walked over to talk to Mira would greet her with
     "I came looking for you" on every subsequent meeting that day. */
  function errand(n) {
    return { why: n.why || '', after: n.wentAfter || null };
  }

  /* Call once the villager has reached their destination and had the
     conversation — clears wentAfter so it isn't repeated on future
     encounters. */
  function arrived(n) { n.wentAfter = null; }

  /* Formats one entry with its date/source prefix, so two entries about
     the same thing can be told apart at a glance. Doesn't resolve
     conflicting entries — a villager holding two dated, differently
     sourced claims is just someone who's heard two things, and it's the
     model's job (playing that person) to decide what to make of it, not
     this code's.

     `held` merges facts and picked-up memory into one list — they're
     structurally the same kind of entry, and presenting one as "knowledge"
     and the other as "gossip" would be a distinction the game doesn't
     actually track. */
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
      /* Must switch to r.settled once the trade is done — `trade.deal`/
         `trade.done` below already did (keyed on n.tradeDone), but `goal`
         didn't used to, so a villager whose trade had completed kept being
         prompted with their original goal (e.g. "worried about his pig,
         offering a reward") even though their own memory already recorded
         the pig being returned. Only dialogue.js read `goal`, so the intent
         and chat calls — which decide where they walk and what they say —
         never learned the errand was over. */
      goal: (n.tradeDone && r.settled) ? r.settled : (r.goal || ''),
      knows: firstOf(knows(n), t.knows),
      memory: lastOf(n.memory || [], t.memory),
      here: where(n),
      when: LG.time.describe(),
      folk: firstOf(folk(n), t.folk),
      roster: roster(n),
      errand: errand(n),
      /* What a villager may sell is loose, not a fixed inventory: `sells`
         is their obvious stock-in-trade and `sellsTags` broadens that to
         their whole line of business. `stock`, in contrast, is the
         concrete list of items they've actually acquired from the
         traveller — items they can't plausibly claim not to have. */
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
           TRIM, SIGHT };
})();
