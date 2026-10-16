/* sound.js — the notes the traveller's instruments make (see `use: 'play'`
   on LG.ITEMS).

   There are no sound files: each instrument is synthesized when it's
   played, from what makes that instrument sound like itself — a skin
   whose pitch drops as it settles, a bowed string with vibrato, a
   plucked string (Karplus–Strong: a burst of noise fed round a delay
   line one period long, softened a little each time round, which is
   very nearly what a real string does), and a bell's partials, which
   aren't harmonics of one another and die away at different rates.
   A General MIDI note would need a soundfont downloading first; this
   needs nothing.

   The AudioContext is made on first use, which is always a click or a
   tap, so browsers allow it to make sound. With no Web Audio at all
   (the tests, an old browser), playing is silently a no-op. */
window.LG = window.LG || {};

LG.sound = (function () {
  const VOLUME = 0.35;
  let ac = null, out = null;

  function context() {
    if (ac) return ac;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ac = new AC(); } catch (e) { return null; }
    out = ac.createGain();
    out.gain.value = VOLUME;
    out.connect(ac.destination);
    return ac;
  }

  /* An envelope: up to `peak` over `attack` seconds, then an exponential
     fall to silence by `end`. */
  function envelope(g, t, peak, attack, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + end);
  }

  function noise(a, seconds) {
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * seconds), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* A floor tom: the skin starts high and drops as the tension evens
     out, under a short slap of filtered noise from the stick. */
  function drum(a, t) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(58, t + 0.35);
    envelope(g, t, 1, 0.004, 0.7);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.75);

    const n = a.createBufferSource(), f = a.createBiquadFilter(), ng = a.createGain();
    n.buffer = noise(a, 0.12);
    f.type = 'lowpass'; f.frequency.value = 1800;
    envelope(ng, t, 0.5, 0.002, 0.09);
    n.connect(f).connect(ng).connect(out);
    n.start(t);
  }

  /* An A on the violin: a bright sawtooth (a bowed string's own
     waveform is very near one) through the resonances of a wooden body,
     bowed in rather than struck, with vibrato arriving a moment after
     the note starts, the way a player's does. */
  function violin(a, t) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sawtooth';
    o.frequency.value = 440;
    const lfo = a.createOscillator(), depth = a.createGain();
    lfo.frequency.value = 5.6;
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(5, t + 0.45);
    lfo.connect(depth).connect(o.frequency);

    const body = a.createBiquadFilter(), bright = a.createBiquadFilter(), top = a.createBiquadFilter();
    body.type = 'peaking'; body.frequency.value = 290; body.Q.value = 2; body.gain.value = 8;
    bright.type = 'peaking'; bright.frequency.value = 2600; bright.Q.value = 1.5; bright.gain.value = 6;
    top.type = 'lowpass'; top.frequency.value = 5200;

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.14);
    g.gain.setValueAtTime(0.45, t + 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(body).connect(bright).connect(top).connect(g).connect(out);
    o.start(t); lfo.start(t);
    o.stop(t + 1.45); lfo.stop(t + 1.45);
  }

  /* An open G string, plucked. */
  function guitar(a, t) {
    const rate = a.sampleRate, seconds = 2.6, period = Math.round(rate / 196);
    const buf = a.createBuffer(1, Math.ceil(rate * seconds), rate), d = buf.getChannelData(0);
    /* The pluck: noise, softened twice over (a finger is not a razor, so
       the low harmonics should come out on top), with its average taken
       off — any offset left in would go round the string for ever as a
       silent DC hum, eating the headroom. */
    for (let i = 0; i < period; i++) d[i] = Math.random() * 2 - 1;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < period; i++) d[i] = (d[(i + period - 1) % period] + d[i] + d[(i + 1) % period]) / 3;
    let mean = 0;
    for (let i = 0; i < period; i++) mean += d[i] / period;
    for (let i = 0; i < period; i++) d[i] = (d[i] - mean) * 1.5;
    for (let i = period; i < d.length; i++) d[i] = 0.996 * 0.5 * (d[i - period] + d[i - period + 1]);
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = buf;
    f.type = 'lowpass'; f.frequency.value = 3200;
    g.gain.value = 1.1;
    s.connect(f).connect(g).connect(out);
    s.start(t);
  }

  /* A handbell. The partials are a real bell's: the hum an octave below
     the note, the note, a minor third, a fifth, the octave and the
     upper partials — not a harmonic series, which is what makes it a
     bell and not an organ — each fading at its own pace, the low ones
     ringing longest. */
  function bell(a, t) {
    const base = 880;
    [[0.5, 0.26, 3.2], [1, 0.45, 2.6], [1.19, 0.22, 2.0], [1.5, 0.15, 1.6],
     [2, 0.19, 1.4], [2.74, 0.09, 0.9], [3.76, 0.06, 0.6], [5.4, 0.04, 0.35]].forEach(([r, peak, end]) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine';
      o.frequency.value = base * r;
      envelope(g, t, peak, 0.003, end);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + end + 0.05);
    });
  }

  const VOICES = { drum, violin, guitar, bell };

  /* Plays one note on the named voice. Returns whether it could. */
  function play(voice) {
    const a = context(), v = VOICES[voice];
    if (!a || !v) return false;
    if (a.state === 'suspended' && a.resume) a.resume();
    v(a, a.currentTime + 0.01);
    return true;
  }

  return { play, voices: Object.keys(VOICES) };
})();
