/* touch.js — the village under a thumb.

   The keyboard scheme is two hands: one walks, the other presses E at whoever
   is in front of you. A phone has neither. What it has is a finger that is
   already touching the thing it means, so the two halves come apart:

     put a finger down and drag  — a joystick appears where you put it
     put a finger down and lift  — a tap, aimed at whatever is under it

   The joystick floats rather than sitting in a fixed corner, because a corner
   is wherever the designer's thumb was and never wherever yours is. It is
   drawn only once you have committed to walking, so a tap leaves no smear of
   UI behind it.

   Which of the two a touch turns out to be is not decided when it lands — it
   cannot be, they start identically — so every pointer is held as a maybe
   until it either travels past DEAD (a walk) or lifts inside TAP_MS without
   having (a tap). Anything else — a long press that never moves — is neither,
   and does nothing, which is the right answer for a finger resting on the
   glass.

   Nothing here knows what a villager is. It reports a point on the canvas and
   game.js decides what was at it; that keeps the gesture code testable without
   a village, and keeps the reach rules in one place with the ones the E key
   already obeys. */
window.LG = window.LG || {};

LG.touch = (function () {
  /* All CSS pixels — the canvas is drawn in them and fingers are measured in
     them, whatever the device pixel ratio underneath. */
  const DEAD = 12;      // travel before a maybe becomes a walk
  const RANGE = 54;     // the stick's throw: full speed at the rim
  const TAP_MS = 320;   // a maybe that lingers longer than this is neither
  const SLOW = 0.4;     // the slowest a barely-leaning finger will walk you
  const DBL_MS = 350;   // gap a second tap has to land inside to pair with the first
  const DBL_DIST = 40;  // and how far it may have landed from it

  let canvas = null;
  let blocked = () => false;          // a panel is up; the world is not listening
  let onTap = null;
  let onDoubleTap = null;
  let lastTap = null;                 // {x, y, t} of the previous tap, waiting for a partner

  /* Every finger currently on the glass, and which one of them (if any) has
     been promoted to the stick. Only the first can be — a second finger is
     free to tap while the first walks, which is the whole reason for keeping
     more than one. */
  const down = new Map();
  let stickId = null;
  let ring = null;      // where to draw it, once there is something to draw
  let vec = null;       // null in the dead zone: leaning back to centre stops you

  /* What the hints should say. A phone is assumed to be a phone before it has
     been touched, so the first thing the player reads is already right; a
     mouse arriving later says otherwise and is believed. */
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
  /* Split out from the event handlers so a test can drive them: the smoke test
     has no browser to dispatch a PointerEvent in, and the interesting parts —
     the dead zone, the origin giving way, tap versus walk — are all here. */
  function begin(id, x, y, t) {
    if (blocked()) return;
    down.set(id, { x0: x, y0: y, x: x, y: y, t0: t, moved: false });
    if (stickId === null) stickId = id;
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
    /* A tap is the gesture that did nothing else: it never became a walk and
       it did not sit there. `blocked` is asked again rather than trusted from
       when the finger landed, because what the finger did in between may have
       opened something. */
    if (p.moved || t - p.t0 > TAP_MS || blocked()) { lastTap = null; return; }
    if (onTap) onTap(x, y);
    /* A second tap landing soon enough and close enough to the last one pairs
       with it instead of starting a new wait — the pair fires once, on the
       second tap, and does not itself arm a third. Nothing here asks what got
       tapped; on a villager or a sign the first tap already opened something
       and `blocked` above catches the second before it gets this far, so the
       only place a pair actually lands is empty ground, which a single tap
       already does nothing with. */
    if (onDoubleTap && lastTap && t - lastTap.t <= DBL_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) <= DBL_DIST) {
      lastTap = null;
      onDoubleTap(x, y);
    } else {
      lastTap = { x, y, t };
    }
  }

  function cancel(id) {
    if (!down.has(id)) return;
    down.delete(id);
    if (id === stickId) hand();
  }

  /* The walking finger lifted. If another is still down it takes over, from
     wherever it happens to be — you were mid-stride and the alternative is
     stopping dead because you leaned on the screen with a second thumb. It
     starts as a maybe again, so taking over cannot itself be a tap. */
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
    /* The knob is clamped to the rim rather than dragging the origin along
       behind an overshooting finger. That used to be the trick — it saves a
       full throw of the thumb after a long walk — but it meant a stride
       forward, a step back, and a stride forward again dragged the base
       across the screen chasing its own trail, which reads as the stick
       sliding around rather than as you steering it. Speed already saturates
       at the rim (below), so nothing is lost by just pinning the knob there:
       the origin now moves only when the finger lifts and lands again. */
    const cap = len > RANGE ? RANGE / len : 1;
    ring = { x: p.x0, y: p.y0, kx: p.x0 + dx * cap, ky: p.y0 + dy * cap };
    if (len <= DEAD) { vec = null; return; }
    const push = SLOW + (1 - SLOW) * Math.min(1, (len - DEAD) / (RANGE - DEAD));
    vec = { x: (dx / len) * push, y: (dy / len) * push };
  }

  /* Everything lets go. The tab losing focus with a thumb still down is the
     case that matters — without this it comes back still walking north — and
     it is exported so a caller with its own reason can do the same. */
  function release() { down.clear(); stickId = null; ring = null; vec = null; lastTap = null; }

  /* ---------------------------------------------------------------- the wiring */
  function init(cv, hooks) {
    canvas = cv;
    blocked = (hooks && hooks.blocked) || blocked;
    onTap = (hooks && hooks.tap) || null;
    onDoubleTap = (hooks && hooks.doubleTap) || null;
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
      /* Stops the browser turning this into a scroll, a double-tap zoom, or a
         synthetic click that would toggle the same sign back off again. */
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

  /* The page itself must not move under a finger.

     With a keyboard up, the window onto the page is smaller than the page, and
     a browser will let you drag the whole thing about inside it — so touching
     beside the dialogue slides the village, the dialogue and all out from under
     you. `touch-action` is the CSS way to say no to that, but it is refused by
     intersection: a `none` anywhere above the finger kills scrolling in
     everything below it, and every surface worth pinning here — the dialogue's
     backdrop, a HUD box, a settings panel — is the ancestor of something that
     genuinely does scroll.

     So the question is answered once per gesture instead of once per element.
     If the finger came down inside something that can really scroll — a
     conversation with more of itself above, a rack of chips taller than its
     row, any box you can type in — it may. Otherwise the drag is refused.
     Two fingers are always let through, because that is a pinch, and making
     the text bigger is nobody's business but the reader's. */
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
    // Only the overlays need this guard. The canvas already uses touch-action:
    // none; a non-passive document listener also intercepts every joystick drag.
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
  /* Screen space, so this is called after the camera transform has been undone.
     Paper and ink, like the rest of the furniture. */
  function draw(ctx) {
    /* Nothing to steer while a panel is up, and the canvas shows through above
       the dialogue card — a stick frozen mid-throw up there reads as a bug. */
    if (!ring || blocked()) return;
    ctx.save();
    /* The village is grass, dirt track and red roof by turns, so the rim is
       drawn twice — dark then pale — and reads against all of them rather than
       vanishing into whichever one it happens to be over. */
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
           /* null unless a finger is actually pushing; {x, y} is already
              scaled — its length is how fast, not just which way. */
           get axis() { return vec; },
           get on() { return mode; },
           DEAD, RANGE, TAP_MS,
           _begin: begin, _move: move, _end: end, _cancel: cancel, _setMode: setMode,
           get _ring() { return ring; } };
})();
