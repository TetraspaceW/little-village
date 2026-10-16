/* sound.js — the notes the traveller's instruments make (see `use: 'play'`
   on LG.ITEMS).

   Each instrument is one recorded note from the FluidR3 General MIDI
   soundfont (Frank Wen, Creative Commons Attribution 3.0), as rendered to
   one MP3 per note by Benjamin Gleitzman's midi-js-soundfonts. They're
   fetched from jsDelivr the first time any instrument is played, pinned
   to one commit of that repository so the sound can't change under us,
   and kept for the rest of the session. A few tens of KB each.

   The AudioContext is made on first use, which is always a click or a
   tap, so browsers allow it to make sound. The very first note waits for
   its download; every note after is immediate. With no Web Audio or no
   network (the tests, offline), playing is silently a no-op — the log
   line and anyone hearing it still happen, in ledger.js and game.js. */
window.LG = window.LG || {};

LG.sound = (function () {
  const BASE = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@' +
               '044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM/';
  /* GM instrument and note for each voice. The bell is tubular bells up
     an octave, where it rings like a handbell; the soundfont's own
     "tinkle bell" is a click a tenth of a second long. */
  const NOTES = {
    drum:   'taiko_drum-mp3/C3.mp3',
    violin: 'violin-mp3/A4.mp3',
    guitar: 'acoustic_guitar_steel-mp3/G3.mp3',
    bell:   'tubular_bells-mp3/A5.mp3'
  };
  /* The samples come in at different levels; each is scaled so its
     loudest moment reaches PEAK, which keeps the four even. */
  const PEAK = 0.5;

  let ac = null;
  const loading = {};            // voice -> Promise of { buffer, gain }, or of null if it failed

  function context() {
    if (ac) return ac;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ac = new AC(); } catch (e) { return null; }
    return ac;
  }

  function load(a, voice) {
    if (!loading[voice]) {
      loading[voice] = fetch(BASE + NOTES[voice])
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(data => new Promise((ok, fail) => a.decodeAudioData(data, ok, fail)))
        .then(buffer => {
          let peak = 0;
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            const d = buffer.getChannelData(c);
            for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
          }
          return { buffer, gain: peak ? PEAK / peak : 1 };
        })
        .catch(() => { delete loading[voice]; return null; });   // try again next time
    }
    return loading[voice];
  }

  /* Plays one note on the named voice. Returns whether it will try to. */
  function play(voice) {
    const a = context();
    if (!a || !NOTES[voice] || typeof fetch !== 'function') return false;
    if (a.state === 'suspended' && a.resume) a.resume();
    Object.keys(NOTES).forEach(v => load(a, v));    // the rest are likely next
    load(a, voice).then(s => {
      if (!s) return;
      const src = a.createBufferSource(), g = a.createGain();
      src.buffer = s.buffer;
      g.gain.value = s.gain;
      src.connect(g).connect(a.destination);
      src.start();
    });
    return true;
  }

  return { play, voices: Object.keys(NOTES), _url: v => BASE + NOTES[v] };
})();
