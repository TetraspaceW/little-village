/* config.js — the player's settings: what they are, how they persist, and
   the call configurations other modules derive from them.

   Everything that needs to know the village language, the API key or the
   model reads it from here rather than from the game module, so that a
   conversation or a save doesn't have to depend on the main loop just to
   find out which language it's in. How the settings are *edited* (the
   settings panel, the front-door gate, keys arriving from .env) is still
   game.js's business; this module only owns the values and their storage.

   `settings` is a single shared object, mutated in place, so a reference
   taken once stays current. */
window.LG = window.LG || {};

LG.config = (function () {
  const KEY = 'lg-settings';

  const settings = {
    lang: 'ru', level: 'beginner', autorun: false,
    provider: 'openrouter', apiKey: '', model: 'deepseek/deepseek-v4.1-flash', helper: '',
    /* One key per provider, so switching provider and back doesn't lose
       the other one. `apiKey` is always the current provider's entry. */
    keys: { openrouter: '', logfare: '' },
    /* These four are no longer exposed as player-facing settings —
       villager gossip is always on, translations always start blurred
       (click to reveal), voices are always cast from the curated
       library, and speech speed always matches difficulty. Kept as
       fields since other code still reads settings.npcChatter etc.;
       load() below force-resets them so an old localStorage save with
       different values can't reintroduce the removed choice. */
    showTranslation: false, npcChatter: true,
    voices: false, ttsKey: '', voiceSpeed: 'auto', voiceQuality: 'curated'
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    /* The Anthropic provider is gone. A save still pointing at it holds
       an Anthropic key and Claude model ids, neither of which means
       anything to OpenRouter -- drop them rather than send that key
       somewhere it was never meant for. */
    if (!LG.llm.MODELS[settings.provider]) {
      settings.provider = 'openrouter';
      settings.apiKey = '';
      settings.model = LG.llm.MODELS.openrouter[0].id;
      settings.helper = '';
    }
    // Keys used to be one field shared by every provider; file an old one under the provider it was saved with.
    settings.keys = Object.assign({ openrouter: '', logfare: '' }, settings.keys);
    if (settings.apiKey && !settings.keys[settings.provider]) settings.keys[settings.provider] = settings.apiKey;
    settings.apiKey = settings.keys[settings.provider] || '';
    // No longer configurable -- force these even if an old save has different values stored.
    settings.npcChatter = true;
    settings.showTranslation = false;
    settings.voiceQuality = 'curated';
    settings.voiceSpeed = 'auto';
    // Jev used to be opt-in; it's now always used on OpenRouter, so nothing reads these.
    delete settings.jevMovement;
    delete settings.jevValidation;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
  }

  /* What LG.llm's calls take. */
  function llm() {
    return { provider: settings.provider, apiKey: settings.apiKey.trim(),
             model: settings.model, helper: settings.helper };
  }

  /* What LG.tts takes. Talking speed is always derived from difficulty,
     not separately configurable. */
  function tts() {
    const speed = (LG.LEVELS[settings.level] || {}).speed || 0.85;
    return { key: settings.ttsKey.trim(), speed: speed,
             lang: settings.lang, curatedOnly: settings.voiceQuality === 'curated' };
  }

  /* The village language's entry in LG.LANGUAGES — the thing nearly every
     caller actually wants from `settings.lang`. */
  function language() { return LG.LANGUAGES[settings.lang]; }

  return { settings, load, save, llm, tts, language };
})();
