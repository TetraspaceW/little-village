/* sound.js — plays a note on any General MIDI instrument, for the things
   in the traveller's pockets that can be played (see `use: 'play'` on
   LG.ITEMS, where each names its `gm` instrument and `note`).

   The notes are recordings from the FluidR3 General MIDI soundfont (Frank
   Wen, Creative Commons Attribution 3.0), as rendered to one MP3 per note
   by Benjamin Gleitzman's midi-js-soundfonts. Each is fetched from jsDelivr
   the first time it's played — pinned to one commit of that repository so
   the sound can't change under us — decoded once, and kept for the session.
   A few tens of KB each.

   Nothing here is tuned per instrument. The samples come in at whatever
   level the soundfont recorded them, so each is measured once it's
   decoded and brought to the same loudness: its loudest LOUD_WINDOW of
   sound (a short-term RMS, roughly how loud it seems to an ear, so a held
   violin and a single drum stroke come out alike rather than the violin
   swamping the drum), unless that would push its peak past MAX_PEAK, in
   which case the peak decides. Adding an instrument is one line in
   LG.ITEMS.

   The AudioContext is made on first use, which is always a click or a
   tap, so browsers allow it to make sound. The first note on an
   instrument waits for its download. With no Web Audio or no network (the
   tests, offline), playing is silently a no-op — the log line and anyone
   hearing it still happen, in ledger.js and game.js. */
window.LG = window.LG || {};

LG.sound = (function () {
  const BASE = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@' +
               '044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM/';
  /* The soundfont's 128 instruments, by the names it files them under —
     its names.json at that commit — so a misspelt one is caught by the
     tests rather than by a silent 404. */
  const INSTRUMENTS = (
    'acoustic_grand_piano bright_acoustic_piano electric_grand_piano honkytonk_piano ' +
    'electric_piano_1 electric_piano_2 harpsichord clavinet celesta glockenspiel music_box ' +
    'vibraphone marimba xylophone tubular_bells dulcimer drawbar_organ percussive_organ ' +
    'rock_organ church_organ reed_organ accordion harmonica tango_accordion acoustic_guitar_nylon ' +
    'acoustic_guitar_steel electric_guitar_jazz electric_guitar_clean electric_guitar_muted ' +
    'overdriven_guitar distortion_guitar guitar_harmonics acoustic_bass electric_bass_finger ' +
    'electric_bass_pick fretless_bass slap_bass_1 slap_bass_2 synth_bass_1 synth_bass_2 violin ' +
    'viola cello contrabass tremolo_strings pizzicato_strings orchestral_harp timpani ' +
    'string_ensemble_1 string_ensemble_2 synth_strings_1 synth_strings_2 choir_aahs voice_oohs ' +
    'synth_choir orchestra_hit trumpet trombone tuba muted_trumpet french_horn brass_section ' +
    'synth_brass_1 synth_brass_2 soprano_sax alto_sax tenor_sax baritone_sax oboe english_horn ' +
    'bassoon clarinet piccolo flute recorder pan_flute blown_bottle shakuhachi whistle ocarina ' +
    'lead_1_square lead_2_sawtooth lead_3_calliope lead_4_chiff lead_5_charang lead_6_voice ' +
    'lead_7_fifths lead_8_bass__lead pad_1_new_age pad_2_warm pad_3_polysynth pad_4_choir ' +
    'pad_5_bowed pad_6_metallic pad_7_halo pad_8_sweep fx_1_rain fx_2_soundtrack fx_3_crystal ' +
    'fx_4_atmosphere fx_5_brightness fx_6_goblins fx_7_echoes fx_8_scifi sitar banjo shamisen ' +
    'koto kalimba bagpipe fiddle shanai tinkle_bell agogo steel_drums woodblock taiko_drum ' +
    'melodic_tom synth_drum reverse_cymbal guitar_fret_noise breath_noise seashore bird_tweet ' +
    'telephone_ring helicopter applause gunshot'
  ).split(' ');
  const NOTE = /^[A-G]b?[0-7]$/;      // how the soundfont names its notes: C4, Eb3, Bb5
  const TARGET = 0.16;                 // short-term RMS every note is brought to
  const MAX_PEAK = 0.9;
  const LOUD_WINDOW = 0.4;             // seconds

  let ac = null;
  const loading = {};                  // "violin/A4" -> Promise of { buffer, gain }, or of null on failure

  function url(gm, note) { return BASE + gm + '-mp3/' + note + '.mp3'; }
  function known(gm, note) { return INSTRUMENTS.indexOf(gm) !== -1 && NOTE.test(note || ''); }

  function context() {
    if (ac) return ac;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ac = new AC(); } catch (e) { return null; }
    return ac;
  }

  /* How much to scale a buffer by to bring it to TARGET (see above). */
  function balance(buffer) {
    const n = buffer.length, ch = buffer.numberOfChannels, sq = new Float64Array(n + 1);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) {
        const v = data[c][i];
        s += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      sq[i + 1] = sq[i] + s / ch;        // running sum, so every window is one subtraction
    }
    const w = Math.min(n, Math.round(buffer.sampleRate * LOUD_WINDOW));
    const hop = Math.max(1, Math.round(w / 8));
    let loud = 0;
    for (let i = 0; i + w <= n; i += hop) loud = Math.max(loud, (sq[i + w] - sq[i]) / w);
    loud = Math.sqrt(loud);
    if (!peak || !loud) return 1;
    return Math.min(TARGET / loud, MAX_PEAK / peak);
  }

  function load(a, gm, note) {
    const key = gm + '/' + note;
    if (!loading[key]) {
      loading[key] = fetch(url(gm, note))
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(data => new Promise((ok, fail) => a.decodeAudioData(data, ok, fail)))
        .then(buffer => ({ buffer, gain: balance(buffer) }))
        .catch(() => { delete loading[key]; return null; });   // try again next time
    }
    return loading[key];
  }

  /* Plays `note` on General MIDI instrument `gm`. Returns whether it will try to. */
  function play(gm, note) {
    const a = context();
    if (!a || !known(gm, note) || typeof fetch !== 'function') return false;
    if (a.state === 'suspended' && a.resume) a.resume();
    load(a, gm, note).then(s => {
      if (!s) return;
      const src = a.createBufferSource(), g = a.createGain();
      src.buffer = s.buffer;
      g.gain.value = s.gain;
      src.connect(g).connect(a.destination);
      src.start();
    });
    return true;
  }

  return { play, known, url, balance, INSTRUMENTS };
})();
