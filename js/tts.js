/* tts.js — giving the villagers voices (ElevenLabs).

   Lines are generated fresh every turn, so there is nothing worth caching —
   what matters is time to first sound. Flash v2.5 is the quickest model that is
   properly multilingual, and its voices are cross-lingual: one voice id speaks
   all six of our languages, so Boris keeps his voice when you switch from
   Russian to Japanese. */
window.LG = window.LG || {};

LG.tts = (function () {
  const API = 'https://api.elevenlabs.io/v1';
  const MODEL = 'eleven_flash_v2_5';
  const SPEED_MIN = 0.7, SPEED_MAX = 1.2;   // the range the API accepts
  const FORMAT = 'mp3_22050_32';        // small and quick; plenty for speech

  let voices = {};          // npcId -> voice id
  let catalogue = [];       // whatever the account has available
  let state = 'off';        // off | loading | ready | error
  let lastError = '';
  let playing = null;       // the Audio currently talking
  let lastUrl = null;
  let turn = 0;             // bumped whenever a new line starts

  /* ------------------------------------------------------- voice casting */
  function label(v, key) {
    const l = (v && v.labels) || {};
    return String(l[key] || '').toLowerCase();
  }

  /* Quality varies enormously across an account. These are the signals the voice
     list actually carries; every one is read defensively, because a field that is
     absent should cost a voice nothing rather than disqualify it. */
  const CURATED = { premade: 1, professional: 1 };

  function isCurated(v) {
    return !!CURATED[String((v && v.category) || '').toLowerCase()];
  }

  function quality(v, lang) {
    let q = 0;
    const cat = String((v && v.category) || '').toLowerCase();
    if (cat === 'professional') q += 6;          // professionally cloned
    else if (cat === 'premade') q += 5;          // the curated library
    else if (cat === 'generated') q += 1;        // voice design output
    else if (cat === 'cloned') q += 0;           // instant clones: the variable ones

    // a voice with a fine-tuned high-quality base is a better bet
    const hq = (v && v.high_quality_base_model_ids) || [];
    if (hq.length) q += 2;
    if (hq.indexOf && hq.indexOf(MODEL) !== -1) q += 2;

    // and one the account has verified for *this* language is a much better bet
    const verified = (v && v.verified_languages) || [];
    if (lang && verified.length) {
      const hit = verified.some(x => String((x && (x.language || x.locale)) || x)
        .toLowerCase().indexOf(lang) === 0);
      q += hit ? 4 : -1;
    }

    // popularity, where the list carries it, breaks ties sensibly
    const sh = (v && v.sharing) || {};
    if (Number(sh.liked_by_count) > 0) q += 1;
    if (Number(sh.cloned_by_count) > 100) q += 1;
    return q;
  }

  /* Note the ordering: "female" contains "male", so anything looking for a
     substring here casts every woman as a man. Test female first, compare exactly. */
  function normGender(raw) {
    const g = String(raw || '').toLowerCase();
    if (/female|woman|girl/.test(g)) return 'female';
    if (/male|man|boy/.test(g)) return 'male';
    return g;
  }

  /* Score a voice against the villager we are casting. Gender counts for more
     than age — a young voice for an old farmer is odd, the wrong gender is
     jarring. */
  /* Gender is a gentle nudge, deliberately worth less than the quality range: a
     villager whose voice does not match how they are written is fine, a villager
     who is unpleasant to listen to is not. */
  function score(voice, want, lang) {
    let s = quality(voice, lang);
    const g = normGender(label(voice, 'gender')), a = label(voice, 'age');
    if (want.gender && g) s += (g === normGender(want.gender)) ? 2 : 0;
    if (want.age && a) {
      if (a.indexOf(want.age) !== -1) s += 2;
      else if (want.age === 'old' && a.indexOf('middle') !== -1) s += 1;
      else if (want.age === 'young' && a.indexOf('middle') !== -1) s += 1;
    }
    return s;
  }

  /* Deterministic casting: every villager gets a distinct voice where the
     account has enough of them, otherwise voices get reused. */
  function assign(list, npcs, opts) {
    const out = {};
    if (!list || !list.length) return out;
    const o = opts || {};
    const lang = o.lang ? String(o.lang).toLowerCase() : '';

    // Prefer the curated categories, but never leave villagers mute over it: if
    // filtering does not leave enough distinct voices, fall back to the lot.
    let pool = list;
    if (o.curatedOnly) {
      const curated = list.filter(isCurated);
      if (curated.length >= Math.min(npcs.length, 2)) pool = curated;
    }

    const taken = {};
    npcs.forEach(npc => {
      const want = npc.voice || {};

      let best = null, bestScore = -Infinity;
      pool.forEach(v => {
        const id = v.voice_id || v.voiceId;
        if (!id) return;
        const s = score(v, want, lang) - (taken[id] ? 100 : 0);   // reuse only as a last resort
        if (s > bestScore) { bestScore = s; best = id; }
      });
      if (best) { out[npc.id] = best; taken[best] = true; }
    });
    return out;
  }

  /* what got cast, for showing the player */
  function info(id) {
    for (let i = 0; i < catalogue.length; i++) {
      const v = catalogue[i];
      if ((v.voice_id || v.voiceId) === id) return v;
    }
    return null;
  }

  /* audition a voice using the sample the list ships with — no credits spent */
  function preview(id) {
    const v = info(id);
    const url = v && (v.preview_url || v.previewUrl);
    if (!url) return false;
    stop();
    try {
      const audio = new Audio(url);
      playing = audio;
      audio.onended = () => { if (playing === audio) stop(); };
      audio.play();
      return true;
    } catch (e) { return false; }
  }

  /* --------------------------------------------------------- the catalogue */
  /* Whatever the server said, say it back. A 401 from ElevenLabs carries a
     `detail` explaining which of "wrong key", "missing permission" or "wrong
     kind of key" it was, and swallowing that leaves nothing to act on. */
  async function describe(res) {
    let body = '';
    try { body = await res.text(); } catch (e) {}
    let detail = '';
    try {
      const j = JSON.parse(body);
      const d = j.detail !== undefined ? j.detail : j;
      detail = typeof d === 'string' ? d
             : (d && (d.message || d.status)) ? [d.status, d.message].filter(Boolean).join(': ')
             : JSON.stringify(d);
    } catch (e) { detail = body.slice(0, 200); }
    return res.status + (detail ? ' — ' + detail : '');
  }

  /* Only xi-api-key works from a browser: Authorization is a non-simple header
     and ElevenLabs' preflight refuses it, so a bearer retry can only ever fail
     in a way that says nothing about the key. */
  function tryList(key) {
    return fetch(API + '/voices', { headers: { 'xi-api-key': key } });
  }

  async function load(cfg) {
    if (!cfg || !cfg.key) { state = 'off'; lastError = 'No ElevenLabs key.'; return false; }
    state = 'loading';
    let res;
    try { res = await tryList(cfg.key); }
    catch (e) {
      state = 'error';
      lastError = 'Could not reach ElevenLabs — ' + e.message +
        '. If this page is open as a file, serve it over http instead.';
      return false;
    }
    if (!res.ok) {
      state = 'error';
      lastError = await describe(res);
      if (typeof console !== 'undefined' && console.warn) console.warn('[voices] ' + lastError);
      return false;
    }
    try {
      const data = await res.json();
      catalogue = data.voices || data || [];
      voices = assign(catalogue, LG.NPCS, { lang: cfg.lang, curatedOnly: cfg.curatedOnly });
      state = Object.keys(voices).length ? 'ready' : 'error';
      lastError = state === 'ready'
        ? 'Cast ' + Object.keys(voices).length + ' voices from ' + catalogue.length +
          ' available (' + catalogue.filter(isCurated).length + ' curated).'
        : 'That account has no voices to cast.';
      return state === 'ready';
    } catch (e) {
      state = 'error';
      lastError = 'Could not read the voice list — ' + e.message;
      return false;
    }
  }

  function clampSpeed(v) {
    const n = Number(v);
    if (!isFinite(n)) return 1;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
  }

  /* ------------------------------------------------------------- speaking */
  function stop() {
    turn++;                 // anything already in flight is now stale
    if (playing) { try { playing.pause(); } catch (e) {} playing = null; }
    if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} lastUrl = null; }
  }

  async function speak(cfg, npcId, text) {
    if (state !== 'ready' || !cfg || !cfg.key || !text) return false;
    const voice = voices[npcId] || catalogue[0] && (catalogue[0].voice_id || catalogue[0].voiceId);
    if (!voice) return false;
    stop();                                   // a new line interrupts the old one
    const mine = turn;                        // ...and makes any earlier fetch stale
    try {
      const res = await fetch(API + '/text-to-speech/' + voice + '/stream?output_format=' + FORMAT, {
        method: 'POST',
        headers: { 'xi-api-key': cfg.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: text,
          model_id: MODEL,
          voice_settings: { speed: clampSpeed(cfg.speed) }
        })
      });
      if (mine !== turn) return false;        // a newer line started; drop this one
      if (!res.ok) { lastError = 'speech ' + (await describe(res)); return false; }
      const blob = await res.blob();
      if (mine !== turn) return false;
      const url = URL.createObjectURL(blob);
      lastUrl = url;
      const audio = new Audio(url);
      playing = audio;
      audio.onended = () => { if (playing === audio) stop(); };
      try {
        await audio.play();
      } catch (e) {
        // browsers refuse audio until the page has been interacted with
        lastError = /NotAllowed/i.test(e.name || e.message)
          ? 'The browser blocked audio until you interact with the page — click once and try again.'
          : e.message;
        return false;
      }
      return true;
    } catch (e) {
      lastError = e.message;
      return false;                           // a silent villager is still playable
    }
  }

  return {
    load, speak, stop, assign, clampSpeed, quality, isCurated, info, preview,
    get state() { return state; },
    get error() { return lastError; },
    get voices() { return voices; },
    get catalogue() { return catalogue; }
  };
})();
