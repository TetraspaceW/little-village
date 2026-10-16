/* ledger.js — what the traveller has, knows and has done: their pockets,
   their notebook, the deeds list, and the running log under the village,
   along with drawing all of it into the HUD.

   This is the one place the player's own record changes, so anything that
   hands over an item or teaches a fact — a conversation, a sale, picking
   something up off the ground — goes through the same few calls and the
   HUD can't fall out of step with the state. `state` is the part a save
   carries; it's one object mutated in place, so a reference taken once
   stays current across new villages.

   A village is attached with `begin(plan, isSpent, keep)`: the plan says
   which facts exist to be learned, and `isSpent(factId)` asks the world
   whether a note is already done with, so the notebook can strike it
   through without storing a flag that could go stale. `keep(itemId)` asks
   how many of an item the errand still needs, so eating or drinking
   can't use up the one thing somebody is waiting on. */
window.LG = window.LG || {};

LG.ledger = (function () {
  const settings = LG.config.settings, C = LG.config;
  const { escapeHTML, rubyHTML } = LG.text;

  const state = { inv: {}, worn: {}, notes: [], deeds: [], won: false, board: [] };
  const logLines = [];
  let plan = null;
  let isSpent = () => false;
  let keep = () => 0;

  /* Starts the record afresh for a new (or about-to-be-restored) village. */
  function begin(newPlan, spent, needed) {
    plan = newPlan;
    isSpent = spent || (() => false);
    keep = needed || (() => 0);
    state.inv = { coins: 10 };          // a little money to be going on with
    state.worn = {};
    state.notes = []; state.deeds = []; state.won = false; state.board = [];
    logLines.length = 0;
  }

  /* ---------------------------------------------------------- inventory */
  function count(id) { return state.inv[id] || 0; }
  function give(id, n) { state.inv[id] = (state.inv[id] || 0) + (n || 1); render(); }
  function take(id, n) {
    state.inv[id] = Math.max(0, (state.inv[id] || 0) - (n || 1));
    if (!state.inv[id]) { delete state.inv[id]; delete state.worn[id]; }   // can't wear what you've handed over
    render();
  }
  /* `exclude` omits one item from the list entirely -- used for a
     caught animal following the player, which isn't really "in a
     pocket" and is described separately (see LG.view.companion). */
  /* What's worn is listed by `wornList` instead, so a hat on the
     traveller's head isn't also described as being in a pocket. */
  function inventoryList(exclude) {
    const carried = k => state.inv[k] - (state.worn[k] ? 1 : 0);
    const ks = Object.keys(state.inv).filter(k => carried(k) > 0 && k !== exclude);
    if (!ks.length) return '';
    // Used only in the villager's prompt, so names items the way the rest of that prompt does -- see LG.itemSaid.
    return ks.map(k => LG.itemSaid(k, settings.lang, true) +
                       (carried(k) > 1 ? ' x' + carried(k) : '')).join(', ');
  }
  function wornList() {
    return Object.keys(state.worn).filter(k => state.inv[k] > 0)
      .map(k => LG.itemSaid(k, settings.lang, true)).join(', ');
  }
  function itemLabel(id) { return LG.itemName(id, settings.lang); }

  /* Eats, drinks, puts on or takes off one of the traveller's own things
     (see `use` on LG.ITEMS). Returns whether anything happened. Eating
     or drinking refuses to touch anything the errand is still waiting on
     — there's no getting a second goal item once the first is gone, and
     a dead-ended village isn't a fair price for a snack. */
  function use(id) {
    const it = LG.ITEMS[id];
    if (!it || !it.use || !count(id)) return false;
    const say = (key, english) => txn(it.icon, key, { item: itemLabel(id) }, { item: english });
    if (it.use === 'wear') {
      if (state.worn[id]) {
        delete state.worn[id];
        say('takeOff', 'the ' + it.en);
      } else {
        Object.keys(state.worn).forEach(k => {
          if (LG.ITEMS[k].slot === it.slot) delete state.worn[k];
        });
        state.worn[id] = true;
        say('wear', it.full);
      }
      render();
      return true;
    }
    if (count(id) <= keep(id)) {
      log('You had better hang on to the ' + it.en + ' for now.');
      return false;
    }
    take(id);
    say(it.use, it.full);
    return true;
  }
  const VERB = { eat: 'Eat', drink: 'Drink', wear: 'Put on' };

  /* Narrates a completed deal ("you hand over the rope") in the
     village's language rather than English — see LG.TXN. `native` and
     `english` fill the same template's placeholders in each language;
     the English fill doubles as the click-to-reveal gloss, matching
     everything else the notebook shows. */
  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : ''));
  }
  function txn(icon, key, native, english) {
    const set = LG.TXN[key];
    if (!set) return;
    const L = C.language();
    const line = fillTemplate(set[settings.lang] || set.en, native);
    const gloss = fillTemplate(set.en, english);
    const hide = settings.showTranslation ? '' : ' hidden-tr';
    pushLog(icon + ' <span class="heard" lang="' + L.tag + '">' + escapeHTML(line) + '</span>' +
            '<span class="gloss' + hide + '" lang="en" title="click to read">' + escapeHTML(gloss) + '</span>');
  }

  /* ------------------------------------------------------------ notebook
     The notebook only contains facts a villager has actually told the
     player — villagers self-report which facts they revealed, and those
     reports are recorded here (see `learn` below).

     Not every learnable fact belongs here, though: `opinion` facts (the
     gossip chain.js generates so villagers have something to talk
     about) are real, checkable, learnable facts just like errand facts,
     but they aren't part of the errand. Including them would turn the
     one page meant to say "what to do next" into something the player
     has to sift through for the facts that actually matter. */
  function hasNote(factId) {
    return state.notes.some(n => n.id === factId);
  }
  function learn(factId, fromNpc, note, ruby) {
    if (!plan || !plan.facts[factId]) return;
    if (plan.facts[factId].type === 'opinion') return;   // gossip, not the errand
    if (hasNote(factId)) return;
    if (fromNpc && fromNpc.facts.indexOf(factId) === -1) return;   // they can't tell you what they don't know
    /* A note records only that the player was told something — not
       whether it's still actionable. That state was previously cached
       and could go stale: e.g. a note about an item's location used to
       still display as a live lead even after the item was already in
       the player's inventory. `isSpent` (see render) now reads that
       status live from current game state at render time instead, so
       there's no cached flag that can be wrong. */
    state.notes.push({ id: factId, text: note || plan.facts[factId].text,
                       ruby: ruby || null });
    log('📓 ' + (note || plan.facts[factId].text));
    render();
  }

  /* ----------------------------------------------------------------- log */
  function pushLog(html) {
    logLines.push(html);
    if (logLines.length > 5) logLines.shift();
    const box = document.getElementById('log');
    box.innerHTML = logLines.map(l => '<div>' + l + '</div>').join('');
    Array.prototype.forEach.call(box.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  function log(msg) { pushLog(escapeHTML(msg)); }

  /* Logs a line overheard between two villagers.

     Villagers speak to each other only in their own language — no
     English shown by default, matching the exchange itself. The line
     shown carries furigana/romanization like any other displayed line.
     The English gloss is available to self-check against but stays
     blurred until clicked, and unlike other lines it stays blurred even
     with translations turned on globally — showing it by default would
     let the player skip understanding the overheard language entirely. */
  function logSpeech(name, said, ruby, roman, gloss) {
    const L = C.language();
    const heard = (ruby && L.furigana) ? rubyHTML(ruby) : escapeHTML(said);
    let html = '<span class="who">\uD83D\uDC42 ' + escapeHTML(name) + ':</span> ' +
               '<span class="heard" lang="' + L.tag + '"' +
               (ruby && L.furigana ? ' style="line-height:2"' : '') +
               '>' + heard + '</span>';
    if (roman && L.romanize) html += '<span class="roman" lang="' + L.romanTag + '">' +
                                     escapeHTML(roman) + '</span>';
    if (gloss) html += '<span class="gloss hidden-tr" lang="en" title="click to read">' +
                       escapeHTML(gloss) + '</span>';
    pushLog(html);
  }

  /* ----------------------------------------------------------------- HUD */
  function render() {
    const purse = document.getElementById('purse');
    if (purse) purse.textContent = '\u00a4' + (state.inv.coins || 0);
    const inv = document.getElementById('inv');
    const L = C.language();
    const ks = Object.keys(state.inv).filter(k => state.inv[k] > 0 && k !== 'coins');
    /* Anything with a `use` is a button: click it to eat, drink, or put
       it on (and click again to take it off). The tooltip says which, in
       English like the plain pills' tooltips. */
    inv.innerHTML = ks.length
      ? ks.map(k => {
          const it = LG.ITEMS[k], worn = !!state.worn[k];
          const body = it.icon + ' <span lang="' + L.tag + '">' + escapeHTML(itemLabel(k)) +
            (state.inv[k] > 1 ? ' ×' + state.inv[k] : '') + '</span>' +
            (worn ? ' <span class="worn-tag">worn</span>' : '');
          if (!it.use) return '<span class="pill" title="' + it.en + '">' + body + '</span>';
          const verb = worn ? 'Take off' : VERB[it.use];
          return '<button type="button" class="pill use' + (worn ? ' worn' : '') +
                 '" data-use="' + k + '" title="' + verb + ' the ' + it.en + '">' + body + '</button>';
        }).join('')
      : '<span class="muted">empty pockets</span>';
    Array.prototype.forEach.call(inv.querySelectorAll('[data-use]'), el => {
      el.onclick = () => use(el.dataset.use);
    });

    const nb = document.getElementById('notebook');
    const rows = state.deeds.map(d => '<div class="q done">✔ ' + escapeHTML(d) + '</div>')
      .concat(state.notes.map(n => {
        const heard = (n.ruby && L.furigana) ? rubyHTML(n.ruby) : escapeHTML(n.text);
        const gloss = plan.facts[n.id].text;
        const hide = settings.showTranslation ? '' : ' hidden-tr';
        const done = isSpent(n.id);            // read off the world, never stored
        return '<div class="q' + (done ? ' done' : '') + '"><span class="heard" lang="' +
               L.tag + '"' + (L.furigana && n.ruby ? ' style="line-height:2"' : '') +
               '>' + (done ? '\u2714 ' : '\u2022 ') + heard + '</span>' +
               '<span class="gloss' + hide + '" lang="en" title="' + escapeHTML(gloss) + '">' +
               escapeHTML(gloss) + '</span></div>';
      }));
    nb.innerHTML = rows.length ? rows.join('')
      : '<div class="q muted">Nothing yet. Try asking around!</div>';
    Array.prototype.forEach.call(nb.querySelectorAll('.gloss.hidden-tr'), el => {
      el.onclick = () => el.classList.remove('hidden-tr');
    });
  }

  return { state, begin, count, give, take, use, inventoryList, wornList, hasNote, learn,
           log, logSpeech, txn, render };
})();
