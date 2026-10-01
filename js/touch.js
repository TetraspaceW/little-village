/* touch.js — touch input: a joystick to walk and taps to act.

     touch down and drag              a joystick appears under the finger
     touch down, then lift            a tap, aimed at whatever's under it
     tap, then touch again and hold   running, for as long as it's held

   The stick appears where the touch started, since a fixed spot suits one
   hand, and only once a drag is confirmed, so a tap leaves nothing behind.
   Every touch is undecided until it moves DEAD pixels (a drag) or lifts
   within TAP_MS (a tap); a finger resting still is neither.

   This knows nothing of villagers: it reports a screen point and game.js
   decides what's there, with the same reach as the E key. */
window.LG = window.LG || {};

LG.touch = (function () {
  // In CSS pixels, as the canvas is drawn and touches are reported, whatever the pixel ratio.
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

  /* Every finger that's down, and which one drives the stick. Only one
     can; another can still tap while the first walks. */
  const down = new Map();
  let stickId = null;
  let ring = null;      // joystick draw position, set once there's something to draw
  let vec = null;       // null while in the dead zone -- returning to center stops movement

  /* Which controls the hints describe: touch is assumed on a coarse pointer
     before any input arrives, and the last kind of input used wins. */
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
  // Apart from the DOM handlers, so the tests can drive them without PointerEvents.
  function begin(id, x, y, t) {
    if (blocked()) return;
    down.set(id, { x0: x, y0: y, x: x, y: y, t0: t, moved: false });
    if (stickId === null) stickId = id;
    /* A touch soon enough and near enough after a tap is the hold of a
       double-tap-and-hold, and running starts at once; if it turns out to
       be a tap, `end` stops it again. Only possible on empty ground: a tap
       that opened something leaves `blocked()` true. */
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
    /* A tap is a touch that neither dragged nor lingered. `blocked()` is
       checked again, in case a panel opened since touch-down. */
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

  /* The stick's finger lifted: another finger still down takes over from
     where it is, rather than walking stopping dead. It starts undecided,
     so the handover can't register as a tap. */
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
    /* The knob clamps at the rim and the origin stays put: an origin that
       followed the finger crept across the screen. Speed is already full
       at the rim, so nothing is lost. */
    const cap = len > RANGE ? RANGE / len : 1;
    ring = { x: p.x0, y: p.y0, kx: p.x0 + dx * cap, ky: p.y0 + dy * cap };
    if (len <= DEAD) { vec = null; return; }
    const push = SLOW + (1 - SLOW) * Math.min(1, (len - DEAD) / (RANGE - DEAD));
    vec = { x: (dx / len) * push, y: (dy / len) * push };
  }

  // Clears every touch: a tab losing focus mid-drag would otherwise keep walking.
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
      // No scrolling, double-tap zoom, or synthetic click.
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

  /* Keeps the page from being dragged around under a finger (with a
     keyboard up, a drag beside the dialogue moved everything out of view).
     `touch-action: none` can't do it: on an ancestor it stops scrolling
     inside too, and each of these surfaces holds something that scrolls.
     So each drag is allowed only if it starts in something that can
     actually scroll or is a text input. A two-finger pinch is always let
     through. */
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
    // The overlays only: the canvas is touch-action: none, and a listener on it would catch every drag.
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
  // In screen space, after the camera transform is undone.
  function draw(ctx) {
    // Not behind a panel, where a stick frozen mid-drag would look like a glitch.
    if (!ring || blocked()) return;
    ctx.save();
    // The rim twice, dark then pale, to show on grass, path and roofs alike.
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
           // null unless the stick is pushed; {x, y} scaled to speed.
           get axis() { return vec; },
           get on() { return mode; },
           // From a double-tap's second touch until it lifts; polled like a held key.
           get runHeld() { return runHoldId !== null; },
           DEAD, RANGE, TAP_MS,
           _begin: begin, _move: move, _end: end, _cancel: cancel, _setMode: setMode,
           get _ring() { return ring; } };
})();
