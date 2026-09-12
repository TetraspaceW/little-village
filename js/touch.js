/* touch.js — touch/mobile input handling: virtual joystick and tap-to-interact.

   The keyboard scheme maps to two separate inputs: movement keys walk,
   E interacts with whatever's in front of the player. Touch input has
   neither concept built in — a finger just touches a point on screen —
   so this module derives both gestures from raw touch events:

     touch down and drag       — a virtual joystick appears at that point
     touch down, then lift     — a tap, aimed at whatever's under it
     tap, then touch again and hold — running, for as long as held

   The joystick appears wherever the touch started rather than in a
   fixed screen position, since a fixed position matches only one
   specific hand/thumb placement. It's only drawn once a drag is
   confirmed, so a plain tap leaves no UI artifact behind.

   Whether a touch is a drag or a tap can't be determined the instant it
   starts, since both begin identically — every touch is tracked as
   ambiguous until it either moves past DEAD pixels (drag) or lifts
   within TAP_MS (tap). A touch that does neither (a long press that
   never moves and isn't released) resolves to neither gesture and has
   no effect, which is the correct behavior for an idle finger resting
   on the screen.

   This module has no concept of villagers or other game entities — it
   only reports a screen coordinate, and game.js determines what's
   there. This keeps the gesture logic testable independent of game
   state, and keeps interaction-range logic in one place shared with
   the E key's equivalent checks. */
window.LG = window.LG || {};

