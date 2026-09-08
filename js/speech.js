/* speech.js — speech input (SpeechRecognition), the natural pair to tts.js's
   speech output. Support is Chrome/Chromium only as of writing — no Firefox,
   no Safari — so this is pure progressive enhancement: index.html's mic
   button (#dlgMic) starts `hidden` and dialogue.js only ever reveals it once
   `LG.speech.available()` says yes.

   Being misheard is itself useful feedback, and it closes a loop tts.js does
   not: the villagers can already be heard, but nothing until now closed the
   pronunciation half of that. Worth knowing when tuning voices or furigana:
   readings are the weak point, not the audio — a wrong furigana reading feeds
   straight into a wrong pronunciation, so the two systems fail together. */
window.LG = window.LG || {};

LG.speech = (function () {
  // Evaluated once at load, the same way LG.touch settles what kind of
  // input this is: a browser does not grow SpeechRecognition mid-session,
  // and re-checking on every tap would just be re-asking a settled question.
  const Ctor = (typeof window !== 'undefined') &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  function available() { return !!Ctor; }

  let rec = null, listening = false;

  /* One villager, one language, one attempt at a time. `lang` is a BCP-47
     tag — the same one everything else in the game tags target-language text
     with (LANGUAGES[x].tag) — handed to the recogniser as-is; a browser that
     cannot narrow "ru" or "zh-Hans" to a specific locale itself is a browser
     this was never going to work well in anyway, and there is no dialect
     picker in this game to feed it a more specific one.

     `onResult` gets the transcript, trimmed, and nothing else — it lands in
     the composer the same way a phrase-chip click does, for the player to
     read over and send (or not), not sent on their behalf: hearing yourself
     mistranscribed is exactly the feedback this exists to give, and that is
     lost if the game acts on it before the player has seen it.
     `onEnd` fires exactly once, on success, failure or the browser simply
     giving up — whichever it is, the mic button has to stop listening. */
  function listen(lang, onResult, onEnd) {
    if (!Ctor) return false;
    stop();
    rec = new Ctor();
    rec.lang = lang || '';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    const done = () => {
      listening = false;
      rec = null;
      if (onEnd) onEnd();
    };
    rec.onresult = e => {
      const r = e && e.results && e.results[0] && e.results[0][0];
      const said = r && String(r.transcript || '').trim();
      if (said) onResult(said);
    };
    rec.onerror = done;
    rec.onend = done;
    try {
      rec.start();
      listening = true;
      return true;
    } catch (e) {
      // Most often "already started" from a double-click, or a permission
      // prompt the browser refused to show twice in one gesture — either
      // way, a silent mic that was never asked to listen is not an error
      // the player needs to see, only one the button should stop showing.
      rec = null;
      return false;
    }
  }

  function stop() {
    if (rec) {
      try { rec.stop(); } catch (e) { /* already stopped is not a problem */ }
    }
    rec = null;
    listening = false;
  }

  return {
    available,
    listen,
    stop,
    get listening() { return listening; }
  };
})();
