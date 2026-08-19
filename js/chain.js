/* chain.js — builds a fresh errand chain for each playthrough.
   A chain is a line of villagers, each holding the thing the one before them
   wants, ending in something lying out in the world:

     client wants G  <-  H1 has G, wants A  <-  H2 has A, wants <world thing>

   Everything the player could learn is a *fact* with an id. Facts are dealt out
   to villagers; the player only ever sees one in their notebook once somebody
   has actually told them. */
window.LG = window.LG || {};

LG.chain = (function () {

  /* --------------------------------------------------- seeded randomness */
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeSeed() {
    const words = ['elder','birch','quiet','amber','hollow','rook','thistle','slate',
                   'willow','ember','marsh','linden','bramble','otter','plum','frost'];
    let s = '';
    for (let i = 0; i < 3; i++) s += (i ? '-' : '') + words[(Math.random() * words.length) | 0];
    return s;
  }

  /* ------------------------------------------------------------- helpers */
  function itemsWith(tag) {
    return Object.keys(LG.ITEMS).filter(k => LG.ITEMS[k].tags.indexOf(tag) !== -1);
  }
  function shuffled(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pick(arr, rnd) { return arr[(rnd() * arr.length) | 0]; }
  const NUMWORD = ['zero','one','two','three','four','five','six','seven'];

  /* ---------------------------------------------------------- the build */
  function attempt(opts) {
    const level = LG.LEVELS[opts.level] || LG.LEVELS.beginner;
    const seed = opts.seed || makeSeed();
    const rnd = mulberry32(hashSeed(seed));
    // Length is variety, not difficulty — the same range at every level. See the
    // note over LG.LEVELS for why it stopped being the difficulty knob.
    const span = LG.DEPTH || [2, 4];
    const rolled = span[0] + ((rnd() * (span[1] - span[0] + 1)) | 0);
    const depth = Math.min(rolled, LG.NPCS.length - 1);

    // Who plays which part. The shopkeeper is kept for a shop link if we have
    // one; the farmer is a natural person to be missing an animal.
    const roster = shuffled(LG.NPCS, rnd);
    const cast = roster.slice(0, depth);
    const bystanders = roster.slice(depth);

    const usedItems = { coins: true };
    function freshItem(tag) {
      let pool = itemsWith(tag).filter(k => !usedItems[k]);
      if (!pool.length) pool = itemsWith('hold').filter(k => !usedItems[k]);
      if (!pool.length) return null;               // caller retries with a new seed
      const chosen = pick(pool, rnd);
      usedItems[chosen] = true;
      return chosen;
    }

    // ---- what each villager in the chain wants, from the client backwards
    const wants = [], counts = [];
    wants[0] = freshItem('hold');                       // the goal item
    if (!wants[0]) return null;
    for (let i = 1; i < depth; i++) {
      const npc = cast[i];
      const last = i === depth - 1;
      if (last) {
        // the end of the line: something out in the world
        wants[i] = rnd() < 0.5 ? freshItem('ground') : freshItem('beast');
      } else if (npc.prefers === 'shop' || rnd() < 0.35) {
        wants[i] = 'coins';
        counts[i] = 2 + ((rnd() * 3) | 0);
      } else {
        wants[i] = freshItem('hold');
      }
      if (!wants[i]) return null;
    }
    const prizePool = itemsWith('prize').filter(k => !usedItems[k]);
    const prize = prizePool.length ? pick(prizePool, rnd) : freshItem('hold');
    if (!prize) return null;
    usedItems[prize] = true;

    // ---- the terminal thing, and where it is
    const terminalItem = wants[depth - 1];
    const isBeast = LG.ITEMS[terminalItem].tags.indexOf('beast') !== -1;
    const place = pick(LG.PLACES.filter(p => isBeast ? p.id !== 'mine' : true), rnd);
    const beastName = isBeast ? pick(LG.BEAST_NAMES, rnd) : null;

    // ---- the links
    const links = [];
    for (let i = 0; i < depth; i++) {
      const npc = cast[i];
      const gives = i === 0 ? prize : wants[i - 1];
      links.push({
        i, npcId: npc.id, npcName: npc.name,
        kind: i === 0 ? 'client' : (wants[i] === 'coins' ? 'sell' : (i === depth - 1 ? 'errand' : 'trade')),
        wants: wants[i], wantsCount: counts[i] || 1,
        gives, givesCount: 1,
        reason: pick(LG.REASONS, rnd)
      });
    }

    /* ------------------------------------------------------------- facts */
    const facts = {};
    let fid = 0;
    function addFact(text, holders, extra) {
      const id = 'f' + (fid++);
      facts[id] = Object.assign({ id, text, holders: {} }, extra || {});
      holders.forEach(n => { facts[id].holders[n] = true; });
      return id;
    }
    const shopkeeper = lk => (LG.NPCS.find(n => n.id === lk.npcId) || {}).prefers === 'shop';
    const named = id => LG.ITEMS[id].en;
    const a = id => LG.ITEMS[id].full || LG.ITEMS[id].en;

    // everyone who could plausibly pass a rumour along
    const all = LG.NPCS.map(n => n.id);
    function others(exclude, n) {
      const pool = shuffled(all.filter(x => exclude.indexOf(x) === -1), rnd);
      return pool.slice(0, n);
    }

    /* Spread scales with the population: a fact known by two of six villagers is
       findable, the same two of twelve is a needle in a haystack. It then tapers
       with depth, so the further down the chain a fact sits the fewer people have
       heard it — a long errand is a deeper secret rather than a wider net. The
       owner always knows their own business, so the chain stays walkable in order
       however far the taper runs down. */
    const base = Math.max(0, Math.round((level.spread || 1) * LG.NPCS.length / 6));
    const taper = level.taper || 0;
    const heardBy = i => Math.max(0, base - taper * i);
    const factOrder = [];

    links.forEach((lk, i) => {
      if (lk.kind === 'sell') {
        factOrder.push(addFact(
          (shopkeeper(lk) ? lk.npcName + ' sells ' + a(lk.gives) + ' in the shop for '
                          : lk.npcName + ' will sell ' + a(lk.gives) + ' for ') +
          NUMWORD[lk.wantsCount] + ' coins.',
          [lk.npcId].concat(others([lk.npcId], heardBy(i))), { link: i, type: 'deal' }));
      } else if (i === 0) {
        factOrder.push(addFact(
          lk.npcName + ' is looking for ' + a(lk.wants) + '.',
          [lk.npcId].concat(others([lk.npcId], heardBy(i))), { link: i, type: 'want' }));
      } else {
        factOrder.push(addFact(
          lk.npcName + ' has ' + a(lk.gives) + '.',
          [lk.npcId].concat(others([lk.npcId], heardBy(i))), { link: i, type: 'has' }));
        factOrder.push(addFact(
          lk.npcName + ' will only part with it for ' +
          (lk.wants === 'coins' ? NUMWORD[lk.wantsCount] + ' coins' : a(lk.wants)) + '.',
          [lk.npcId].concat(others([lk.npcId], heardBy(i))), { link: i, type: 'want' }));
      }
    });

    // where the world thing is — someone has to have seen it
    // someone has to have seen it, however deep it is — nobody owns this one
    const seenBy = others([], Math.max(1, heardBy(depth - 1)));
    const whereText = isBeast
      ? beastName + ' the ' + named(terminalItem) + ' was last seen ' + place.en + '.'
      : 'There is ' + a(terminalItem) + ' lying ' + place.en + '.';
    factOrder.push(addFact(whereText, seenBy, { type: 'where' }));

    // a couple of pieces of pure gossip, because the village needs opinions
    const opinionCount = 2 + ((rnd() * 2) | 0);
    for (let i = 0; i < opinionCount; i++) {
      const two = shuffled(all, rnd).slice(0, 2);
      const a = LG.NPCS.find(n => n.id === two[0]), b = LG.NPCS.find(n => n.id === two[1]);
      addFact(a.name + ' thinks ' + b.name + ' ' + pick(LG.OPINIONS, rnd) + '.',
        [a.id].concat(others([a.id, b.id], 1)), { type: 'opinion' });
    }

    /* The village gossip. At beginner she has heard the lot and will hand you the
       whole errand in one conversation; further up she has caught only some of it,
       and at advanced nothing but who thinks what about whom — an omniscient
       villager is a skeleton key that makes every other difficulty knob moot. */
    const gossip = LG.NPCS.find(n => n.prefers === 'gossip');
    const share = typeof level.gossip === 'number' ? level.gossip : 1;
    if (gossip) {
      Object.keys(facts).forEach(id => {
        if (facts[id].type === 'opinion' || rnd() < share) facts[id].holders[gossip.id] = true;
      });
    }

    /* -------------------------------------------- what to tell each model */
    const roles = {};
    LG.NPCS.forEach(n => {
      roles[n.id] = { goal: '', trade: null, link: -1 };
    });

    links.forEach((lk, i) => {
      const r = roles[lk.npcId];
      r.link = i;
      r.trade = { wants: lk.wants, wantsCount: lk.wantsCount,
                  gives: lk.gives, givesCount: lk.givesCount };
      if (i === 0) {
        r.goal = 'You want ' + a(lk.wants) + ' more than anything — ' + lk.reason +
          '. You ask everyone you meet about it and you do not know who has one. ' +
          'When the traveller brings you one, take it and give them ' + a(lk.gives) +
          ' in thanks.';
        r.trade.hint = 'Once it is clear the traveller is giving you ' + a(lk.wants) +
          ', take it and give them ' + a(lk.gives) + '.';
      } else if (lk.kind === 'sell') {
        r.goal = (shopkeeper(lk)
          ? 'You keep the village shop, and ' + a(lk.gives) + ' costs ' + NUMWORD[lk.wantsCount] + ' coins there.'
          : 'You have ' + a(lk.gives) + ' and you are willing to sell it, but you want ' +
            NUMWORD[lk.wantsCount] + ' coins for it — ' + lk.reason + '.') +
          ' You never give credit and you never come down on the price, though you are perfectly polite about it.';
        r.trade.hint = 'Once the traveller has agreed the price and is paying you ' + NUMWORD[lk.wantsCount] +
          ' coins, sell them ' + a(lk.gives) + '.';
      } else if (lk.kind === 'errand' && isBeast) {
        r.goal = 'Your ' + named(lk.wants) + ', ' + beastName + ', has wandered off again — ' +
          'somewhere ' + place.en + ', you think. You are worried. You will give ' +
          a(lk.gives) + ' to whoever brings ' + beastName + ' back, and you mention ' +
          'it to anyone who will listen.';
        r.trade.hint = 'Once the traveller is handing ' + beastName + ' back to you' +
          ', take them and hand over ' + a(lk.gives) + '.';
      } else if (lk.kind === 'errand') {
        r.goal = 'You need ' + a(lk.wants) + ' — ' + lk.reason + '. You believe there ' +
          'is one ' + place.en + ' but you cannot go and get it yourself. You will give ' +
          a(lk.gives) + ' to whoever fetches it.';
        r.trade.hint = 'Once the traveller is giving you ' + a(lk.wants) +
          ', take it and hand over ' + a(lk.gives) + '.';
      } else {
        // "You have coins ... you keep it on you" — mind the plural
        const them = lk.gives === 'coins' ? 'them' : 'it';
        r.goal = 'You have ' + a(lk.gives) + ' and you keep ' + them + ' on you. You will part ' +
          'with ' + them + ' for one thing only: ' + a(lk.wants) + ' — ' + lk.reason +
          '. Say so plainly if anyone asks.';
        r.trade.hint = 'Once it is plain that the traveller is trading you ' + a(lk.wants) +
          ' for it, take it and hand over ' + a(lk.gives) + '.';
      }
    });

    bystanders.forEach(n => {
      roles[n.id].goal = 'You want nothing in particular today. You are happy to stop and ' +
        'talk, and you pass on anything you have heard around the village.';
    });

    /* -------------------------------------------------------- assemble */
    const npcFacts = {};
    LG.NPCS.forEach(n => {
      npcFacts[n.id] = Object.keys(facts).filter(id => facts[id].holders[n.id]);
    });

    return {
      seed, level: opts.level, depth,
      links, facts, npcFacts, roles,
      prize,
      terminal: {
        item: terminalItem, isBeast, beastName,
        placeId: place.id, placeText: place.en, rect: place.rect
      },
      // the whole point of the errand, for the ending screen
      goalItem: wants[0], clientId: links[0].npcId, clientName: links[0].npcName
    };
  }

  /* Build, check, and reroll if the dice produced something degenerate. */
  function validate(plan) {
    if (!plan) return false;
    for (let i = 0; i < plan.links.length; i++) {
      const lk = plan.links[i];
      if (!lk.wants || !lk.gives || lk.wants === lk.gives) return false;
      if (i < plan.links.length - 1 && lk.wants !== plan.links[i + 1].gives) return false;
    }
    const t = LG.ITEMS[plan.terminal.item].tags;
    if (t.indexOf('ground') === -1 && t.indexOf('beast') === -1) return false;
    const ids = plan.links.map(l => l.npcId);
    if (new Set(ids).size !== ids.length) return false;
    return Object.keys(plan.facts).every(id => Object.keys(plan.facts[id].holders).length > 0);
  }

  function generate(opts) {
    for (let tries = 0; tries < 40; tries++) {
      const plan = attempt(tries === 0 ? opts
        : Object.assign({}, opts, { seed: (opts.seed || makeSeed()) + '~' + tries }));
      if (validate(plan)) return plan;
    }
    throw new Error('could not build a solvable errand chain');
  }

  return { generate, makeSeed, validate };
})();
