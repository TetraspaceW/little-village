/* pockets.js — what the traveller can do with their own things: eat or
   drink them, put them on, light them, play them, play with them (the
   toys themselves are LG.toys), and cook with them at an oven.

   The record of what they have stays in ledger.js; this is everything it
   means. From outside it is a handful of calls — `use` (an item in the
   Pockets box was clicked), the three oven ones (are you at one, is
   there one on this tile, open it), and what a villager or the sky needs
   to know (`wornList`, `litList`, `glow`). Behind them: body slots,
   containers left behind, lights, who hears an instrument, recipes and
   the tools they keep, the oven panel and who sees you cook, and the rule
   that nothing the errand still needs gets eaten or cooked.

   It draws nothing in the Pockets box itself. The ledger draws that, and
   asks this module, through `describeWith`, how a pill should read and
   what clicking it does — so the ledger never learns what eating is, and
   this never learns how a pill is drawn.

   What it needs of the game it reads off LG.village (the errand, the
   villagers, the traveller), so it takes no setting up. */
window.LG = window.LG || {};

LG.pockets = (function () {
  const L = LG.ledger, W = LG.world, settings = LG.config.settings, TILE = W.TILE;
  const { escapeHTML } = LG.text;
  const state = L.state;
  const EARSHOT = 12;                  // tiles: how far an instrument carries

  const item = id => LG.ITEMS[id];
  const label = id => LG.itemName(id, settings.lang);
  const say = (id, key, english) =>
    L.txn(item(id).icon, key, { item: label(id) }, { item: english });

  /* ------------------------------------------------------- the errand rule
     How many of an item the errand is still waiting on: every link not yet
     traded that wants it. Read live off the villagers, like factSpent, so
     it can't fall out of step with what has happened. There's no getting
     a second goal item once the first is gone, and a dead-ended village
     isn't a fair price for a snack. */
  function stillNeeded(id) {
    const V = LG.village;
    if (!V.plan) return 0;
    return V.plan.links.reduce((sum, lk) => {
      if (lk.wants !== id) return sum;
      const owner = V.npcs.find(n => n.def.id === lk.npcId);
      return owner && owner.tradeDone ? sum : sum + (lk.wantsCount || 1);
    }, 0);
  }
  const spare = id => L.count(id) - stillNeeded(id);

  /* ------------------------------------------------------------- using */
  /* Anyone within earshot of an instrument hears it, walls or no walls,
     and it's theirs to bring up. Remembering the same thing twice is a
     no-op (see LG.actors.remember), so a tune doesn't fill anyone's memory. */
  function heard(id) {
    const V = LG.village, me = V.player, it = item(id);
    if (!me) return;
    V.npcs.filter(n => Math.hypot(n.px - me.px, n.py - me.py) < EARSHOT * TILE).forEach(n =>
      LG.actors.remember(n, 'You heard the traveller ' + (it.rung ? 'ring ' : 'play ') + it.full + ' nearby.'));
  }

  /* Eats, drinks, puts on or takes off, lights or puts out, or plays one
     of the traveller's own things (see `use` on LG.ITEMS). Returns
     whether anything happened. */
  function use(id) {
    const it = item(id);
    if (!it || !it.use || !L.count(id)) return false;
    switch (it.use) {
      case 'wear':
        if (state.worn[id]) { delete state.worn[id]; say(id, 'takeOff', 'the ' + it.en); }
        else {
          Object.keys(state.worn).forEach(k => { if (item(k).slot === it.slot) delete state.worn[k]; });
          state.worn[id] = true;
          say(id, 'wear', it.full);
        }
        L.render();
        return true;
      case 'light':
        if (state.lit[id]) { delete state.lit[id]; say(id, 'putOut', 'the ' + it.en); }
        else { state.lit[id] = true; say(id, 'light', 'the ' + it.en); }
        L.render();
        return true;
      case 'play':
        LG.sound.play(it.gm, it.note);
        say(id, it.rung ? 'ring' : 'play', 'the ' + it.en);
        heard(id);
        return true;
      case 'roll': LG.toys.openDice(); return true;
      case 'kick': return LG.toys.useBall();
      case 'fly': return LG.toys.useKite();
      default:                         // eat, drink
        if (spare(id) < 1) {
          L.log('You had better hang on to the ' + it.en + ' for now.');
          return false;
        }
        L.take(id);
        if (it.leaves) L.give(it.leaves, 1);   // the jar, cup or bowl it came in
        say(id, it.use, it.full);
        return true;
    }
  }

  /* ---------------------------------------------- what others can tell */
  const shown = set => Object.keys(set).filter(k => L.count(k) > 0)
    .map(k => LG.itemSaid(k, settings.lang, true)).join(', ');
  function wornList() { return shown(state.worn); }
  function litList() { return shown(state.lit); }
  /* How far, in tiles, the brightest light the traveller has burning
     reaches — 0 with none lit. */
  function glow() {
    return Object.keys(state.lit).reduce((r, k) =>
      L.count(k) > 0 ? Math.max(r, item(k).glow || 0) : r, 0);
  }

  /* --------------------------------------------------- the Pockets box */
  const VERB = { eat: 'Eat', drink: 'Drink', wear: 'Put on', light: 'Light', play: 'Play',
                 roll: 'Roll', kick: 'Put down', fly: 'Fly' };
  const UNDO = { wear: 'Take off', light: 'Put out', kick: 'Pick up', fly: 'Reel in' };
  /* How the ledger should draw an item's pill: null for a plain one, or
     its tooltip, the mark beside its name ("(worn)", "(lit)") in the
     village's language, whether it's on, and what a click does. */
  function pill(id) {
    const it = item(id);
    if (!it || !it.use) return null;
    const on = !!(state.worn[id] || state.lit[id] || state.out[id]);
    return {
      title: (on ? UNDO[it.use] : it.rung ? 'Ring' : VERB[it.use]) + ' the ' + it.en,
      mark: state.worn[id] ? LG.wornMark(id, settings.lang)
          : state.lit[id] ? LG.litMark(id, settings.lang) : '',
      on,
      act: () => use(id)
    };
  }
  L.describeWith(pill);

  /* ------------------------------------------------------------- cooking */
  /* Can one of LG.RECIPES be made from what's in the pockets? `with` only
     has to be there, so the errand loses nothing by it. */
  function canCook(recipe) {
    const kept = recipe.with || {};
    return Object.keys(recipe.needs).every(k => spare(k) >= recipe.needs[k]) &&
           Object.keys(kept).every(k => L.count(k) >= kept[k]);
  }
  function cook(recipe) {
    if (!canCook(recipe)) return false;
    Object.keys(recipe.needs).forEach(k => L.take(k, recipe.needs[k]));
    L.give(recipe.makes, 1);
    say(recipe.makes, 'cook', item(recipe.makes).full);
    return true;
  }

  /* --------------------------------------------------------------- ovens
     An oven you're standing beside, in the same room as you — the one in
     the farmhouse kitchen can't be reached through its wall. */
  function ovenHere() {
    const me = LG.village.player, room = me && W.buildingUnder(me);
    return room ? W.ovens().find(o => o.building === room && W.nearRect(me, o, 1)) || null : null;
  }
  function atOven() { return !!ovenHere(); }
  /* Is there an oven on this tile that the traveller can see — one in the
     room they're in? (A tap names a tile, not an oven.) */
  function ovenOnTile(tx, ty) {
    const me = LG.village.player, room = me && W.buildingUnder(me);
    return !!room && W.ovens().some(o => o.building === room && W.nearRect({ tx, ty }, o, 0));
  }

  function openOven() {
    const panel = document.getElementById('oven');
    document.getElementById('ovenClose').onclick = () => panel.classList.remove('open');
    renderOven();
    panel.classList.add('open');
  }

  /* Lists only the recipes the traveller has at least one ingredient
     for — a list of every dish the village knows would read as a
     shopping list, and finding out what wheat is good for is half the fun.
     An ingredient the errand is still waiting on doesn't count, since it
     can't go in the pot (see `spare`): carrying the farmer's wheat
     shouldn't put bread on the list. Holding a kept tool (the teapot)
     does show its recipe; those sit in a dashed outline. Anything you
     can't put in, missing or spoken for, is greyed. */
  function renderOven() {
    const lang = LG.config.language(), box = document.getElementById('ovenList');
    const part = (id, n, kept) => {
      const it = item(id), short = (kept ? L.count(id) : spare(id)) < n;
      return '<span class="' + (short ? 'lack' : '') + (kept ? ' kept' : '') + '" title="' +
             escapeHTML(it.en + (kept ? ' (kept)' : '')) + '">' + it.icon +
             ' <span lang="' + lang.tag + '">' + escapeHTML(label(id)) +
             (n > 1 ? ' ×' + n : '') + '</span></span>';
    };
    const known = LG.RECIPES.filter(r => Object.keys(r.needs).some(k => spare(k) > 0) ||
                                         Object.keys(r.with || {}).some(k => L.count(k) > 0));
    box.innerHTML = known.length
      ? known.map(r => '<div class="recipe"><span class="parts">' +
          Object.keys(r.needs).map(k => part(k, r.needs[k]))
            .concat(Object.keys(r.with || {}).map(k => part(k, r.with[k], true))).join(' + ') +
          ' → ' + part(r.makes, 0) +
          '</span><button type="button" class="chip" data-recipe="' + LG.RECIPES.indexOf(r) + '"' +
          (canCook(r) ? '' : ' disabled') + '>Cook</button></div>').join('')
      : '<div class="notice muted">Nothing in your pockets that wants cooking.</div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-recipe]'), el => {
      el.onclick = () => cookAt(LG.RECIPES[+el.dataset.recipe]);
    });
  }

  /* Anyone in the room sees it done, and it's theirs to mention — the
     farmer will know who has been at the oven. */
  function cookAt(recipe) {
    const oven = ovenHere();
    if (oven && cook(recipe)) {
      LG.village.npcs.filter(n => W.buildingUnder(n) === oven.building).forEach(n =>
        LG.actors.remember(n, 'The traveller cooked ' + item(recipe.makes).full + ' in the oven in the ' +
                              oven.building.label + ' while you watched.'));
    }
    renderOven();
  }

  return { use, canCook, cook, atOven, ovenOnTile, openOven, wornList, litList, glow };
})();
