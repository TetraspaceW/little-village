/* trade.js — buying and selling with a villager for coin: what they'll
   deal in, at what price, and whether a sale their reply claims actually
   goes through.

   A villager's reply only *says* a sale happened; `commerce` is where the
   game decides whether it did, moves the goods and coins, and records the
   outcome in the villager's till so their next prompt sees what really
   happened. Everything about haggle bands, refunds, double-sale guards and
   errand items that can't be sold off sits behind that one call.

   Swapping one errand item for another (the chain's own trades) is not
   here — that's LG.game.doTrade, since finishing a link moves the story on. */
window.LG = window.LG || {};

LG.trade = (function () {
  const settings = LG.config.settings;
  const { count, give, take, log, txn } = LG.ledger;
  const renderHUD = LG.ledger.render;
  const { displayName, nameOrEmoji } = LG.actors;

  let chainNeeds = {};              // items the errand cannot be finished without

  /* Attaches the village whose errand items are off limits to sell. */
  function begin(plan) { chainNeeds = plan ? chainItems(plan) : {}; }

  /* Set of every item id involved anywhere in the errand chain (wants,
     gives, the terminal item, the prize). Computed once per village
     rather than per sale, since it's fixed for the whole playthrough. */
  function chainItems(plan) {
    const out = {};
    plan.links.forEach(lk => { out[lk.wants] = true; out[lk.gives] = true; });
    out[plan.terminal.item] = true;
    out[plan.prize] = true;
    delete out.coins;
    return out;
  }
  function neededForChain(id) { return !!chainNeeds[id]; }

  /* Processes a sale (single or multi-item) or its reverse (a refund).

     The villager's reply claims a sale happened; this function verifies
     and applies it, or explains why it can't. Their stated price is
     accepted as long as it isn't unreasonable — haggling is intentional
     and allowed.

     `item` accepts a list (not just a single tag), since a villager might
     narrate "beer and wine, that's six" as one sale. A single-tag-only
     version of this used to ring up a two-item sale as one item at the
     combined price — the player paid for both but only received one.

     Also handles taking an item back for a refund. A villager's `buys`
     list is only what they purchase as their trade (e.g. the innkeeper
     buys fish and meat) — it doesn't include their own recently-sold
     stock, so refunding a beer just poured a few minutes ago used to
     silently fail (no listed price for it) while the villager narrated
     agreeing to refund it. What was actually sold to the player is now
     tracked separately, and a refund uses the price actually paid. */
  function commerce(npc, act, itemId, price) {
    const d = npc.def;
    const coins = n => n + (n === 1 ? ' coin' : ' coins');

    npc.sold = npc.sold || {};                 // index of what can be refunded, and at what price
    npc.till = npc.till || [];                 // transaction log the villager's prompt can read
    npc.stock = npc.stock || {};               // items currently held (bought from the player)

    /* Blocks trading at night. Before the till existed, this was a bare
       `return false` — a silent failure: the villager's reply had already
       narrated handing over tea and taking payment, with nothing in the
       game state or conversation ever contradicting it. */
    if (!LG.view.open()) {
      return refuse('It is the middle of the night and you are not trading, so nothing changed hands.',
                    d.name + ' is not trading at this hour — nothing changed hands.');
    }

    /* A refusal must be visible to the villager via the till, not just
       to the player — otherwise the villager narrates the refund as
       completed with no way to know the game disagreed, then is
       confused when the same item is offered again later. */
    function refuse(note, shown) {
      npc.till.push({ failed: true, note: note });
      log('¤ ' + (shown || note));
      renderHUD();
      return false;
    }

    // `itemId` can arrive as a list, or as one string like "beer, wine" — both are handled.
    /* An explicit price of zero means nothing was actually being sold —
       just narration, not a real deal — and rejects it outright rather
       than letting the haggle-band logic below silently invent a
       non-zero price for it (which used to charge the player for a
       purchase nobody intended to make). A missing/unspecified price
       still falls back to the item's normal value. */
    // `null` is how the reply schema says "no price given" -- missing, not zero.
    const named = price != null && String(price).trim() !== '';
    if (named && Number(price) === 0) {
      return refuse('Nothing was actually exchanged, so nothing happened.',
                    'No price was named, so nothing changed hands.');
    }

    const asked = (Array.isArray(itemId) ? itemId : String(itemId || '').split(/[,;+]|\band\b/))
      .map(x => String(x || '').replace(/[^\w]/g, ''))
      .filter(x => x && x !== 'coins' && LG.ITEMS[x]);
    if (!asked.length) return false;

    const back = id => npc.sold[id] && npc.sold[id].n > 0 ? npc.sold[id] : null;
    const priced = asked.map(id => {
      // An item they've bought from the player can be resold, whether or not it's normally part of their trade.
      if (act === 'sell') {
        const own = npc.stock[id] > 0 ? Math.max(1, Math.round(LG.priceOf(id))) : 0;
        return { id: id, base: priceFrom(d.sells, d.sellsTags, id, 1) || own, fromStock: own > 0 };
      }
      const owed = back(id);                       // returning something they sold you
      return owed ? { id: id, base: owed.price, refund: true }
                  : { id: id, base: priceFrom(d.buys, d.buysTags, id, 0.5) };
    }).filter(w => w.base > 0);

    /* Check whether the villager actually holds the item before
       checking whether it has a price — otherwise a villager who does
       sell beer, but is out of stock, would incorrectly report not
       dealing in beer at all. */
    if (act === 'buy') {
      const short = asked.filter(id => count(id) < 1);
      if (short.length) {
        const names = short.map(id => LG.ITEMS[id].en).join(' or ');
        return refuse('The traveller does not actually have ' + names + ' to give you.',
                      'You have no ' + names + ' to hand over.');
      }
    }

    /* An item needed for the errand chain can't be sold to a villager
       for plain coins — without this, e.g. the pie the baker is waiting
       for could be sold to the innkeeper, breaking the chain with no way
       to recover it short of buying it back at her price. Trading (via
       doTrade, a different code path) still works normally — that's how
       the chain is supposed to move.

       The refusal note only states what the till did. It used to also
       claim the traveller was "carrying it for somebody," which is a
       fact this villager has no way of actually knowing. */
    if (act === 'buy') {
      const spoken = asked.filter(neededForChain);
      if (spoken.length) {
        const names = spoken.map(id => LG.ITEMS[id].en).join(' and ');
        return refuse('The ' + names + ' did not change hands: that is not one you buy off them.',
                      d.name + ' will not buy the ' + names + ' — it is part of the errand.');
      }
    }

    if (!priced.length) {
      const names = asked.map(id => LG.ITEMS[id].en).join(' and ');
      const theirs = asked.filter(id => priceFrom(d.sells, d.sellsTags, id, 1) > 0);
      return theirs.length
        ? refuse('That is not one you sold them, so there is nothing to refund.',
                 d.name + ' did not sell you that ' + LG.ITEMS[theirs[0]].en + '.')
        : refuse('You do not deal in ' + names + ', and said so.',
                 d.name + ' does not deal in ' + names + '.');
    }

    const base = priced.reduce((n, w) => n + w.base, 0);
    let cost = named ? Math.round(Number(price)) : base;
    if (!isFinite(cost) || cost < 0) cost = base;

    // Clamps price to a reasonable haggle range (not a scam); when the
    // clamp actually changes the price, that's logged so the player sees
    // a number that wasn't spoken in the conversation. A refund is never
    // haggled — it returns the exact price paid.
    const refunding = priced.every(w => w.refund);
    const asking = cost;
    cost = refunding
      ? Math.min(cost, base)                                   // never more than was paid
      : Math.max(Math.ceil(base * 0.4), Math.min(Math.ceil(base * 2.5), cost));

    const names = priced.map(w => LG.ITEMS[w.id].full).join(' and ');

    /* Guards against one sale being processed twice. A villager could
       set "action": "sell" on the turn they merely agreed to a price
       ("two coins and it's yours" — a bargain being struck, not goods
       actually changing hands), then set it again on the very next turn
       when the player held out coins in response — resulting in the item
       being sold and paid for twice. Prompting the model to only use
       "sell" once goods actually change hands helps but relies on model
       judgment; this check is a hard guarantee: an identical item, from
       the same villager, on the very next turn after already being sold
       and paid for, is rejected as a duplicate. A later repeat (e.g. the
       next day) is allowed — wanting a second knife later is ordinary.
       The rejection is recorded in the till, not silently absorbed as a
       second payment. */
    if (act === 'sell') {
      const last = npc.till[npc.till.length - 1];
      if (last && !last.failed && last.act === 'sell' && last.names === names &&
          (npc.turns || 0) - (last.turn || 0) <= 1) {
        return refuse('You had already handed over ' + names + ' and been paid for it, ' +
                      'so nothing changed hands this time.',
                      d.name + ' had already sold you ' + names + ' — nothing changed hands.');
      }
    }

    if (act === 'sell') {
      if (count('coins') < cost) {
        return refuse('The traveller could not afford that — they have ' +
          coins(count('coins')) + ', and you asked for ' + coins(cost) + '.',
          'Not enough coins for ' + names + ' (' + cost + ').');
      }
      take('coins', cost);
      priced.forEach(w => {
        if (npc.stock[w.id] > 0) npc.stock[w.id]--;      // off their own shelf
        give(w.id, 1);
        const share = Math.max(1, Math.round(cost * w.base / base));
        npc.sold[w.id] = { price: share, n: (npc.sold[w.id] ? npc.sold[w.id].n : 0) + 1 };
      });
    } else {
      priced.forEach(w => {
        take(w.id, 1);
        if (w.refund && npc.sold[w.id]) npc.sold[w.id].n--;
        /* The villager needs to actually hold the item now (unless it
           was a refund reversing a prior sale) — without this, a bought
           item would simply vanish from the game's state: the coin
           changed hands but the item itself didn't appear anywhere the
           villager could see, so they kept saying they had none. */
        else npc.stock[w.id] = (npc.stock[w.id] || 0) + 1;
      });
      give('coins', cost);
    }

    if (asking !== cost) log('¤ ' + d.name + ' said ' + asking + ', the going rate is ' + cost + '.');
    const dealKey = act === 'sell' ? 'buy' : refunding ? 'refund' : 'handOver';
    const ids = priced.map(w => w.id);
    txn('¤', dealKey, { items: itemsPhrase(ids, settings.lang), name: nameOrEmoji(npc), cost: cost },
                          { items: itemsPhrase(ids, 'en'), name: displayName(npc), cost: cost });

    /* What the villager's prompt sees (via the till) has to match what
       the game actually did — otherwise the model does its own
       arithmetic from an inconsistent memory and drifts (e.g. quoting
       six, being paid five, then claiming the player has three left). */
    npc.till.push({ act: act, refund: refunding, names: names, coins: cost,
                    asked: asking, at: LG.time.clock(), turn: npc.turns || 0 });
    renderHUD();
    return true;
  }

  /* Resolves what price (if any) this villager would sell/buy `id` at
     -- checks their explicit wares list first, then their general trade
     category tags. Returns 0 if they wouldn't deal in it at all. */
  function priceFrom(list, tags, id, factor) {
    const ware = (list || []).find(w => w.i === id);
    if (ware) return ware.p;
    const it = LG.ITEMS[id];
    if (it && tags && tags.some(t => (it.tags || []).indexOf(t) !== -1)) {
      return Math.max(1, Math.round(LG.priceOf(id) * (factor || 1)));
    }
    return 0;
  }

  /* Names a list of items in one language, joined the way that language
     says "and" — the native half of a deal's log line (see LG.ledger.txn). */
  function itemsPhrase(ids, lang) {
    const conj = ' ' + (LG.CONJ[lang] || LG.CONJ.en) + ' ';
    return ids.map(id => (LG.ITEMS[id] && (LG.ITEMS[id][lang] || LG.ITEMS[id].en)) || id).join(conj);
  }

  return { begin, commerce, priceFrom };
})();