LG.touch = (function () {
  /* All measured in CSS pixels — the canvas is drawn in CSS pixels and
     touch coordinates are reported in them, regardless of the
     underlying device pixel ratio. */
  const DEAD = 12;      // travel before a maybe becomes a walk
  const RANGE = 54;     // the stick's throw: full speed at the rim
  const TAP_MS = 320;   // a maybe that lingers longer than this is neither
  const SLOW = 0.4;     // the slowest a barely-leaning finger will walk you
  const DBL_MS = 350;   // gap the next touch has to land inside to pair with the last tap
  const DBL_DIST = 40;  // and how far it may land from it

  let canvas = null;
  let blocked = () => false;          // true while a panel is open and input should be ignored
  let onTap = null;
  let lastTap = null;                 // {x, y, t} of the previous tap, kept briefly in case a second touch pairs with it
  let runHoldId = null;               // id of the touch currently triggering running, or null

  /* Tracks every active touch, and which one (if any) has been promoted
     to drive the joystick. Only one touch can drive the joystick at a
     time — a second touch can still register as a tap while the first
     is walking, which is the reason multiple touches are tracked at all. */
  const down = new Map();
  let stickId = null;
  let ring = null;      // joystick draw position, set once there's something to draw
  let vec = null;       // null while in the dead zone -- returning to center stops movement

  /* Determines the initial control-scheme hint shown to the player. A
     coarse pointer (touch) is assumed before any input is received, so
     the initial hint is already correct for a phone; a mouse event
     arriving afterward overrides that assumption. */
  let mode = false;
  function coarse() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
    catch (e) { return false; }
  }
  function setMode(on) {
    if (mode === on) return;
    mode = on;
    try { document.body.classList.toggle('touch', on); } catch (e) {}
  }

  /* ------------------------------------------------------------- the gesture */
  /* These are separated out from the DOM event handlers so tests can
     call them directly — the smoke test sandbox has no browser to
     dispatch real PointerEvents, and the logic worth testing (the dead
     zone, joystick origin behavior, tap vs. drag detection) all lives here. */
  function begin(id, x, y, t) {
    if (blocked()) return;
    down.set(id, { x0: x, y0: y, x: x, y: y, t0: t, moved: false });
    if (stickId === null) stickId = id;
    /* A touch landing soon enough and close enough to the previous tap
       is treated as the "hold" half of a double-tap-and-hold gesture --
       running starts immediately on touch-down, since there's no way
       yet to distinguish a hold from a tap that's merely passing
       through this same spot. If it does turn out to be just a tap,
       `end` below clears the run state again shortly after, briefly
       enough not to be noticeable, and the tap is still reported
       normally. This doesn't check what the touch landed on: if the
       first tap opened something (a villager, a sign), `blocked()`
       above prevents this second touch from being processed at all, so
       a genuine double-tap pairing can only form on empty ground. */
    if (lastTap && t - lastTap.t <= DBL_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) <= DBL_DIST) {
      lastTap = null;
      runHoldId = id;
    }
  }

  function move(id, x, y) {
    const p = down.get(id);
    if (!p) return;
    p.x = x; p.y = y;
    if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > DEAD) p.moved = true;
    if (id === stickId && p.moved) aim(p);
  }

  function end(id, x, y, t) {
    const p = down.get(id);
    if (!p) return;
    down.delete(id);
    if (id === stickId) hand();
    if (id === runHoldId) runHoldId = null;   // release regardless of how long it was held
    /* A tap is whatever's left when a touch neither became a drag nor
       lingered too long. `blocked()` is re-checked here rather than
       trusted from touch-start, since something that happened between
       touch-down and touch-up may have opened a panel in the meantime. */
    if (p.moved || t - p.t0 > TAP_MS || blocked()) { lastTap = null; return; }
    if (onTap) onTap(x, y);
    lastTap = { x, y, t };   // kept briefly, in case the next touch pairs with it into a double-tap
  }

  function cancel(id) {
    if (!down.has(id)) return;
    down.delete(id);
    if (id === stickId) hand();
    if (id === runHoldId) runHoldId = null;
  }

  /* Called when the touch driving the joystick is released. If another
     touch is still active, it takes over the joystick from its current
     position — the alternative would be abruptly stopping movement just
     because a second finger happened to be resting on the screen. The
     new touch restarts as ambiguous (drag vs. tap), so this handoff
     can't itself register as a tap. */
  function hand() {
    stickId = null; ring = null; vec = null;
    const next = down.keys().next();
    if (next.done) return;
    stickId = next.value;
    const q = down.get(stickId);
    q.x0 = q.x; q.y0 = q.y; q.moved = false;
  }

  function aim(p) {
    const dx = p.x - p.x0, dy = p.y - p.y0;
    const len = Math.hypot(dx, dy);
    /* The joystick knob is clamped to the outer rim rather than having
       the origin itself drift to follow an overshooting finger. Origin
       drift was tried previously (it lets the thumb avoid a full
       re-throw after a long walk), but it caused the joystick base to
       visibly chase the finger's trail across the screen during
       back-and-forth movement, which read as the stick sliding around
       rather than as controlled steering. Since speed already saturates
       at the rim (see the push calculation below), clamping the knob
       there loses nothing — the origin now only moves when the finger
       lifts and touches down again. */
    const cap = len > RANGE ? RANGE / len : 1;
    ring = { x: p.x0, y: p.y0, kx: p.x0 + dx * cap, ky: p.y0 + dy * cap };
    if (len <= DEAD) { vec = null; return; }
    const push = SLOW + (1 - SLOW) * Math.min(1, (len - DEAD) / (RANGE - DEAD));
    vec = { x: (dx / len) * push, y: (dy / len) * push };
  }

  /* Clears all touch state. The important case is the tab losing focus
     while a finger is still down — without this, the player would
     resume walking in whatever direction they were last moving. Exported
     so other callers can trigger the same reset for their own reasons. */
  function release() {
    down.clear(); stickId = null; ring = null; vec = null; lastTap = null; runHoldId = null;
  }

  /* ---------------------------------------------------------------- the wiring */
  function init(cv, hooks) {
    canvas = cv;
    blocked = (hooks && hooks.blocked) || blocked;
    onTap = (hooks && hooks.tap) || null;
    setMode(coarse());
    if (!canvas || !canvas.addEventListener) return;

    const at = e => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const now = () => (window.performance ? performance.now() : Date.now());
    const finger = e => e.pointerType !== 'mouse';

    canvas.addEventListener('pointerdown', e => {
      setMode(finger(e));
      if (!finger(e)) return;              // a mouse still goes through click, below
      /* Prevents the browser's default touch behaviors: scrolling,
         double-tap zoom, or a synthetic click event that would
         re-trigger the same sign toggle a second time. */
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      begin(e.pointerId, at(e).x, at(e).y, now());
    });
    canvas.addEventListener('pointermove', e => {
      if (!finger(e)) return;
      const p = at(e); move(e.pointerId, p.x, p.y);
    });
    canvas.addEventListener('pointerup', e => {
      if (!finger(e)) return;
      const p = at(e); end(e.pointerId, p.x, p.y, now());
    });
    canvas.addEventListener('pointercancel', e => cancel(e.pointerId));
    window.addEventListener('blur', release);
    lockPage();
  }

  /* Prevents the page itself from scrolling under a finger.

     With the keyboard open, the visible window is smaller than the
     page, and browsers normally let the whole page be dragged around
     within that space — so a touch beside the dialogue could drag the
     entire page (village, dialogue, everything) out of view. `touch-action`
     is the standard CSS way to prevent this, but it doesn't compose the
     way needed here: `touch-action: none` on any ancestor disables
     scrolling for everything inside it, and every UI surface that needs
     this protection (the dialogue backdrop, a HUD box, a settings
     panel) contains something that legitimately needs to scroll.

     So this checks per-gesture instead of relying on CSS per-element:
     if a touch starts inside something that can genuinely scroll (a
     conversation log with overflow, a chip row taller than its
     container, any text input), the drag is allowed. Otherwise it's
     prevented. Two-finger touches are always allowed through, since
     that's a pinch-zoom gesture, and zooming text is the reader's call,
     not something this should block. */
  function lockPage() {
    if (!document || !document.querySelectorAll) return;
    const canScroll = el => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const tag = n.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true;
        const st = window.getComputedStyle ? getComputedStyle(n) : null;
        if (st && (st.overflowY === 'auto' || st.overflowY === 'scroll' ||
                   st.overflowX === 'auto' || st.overflowX === 'scroll') &&
            (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1))
          return true;
      }
      return false;
    };
    // Only these overlay elements need this guard -- the canvas already
    // uses touch-action: none, and a non-passive listener on it would
    // also incorrectly intercept every joystick drag.
    document.querySelectorAll('#hud, #dlg, .panel').forEach(surface => {
      let allowed = false;
      surface.addEventListener('touchstart', e => { allowed = canScroll(e.target); },
                               { passive: true });
      surface.addEventListener('touchmove', e => {
        if (e.touches && e.touches.length > 1) return;    // a pinch, not a drag
        if (!allowed && e.cancelable) e.preventDefault();
      }, { passive: false });
    });
  }

  /* ------------------------------------------------------------- the picture */
  /* Draws in screen space -- called after the camera transform has been
     reset, same as other fixed UI elements. */
  function draw(ctx) {
    /* No joystick to draw while a panel is open -- the canvas is still
       visible behind the dialogue card, and a joystick frozen mid-drag
       there would look like a rendering bug. */
    if (!ring || blocked()) return;
    ctx.save();
    /* The ground underneath varies between grass, dirt path, and red
       roofs, so the rim is drawn twice (dark outline, then pale outline)
       to stay visible against any of them rather than blending in. */
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, RANGE, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,20,12,.26)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(28,20,12,.28)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(253,248,236,.6)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ring.kx, ring.ky, 18, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(253,248,236,.82)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(43,33,24,.4)';
    ctx.stroke();
    ctx.restore();
  }

  return { init, draw, release,
           /* null unless a finger is actively pushing the joystick;
              otherwise {x, y}, pre-scaled so its magnitude represents
              speed, not just direction. */
           get axis() { return vec; },
           get on() { return mode; },
           /* True from the instant a double-tap's second touch lands
              until it's released — polled each frame the same way a held
              keyboard key is. */
           get runHeld() { return runHoldId !== null; },
           DEAD, RANGE, TAP_MS,
           _begin: begin, _move: move, _end: end, _cancel: cancel, _setMode: setMode,
           get _ring() { return ring; } };
})();
