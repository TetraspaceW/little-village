/* settings-panel.js — the settings panel, and the front door it doubles
   as: what the player sees before they're let into the village, and the
   way back to change language, difficulty, model or keys afterwards.

   It owns the gate (nothing in the village responds until a working key
   has been given), checks a key before accepting it, keeps a half-typed
   key per provider while the player flips between them, picks up keys
   from the log server's .env, and casts voices once a voice key arrives.
   The values themselves live in LG.config; this module is only how they
   get edited.

   Some settings changes mean a different village. The panel doesn't build
   villages itself — it's handed `newVillage` by the game in `init`. */
window.LG = window.LG || {};

LG.settingsPanel = (function () {
  const C = LG.config, settings = C.settings;
  const { log } = LG.ledger;
  const renderHUD = LG.ledger.render;
  let newVillage = () => {};

  // `gated` blocks input until settings (incl. API key) are confirmed via the front-door panel.
  let gated = true, gateMode = false, lastValidated = '';
  let fromEnv = false;             // true if keys came from the log server's .env, not typed by the user
  // The settings panel's unsaved key per provider, and which provider the key box is showing right now.
  let draftKeys = {}, keyProvider = '';

  /* Wires the panel's own controls. `hooks.newVillage(seed, quiet)` rolls
     a fresh village, for when a change of settings calls for one. */
  function init(hooks) {
    newVillage = hooks.newVillage;
    document.getElementById('btnSettings').onclick = () => openSettings(false);
    document.getElementById('setNew').onclick = () => submitSettings(true);
    document.getElementById('setForget').onclick = () => {
      LG.save.forget();
      log('\u00a4 The saved village has been forgotten. This one goes on until you start another.');
      showSaveNote();
    };
    // Not `= submitSettings`: the click event would arrive as a truthy forceNewVillage.
    document.getElementById('setSave').onclick = () => submitSettings(false);
    document.getElementById('setProvider').onchange = () => { swapKeyField(); refreshModelList(); refreshHelperList(); };
    document.getElementById('setModel').onchange = syncModelBox;
    document.getElementById('setHelper').onchange = syncHelperBox;
  }

  /* Decides whether the player is let straight in (a key is already
     saved) or met at the front door, then looks for keys in .env. */
  function start() {
    if (settings.apiKey) { gated = false; LG.llm.probe(C.llm()); }
    else { openSettings(true); }
    showChrome();
    loadVoices();
    adoptEnv();
  }

  /* Lets the player in without a key -- for console debugging and for
     tests. Also un-hides the HUD, not just clearing the gate flag. */
  function openTheDoor() {
    gated = false;
    document.getElementById('settings').classList.remove('open');
    showChrome();
  }

  /* Fetches API keys from the log server's .env, if it's running.

     The settings panel normally requires the player to paste a key,
     since a plain web page can't read a local file. The log server can,
     though, so if it's running with a .env configured, this can populate
     the key automatically and skip that step. Called after startup
     rather than blocking on it, so a missing or slow server never delays
     the game -- the settings gate stays up regardless, and closes itself
     automatically if a key arrives. */
  function adoptEnv() {
    if (typeof fetch !== 'function') return;
    if (typeof location === 'undefined' || !/^https?:/.test(location.protocol)) return;
    fetch('/env', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(env => { if (env) useEnv(env); })
      .catch(() => {});                       // no server, or not that sort of server
  }

  function useEnv(env) {
    const was = { lang: settings.lang, level: settings.level };
    if (LG.llm.MODELS[env.provider]) settings.provider = env.provider;
    if (env.openrouterKey) settings.keys.openrouter = env.openrouterKey;
    if (env.logfareKey) settings.keys.logfare = env.logfareKey;
    settings.apiKey = settings.keys[settings.provider] || '';
    let got = [];
    if ({ openrouter: env.openrouterKey, logfare: env.logfareKey }[settings.provider]) got.push('the model key');
    if (env.ttsKey) { settings.ttsKey = env.ttsKey; settings.voices = true; got.push('a voice key'); }
    if (env.model) settings.model = env.model;
    if (env.helper) settings.helper = env.helper;
    if (env.lang && LG.LANGUAGES[env.lang]) settings.lang = env.lang;
    if (env.level && LG.LEVELS[env.level]) settings.level = env.level;
    if (!got.length && was.lang === settings.lang && was.level === settings.level) return;

    fromEnv = true;
    C.save();
    /* The village is generated from language + difficulty, so changing
       either normally means regenerating it -- fine, since nothing has
       happened yet in a fresh session. Except when a village was already
       resumed from a save: that's an in-progress playthrough, and .env
       settings arriving late shouldn't discard it. In that case, keep
       the resumed village's own language/difficulty instead. */
    if (was.lang !== settings.lang || was.level !== settings.level) {
      if (LG.save.resumed) { settings.lang = was.lang; settings.level = was.level; }
      else newVillage(null, true);
    }
    if (settings.apiKey && gated) {
      gated = false; gateMode = false;
      document.getElementById('settings').classList.remove('open');
    }
    showChrome();
    renderHUD();
    if (settings.voices && settings.ttsKey) loadVoices();
    log('\u00a4 Read ' + got.join(' and ') + ' from .env.');
  }

  /* Tucks away whatever is in the key box under the provider it was
     typed for, and shows the newly picked provider's key instead -- so
     a Logfare key survives a detour through OpenRouter and back. */
  function swapKeyField() {
    const field = document.getElementById('setKey');
    draftKeys[keyProvider] = field.value.trim();
    keyProvider = document.getElementById('setProvider').value;
    field.value = draftKeys[keyProvider] || '';
  }

  async function submitSettings(forceNewVillage) {
    const btn = document.getElementById('setSave');
    const newBtn = document.getElementById('setNew');
    const err = document.getElementById('setError');
    swapKeyField();                // files the key box under its provider; a no-op swap otherwise
    const next = {
      lang: document.getElementById('setLang').value,
      level: document.getElementById('setLevel').value,
      autorun: document.getElementById('setAutorun').checked,
      provider: document.getElementById('setProvider').value,
      apiKey: document.getElementById('setKey').value.trim(),
      keys: Object.assign({}, draftKeys),
      model: readModel() || settings.model,
      helper: readHelper(),
      // No longer player-configurable: gossip is always on, translations
      // always start blurred, voices are always curated, and speech
      // speed always matches difficulty.
      showTranslation: false,
      npcChatter: true,
      voices: document.getElementById('setVoices').checked,
      ttsKey: document.getElementById('setTtsKey').value.trim(),
      voiceSpeed: 'auto',
      voiceQuality: 'curated'
    };
    err.textContent = '';

    // Skip re-validating the key when the provider/key/model haven't changed.
    const stamp = next.provider + '|' + next.apiKey + '|' + next.model;
    if (stamp !== lastValidated) {
      btn.disabled = true;
      newBtn.disabled = true;
      btn.textContent = 'Checking your key…';
      try {
        await LG.llm.validate({ provider: next.provider, apiKey: next.apiKey, model: next.model });
        lastValidated = stamp;
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
        newBtn.disabled = false;
        btn.textContent = gateMode ? 'Enter the village' : 'Save';
        return;
      }
      btn.disabled = false;
      newBtn.disabled = false;
    }

    const levelChanged = next.level !== settings.level;
    const voiceChanged = next.voices !== settings.voices || next.ttsKey !== settings.ttsKey;
    Object.assign(settings, next);
    C.save();
    // Structured-output support depends on the provider/model pair -- re-probe on any settings change.
    LG.llm.probe(C.llm());
    document.getElementById('settings').classList.remove('open');
    btn.textContent = 'Save';
    renderHUD();

    if (voiceChanged) { LG.tts.stop(); loadVoices(); }

    if (gateMode) {
      gated = false;
      gateMode = false;
      showChrome();
      /* Passing through the front door used to always roll a new
         village -- correct on a first visit, but wrong when resuming a
         save: the player would return to their saved village, type in
         their key, and watch it get replaced. A changed difficulty is a
         genuinely different village, so that still rolls a new one. */
      if (LG.save.resumed && !levelChanged) LG.save.write();
      else newVillage(null, true);
      document.getElementById('help').classList.add('open');
    } else if (levelChanged) {
      log('A different sort of errand, then.');
      newVillage();
    } else if (forceNewVillage) {
      newVillage();
    } else {
      log('The villagers now speak ' + C.language().name + '.');
    }
  }

  /* Casting villager voices takes one API request -- done here, while
     the player is likely reading the help panel, rather than waiting
     until they first talk to a villager. */
  function loadVoices() {
    if (!settings.voices || !settings.ttsKey) return;
    LG.tts.load(C.tts()).then(ok => {
      if (ok) log('🔊 The villagers have found their voices.');
      else log('🔊 No voices: ' + LG.tts.error);
    });
  }

  /* Hides the HUD while gated -- it's just visual noise behind the title screen. */
  function showChrome() {
    document.getElementById('hud').style.display = gated ? 'none' : '';
  }

  function openSettings(asGate) {
    gateMode = !!asGate;
    const s = document.getElementById('settings');
    document.getElementById('setTitle').textContent = gateMode ? 'Little Village' : 'Settings';
    document.getElementById('setLede').style.display = gateMode ? '' : 'none';
    document.getElementById('setNew').style.display = gateMode ? 'none' : '';
    document.getElementById('setSave').textContent = gateMode ? 'Enter the village' : 'Save';
    document.getElementById('setError').textContent = '';
    document.getElementById('setLang').value = settings.lang;
    document.getElementById('setLevel').value = settings.level;
    document.getElementById('setAutorun').checked = settings.autorun;
    document.getElementById('setProvider').value = settings.provider;
    draftKeys = Object.assign({}, settings.keys);
    keyProvider = settings.provider;
    document.getElementById('setKey').value = draftKeys[keyProvider] || '';
    // Shows where the key came from, so a pre-filled field isn't a mystery to the player.
    const note = document.getElementById('setKeyNote');
    if (note) {
      note.textContent = fromEnv ? 'filled from .env — type over it to change it for this session' : '';
      note.style.display = fromEnv ? '' : 'none';
    }
    document.getElementById('setVoices').checked = settings.voices;
    document.getElementById('setTtsKey').value = settings.ttsKey;
    refreshModelList();
    refreshHelperList();
    showSaveNote();
    s.classList.add('open');
  }

  /* Displays the current save status in one line. Autosaving is
     silent by design (a message every 20 seconds would be noisy) --
     this is the only place that tells the player their progress is
     being saved, and where. */
  function showSaveNote() {
    const note = document.getElementById('setSaveNote');
    const btn = document.getElementById('setForget');
    if (!note || !btn) return;
    const have = LG.save.has();
    btn.disabled = !have;
    if (!have && LG.save.forgotten) { note.textContent = 'Forgotten — this village is no longer being saved. A new village will be.'; return; }
    if (!have) { note.textContent = 'Nothing saved yet — the village is written down every few seconds once you are in it.'; return; }
    const when = LG.save.lastAt
      ? 'last written ' + new Date(LG.save.lastAt).toLocaleTimeString()
      : 'kept from an earlier session';
    note.textContent = 'This village is saved in this browser (' + when +
      ')' + (LG.save.onServer ? ' and in saves/village.json' : '') + '.';
  }

  /* "Other" reveals a free-text box, so a model newer than this
     picker's hardcoded list can still be used without editing the
     source. */
  function readModel() {
    const sel = document.getElementById('setModel');
    if (sel.value !== 'other') return sel.value;
    return document.getElementById('setModelCustom').value.trim();
  }

  function readHelper() {
    const sel = document.getElementById('setHelper');
    if (sel.value !== 'other') return sel.value;
    return document.getElementById('setHelperCustom').value.trim();
  }

  function refreshHelperList() {
    const prov = document.getElementById('setProvider').value;
    const sel = document.getElementById('setHelper');
    const list = LG.llm.HELPERS[prov] || [];
    // Logfare has exactly one model and always picks it — nothing to override.
    const fixed = prov === 'logfare';
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + (fixed ? '' : '<option value="other">Other — type an id below</option>');
    sel.disabled = fixed;
    const known = list.some(m => m.id === settings.helper);
    sel.value = fixed ? list[0].id
              : settings.helper && !known ? 'other' : (settings.helper || (list[0] && list[0].id) || 'other');
    document.getElementById('setHelperCustom').value = fixed || known ? '' : settings.helper;
    syncHelperBox();
  }

  function syncHelperBox() {
    const other = document.getElementById('setHelper').value === 'other';
    document.getElementById('setHelperCustom').style.display = other ? '' : 'none';
  }

  function refreshModelList() {
    const prov = document.getElementById('setProvider').value;
    const sel = document.getElementById('setModel');
    const list = LG.llm.MODELS[prov] || [];
    // Logfare has exactly one model and always picks it — nothing to override.
    const fixed = prov === 'logfare';
    sel.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.label + '</option>').join('')
      + (fixed ? '' : '<option value="other">Other — type an id below</option>');
    sel.disabled = fixed;
    const known = list.some(m => m.id === settings.model);
    sel.value = fixed ? list[0].id
              : settings.model && !known ? 'other' : (settings.model || (list[0] && list[0].id) || 'other');
    document.getElementById('setModelCustom').value = fixed || known ? '' : settings.model;
    syncModelBox();
    document.getElementById('keyHint').textContent = prov === 'logfare'
      ? 'From logfare.ai/register — free and instant, no email needed.'
      : 'From openrouter.ai/keys.';
  }

  function syncModelBox() {
    const other = document.getElementById('setModel').value === 'other';
    document.getElementById('setModelCustom').style.display = other ? '' : 'none';
  }

  return { init, start, open: openSettings, openTheDoor,
           get gated() { return gated; } };
})();
