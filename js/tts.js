/* tts.js — text-to-speech for villager dialogue, via ElevenLabs.

   Lines are generated fresh every turn, so nothing is cached — time to
   first sound is what matters. Uses Flash v2.5, the fastest model that's
   properly multilingual; its voices are cross-lingual, so one voice id
   works across all six supported languages (a villager keeps the same
   voice when the player switches, say, Russian to Japanese). */
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

  /* Voice quality varies a lot within an account. Scores voices using
     whatever signals the API's voice list actually provides; every field
     is read defensively (missing = 0 contribution, not disqualification),
     since not every voice has every field populated. */
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

  /* Order matters: "female" contains the substring "male", so a naive
     substring test for "male" would match every "female" voice too. Test
     for "female" first. */
  function normGender(raw) {
    const g = String(raw || '').toLowerCase();
    if (/female|woman|girl/.test(g)) return 'female';
    if (/male|man|boy/.test(g)) return 'male';
    return g;
  }

  /* Scores a voice against one villager's desired gender/age. Gender is
     weighted more than age (a mismatched gender is jarring; a young voice
     for an old farmer is just odd), but both are worth less than the
     quality score range above — a voice that's a slight persona mismatch
     is acceptable, a voice that's unpleasant to listen to is not. */
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

  /* Assigns each villager a distinct voice where the account has enough
     of them; reuses voices only when it doesn't. */
  function assign(list, npcs, opts) {
    const out = {};
    if (!list || !list.length) return out;
    const o = opts || {};
    const lang = o.lang ? String(o.lang).toLowerCase() : '';

    // Prefer curated voices, but fall back to the full list rather than
    // leaving villagers without voices if filtering leaves too few.
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

  /* looks up voice metadata by id, for display */
  function info(id) {
    for (let i = 0; i < catalogue.length; i++) {
      const v = catalogue[i];
      if ((v.voice_id || v.voiceId) === id) return v;
    }
    return null;
  }

  /* plays a voice's built-in preview sample — doesn't consume API credits */
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
  /* Formats an error response's body for display. A 401 from ElevenLabs
     includes a `detail` field explaining the specific problem (wrong key,
     missing permission, wrong key type) — surface it instead of just the
     status code, or there's nothing for the user to act on. */
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

  /* Must use the xi-api-key header, not Authorization: Bearer — Authorization
     is a non-simple header and ElevenLabs' CORS preflight rejects it, so a
     bearer-token request fails regardless of whether the key is valid. */
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
    turn++;                 // invalidates any in-flight request (see `mine` in speak())
    if (playing) { try { playing.pause(); } catch (e) {} playing = null; }
    if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} lastUrl = null; }
  }

  async function speak(cfg, npcId, text) {
    if (state !== 'ready' || !cfg || !cfg.key || !text) return false;
    const voice = voices[npcId] || catalogue[0] && (catalogue[0].voice_id || catalogue[0].voiceId);
    if (!voice) return false;
    stop();                                   // interrupt whatever was playing
    const mine = turn;                        // this request's id — checked below before using its result
    try {
      const res = await fetch(API + '/text-to-speech/' + voice + '/stream?output_format=' + FORMAT, {
        method: 'POST',
        headers: { 'xi-api-key': cfg.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: text,
          model_id: MODEL,
          // If left unset, the voice guesses language from the text alone,
          // which is unreliable on short lines (e.g. French read with an
          // English accent). Flash v2.5 lets us force it explicitly; our
          // language keys are already ISO 639-1 (fr, ru, ja, es, ar, zh, en).
          language_code: cfg.lang || undefined,
          voice_settings: { speed: clampSpeed(cfg.speed) }
        })
      });
      if (mine !== turn) return false;        // superseded by a newer speak() call — discard
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
        // most browsers block audio playback before the user has interacted with the page
        lastError = /NotAllowed/i.test(e.name || e.message)
          ? 'The browser blocked audio until you interact with the page — click once and try again.'
          : e.message;
        return false;
      }
      return true;
    } catch (e) {
      lastError = e.message;
      return false;                           // failure here shouldn't block the game — text still works
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
