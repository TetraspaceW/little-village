/* village.js — the village as it stands: the errand chain it was built
   from, its villagers, the traveller, and the thing out in the world that
   the errand ends at. One owner for all of it, so the conversation code,
   the prompt view and the save all read the same village the main loop is
   running, without having to go through the main loop to get it.

   `create` builds a whole village from a seed; nothing else replaces any
   of the pieces, though they are mutated freely as the game goes on.
   Alongside the state are the questions only the whole village can
   answer — is this fact already done with, could the traveller hear that —
   so they're asked in one place rather than re-derived by each caller. */
window.LG = window.LG || {};

LG.village = (function () {
  const W = LG.world, A = LG.actors, TILE = W.TILE;
  const { remember, think } = A;
  const nearRect = W.nearRect;

  let plan = null;                 // the generated errand chain (chain.js)
  let player = null, npcs = [], beast = null, worldItem = null;
  let whereFact = null;            // the fact saying where the world thing is lying

  function dist(a, b) { return Math.hypot(a.px - b.px, a.py - b.py); }

  /* Builds a fresh village from `seed` (or a random one) at `level`:
     the chain, the cast at their posts, the traveller off the train,
     and the terminal item or animal wherever the chain put it. */
  function create(seed, level) {
    plan = LG.chain.generate({ level: level, seed: seed || null });

    /* The player arrives by train. The platform is at the far east end
       of the high street, so the walk into the village covers its full
       length -- arriving somewhere nobody is expecting them. */
    const p = W.nearestOpen(LG.START.x, LG.START.y);
    player = { px: p.x * TILE + TILE / 2, py: p.y * TILE + TILE / 2, dir: 'left',
               tx: p.x, ty: p.y, bubble: null, bubbleT: 0 };
    npcs = LG.NPCS.map(d => A.makeNPC(d, plan.npcFacts[d.id]));
    // Every villager gets an assigned workplace, and a fallback indoor shelter for bad weather.
    const publics = ['Inn', 'Village Hall', 'Chapel']
      .map(l => W.buildingByLabel(l)).filter(Boolean);
    npcs.forEach((n, i) => {
      const b = n.def.workplace ? W.buildingByLabel(n.def.workplace) : null;
      n.work = b ? b.inside : (n.def.workRect || n.def.home);
      n.workBuilding = b;
      const refuge = b || publics[i % Math.max(1, publics.length)];
      n.shelter = refuge ? refuge.inside : n.def.home;
    });

    /* Petra always greets a new arrival at the platform. This is scripted
       rather than left to the model (contrast with the ordinary
       "go find the player" behavior in placesFor/followPlayer) — she
       starts in the already-decided "following the player" state
       instead of arriving at it by an intent decision, since a village
       character established as knowing everyone's business would
       plausibly always meet a stranger immediately. */
    const petra = npcs.find(n => n.def.id === 'petra');
    if (petra) {
      const spot = W.nearestOpen(p.x - 5, p.y + 1);
      petra.tx = spot.x; petra.ty = spot.y;
      petra.px = spot.x * TILE + TILE / 2; petra.py = spot.y * TILE + TILE / 2;
      petra.followingPlayer = true;
      petra.wentAfter = 'player';
      petra.why = 'a traveller has just got off the train, and nobody has told them anything about the village yet';
    }

    // Find the "where" fact -- the location of the terminal (chain-ending) item.
    whereFact = Object.keys(plan.facts).find(id => plan.facts[id].type === 'where') || null;
    beast = null; worldItem = null;
    const t = plan.terminal;
    if (t.isBeast) {
      beast = A.makeCreature({ item: t.item, name: t.beastName,
                               emoji: LG.ITEMS[t.item].icon, home: t.rect });
    } else {
      const r = t.rect;
      const spot = W.nearestOpen(r.x + ((Math.random() * r.w) | 0), r.y + ((Math.random() * r.h) | 0));
      worldItem = { item: t.item, px: spot.x * TILE + TILE / 2, py: spot.y * TILE + TILE / 2, taken: false };
    }
  }

  /* Whether the terminal (chain-ending) item has been collected --
     tracked as a one-way, once-ever flag. Trading it away afterward
     doesn't put it back where it was lying. */
  function haveTerminal() {
    return !!((worldItem && worldItem.taken) || (beast && beast.caught));
  }

  /* Has this fact already been resolved by the world state?

     Previously this check was implemented three separate times, each
     covering only one case: `learn` had its own logic that only knew
     about the world-item location fact; `doTrade` had inline logic that
     only knew about its own link and just deleted the note; picking up
     the terminal item had a third, separate flag. As a result, a
     villager could state a want that had already been fulfilled (e.g.
     the goal item already delivered) and it would still show in the
     notebook as an active lead, since whichever completion path had
     actually happened wasn't checked by the note-writing code.

     Now there's one function used everywhere, reading from two sources
     that are both guaranteed one-way: `haveTerminal` is explicitly
     once-ever, and a completed trade (`tradeDone`) never reverts. That
     one-wayness is what makes this check safe to rely on globally. */
  function factSpent(id) {
    const f = plan && plan.facts[id];
    if (!f || f.type === 'opinion') return false;      // an opinion is never spent
    if (f.type === 'where') return haveTerminal();
    if (typeof f.link === 'number' && f.link >= 0) {
      const lk = plan.links[f.link];
      const owner = lk && npcs.find(n => n.def.id === lk.npcId);
      return !!(owner && owner.tradeDone);
    }
    return false;
  }

  function noticeItemGone(n) {
    if (!whereFact || !haveTerminal()) return;
    const i = n.facts.indexOf(whereFact);
    if (i === -1) return;
    if (!nearRect(n, plan.terminal.rect, 3)) return;
    n.facts.splice(i, 1);
    /* States only what the villager directly observed. An earlier
       version said "somebody has had it away" -- implying a theft they
       didn't actually witness, which would then get repeated as
       established fact. This version only states that they looked and
       found nothing; any interpretation of that is left to the model. */
    const t = plan.terminal;
    const line = t.isBeast
      ? 'You went ' + t.placeText + ' yourself and ' + t.beastName + ' was not there.'
      : 'You went ' + t.placeText + ' yourself and there was no ' +
        LG.ITEMS[t.item].en + ' there.';
    remember(n, line);                       // seen with their own eyes: no source to name
    think(n, 'finds nothing there', t.placeText);
  }

  /* Whether the player is close enough to overhear this conversation
     -- only affects whether it's logged; the conversation itself happens
     regardless. */
  function canOverhear(a, b) {
    return dist(player, a) < TILE * 11 || dist(player, b) < TILE * 11;
  }

  return { create, factSpent, haveTerminal, canOverhear, noticeItemGone,
           factText: id => (plan && plan.facts[id]) ? plan.facts[id].text : null,
           get plan() { return plan; },
           get npcs() { return npcs; },
           get player() { return player; },
           get beast() { return beast; },
           get worldItem() { return worldItem; } };
})();
