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

  let canvas = null;
  let blocked = () => false;          // a panel is up; the world is not listening
  let onTap = null;

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
    if (!p.moved && t - p.t0 <= TAP_MS && onTap && !blocked()) onTap(x, y);
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
    let dx = p.x - p.x0, dy = p.y - p.y0;
    let len = Math.hypot(dx, dy);
    /* A finger that runs past the rim drags the origin along behind it. Without
       this the stick is pinned to where you first touched, so walking the
       length of the high street and then turning means dragging all the way
       back across the dead zone before anything happens. */
    if (len > RANGE) {
      const back = 1 - RANGE / len;
      p.x0 += dx * back; p.y0 += dy * back;
      dx = p.x - p.x0; dy = p.y - p.y0; len = RANGE;
    }
    ring = { x: p.x0, y: p.y0, kx: p.x, ky: p.y };
    if (len <= DEAD) { vec = null; return; }
    const push = SLOW + (1 - SLOW) * Math.min(1, (len - DEAD) / (RANGE - DEAD));
    vec = { x: (dx / len) * push, y: (dy / len) * push };
  }

  /* Everything lets go. The tab losing focus with a thumb still down is the
     case that matters — without this it comes back still walking north — and
     it is exported so a caller with its own reason can do the same. */
  function release() { down.clear(); stickId = null; ring = null; vec = null; }

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
           _begin: begin, _move: move, _end: end, _cancel: cancel,
           get _ring() { return ring; } };
})();
