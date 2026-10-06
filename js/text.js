/* text.js — the village's words as text: escaping them for the page, and
   checking and cleaning the furigana and romanization a model sends back.

   Everything here is a pure function of its arguments — no game state, no
   settings, no DOM — so any module that shows a villager's words can use
   it without depending on the conversation code that first received them.
   The checks are deliberately strict: a reading or romanization that
   doesn't match the words actually said is dropped rather than shown. */
window.LG = window.LG || {};

LG.text = (function () {
  /* Escapes text for innerHTML. Everything a villager or a model says goes
     through this or rubyHTML before reaching the page. */
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* Furigana arrives as HTML markup from the model, so all HTML is
     escaped except the ruby tag family (ruby/rb/rt/rtc/rp), which is let
     back through with attributes stripped. */
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const KANJI_G = new RegExp(KANJI.source, 'g');  // same ranges, for counting rather than testing
  // <rb> and <rtc> are part of the ruby family and models do emit them
  const RUBY_TAG = /^(?:ruby|rb|rt|rtc|rp)$/;

  /* Strips ruby markup back to plain text, permissively (any casing,
     attributes, or tag from the ruby family). Feeds only the comparison
     in rubyMatches() below — never rendered to the page. */
  function stripRuby(html) {
    return String(html)
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<rtc\b[^>]*>[\s\S]*?<\/rtc>/gi, '')
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
      .replace(/<\/?(?:ruby|rb|rt|rtc|rp)\b[^>]*>/gi, '');
  }
  /* Normalizes for comparison: loose enough to tolerate width/spacing
     differences, strict enough that we never show the player words the
     villager didn't actually say. */
  function normText(str) {
    let t = String(str);
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.replace(/\s/g, '');
  }
  function rubyMatches(ruby, say) {
    if (!ruby) return false;
    return normText(stripRuby(ruby)) === normText(say);
  }

  /* A reply may arrive wrapped in a code fence or quotes. Tries each
     plausible unwrapping and returns the first that passes validation —
     nothing unvalidated is ever accepted. */
  function usableRuby(raw, say) {
    if (!raw) return null;
    const t = String(raw).trim();
    const tries = [t];
    const unfenced = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    tries.push(unfenced);
    tries.push(unfenced.replace(/^["'`\u300c\u300e]+/, '').replace(/["'`\u300d\u300f]+$/, '').trim());
    tries.slice().forEach(c => tries.push(normaliseFurigana(c)));
    for (const cand of tries) if (rubyMatches(cand, say)) return cand;
    return null;
  }
  /* Converts bracket-style furigana (e.g. 糸[いと]) into ruby tags.

     This is a common, legitimate plain-text furigana convention, so a
     model producing it isn't malfunctioning — accepting it is simpler
     than trying to prevent it. Only converts a run of kanji immediately
     followed by a bracket containing pure kana; anything else (including
     ordinary brackets in running text) is left untouched. */
  const KANJI_RUN = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3005\\u3007\\u30f6]';
  const KANA_RUN  = '[\\u3040-\\u309f\\u30a0-\\u30ff\\u30fc]';
  const BRACKETED = new RegExp(
    '(' + KANJI_RUN + '+)' +               // the kanji
    '(' + '[\\u3040-\\u309f]{0,3}' + ')' +  // okurigana, if the word has a tail
    '\\s*[\\[\\uff3b(\\uff08\\u3010]' +   // an opening bracket of any flavour
    '(' + KANA_RUN + '+)' +                // the reading
    '[\\]\\uff3d)\\uff09\\u3011]', 'g');    // and its closer

  function normaliseFurigana(str) {
    if (!str) return str;
    return String(str).replace(BRACKETED, (m, kanji, okuri, reading) => {
      /* This bracket form covers the whole word including okurigana —
         e.g. \u7d50\u3076[\u3080\u3059\u3076] means \u7d50\u3076 is read \u3080\u3059\u3076. Ruby annotation only
         goes on the kanji itself, so the okurigana needs stripping back
         off the reading: \u7d50 gets \u3080\u3059, and \u3076 is left unannotated. If the
         reading doesn't end with the okurigana text, the split can't be
         done safely, so the whole word+okurigana gets wrapped instead. */
      if (okuri && reading.length > okuri.length &&
          reading.slice(-okuri.length) === okuri) {
        return '<ruby>' + kanji + '<rt>' + reading.slice(0, -okuri.length) + '</rt></ruby>' + okuri;
      }
      return '<ruby>' + kanji + okuri + '<rt>' + reading + '</rt></ruby>';
    });
  }

  function needsFurigana(say) { return KANJI.test(String(say)); }

  /* Detects when a villager's reply mistakenly put the target-language
     text into the English translation field. A translation full of hanzi,
     kana, or Cyrillic is worse than no translation, so it's treated as
     missing and a real one is fetched separately. */
  const NOT_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;
  function looksEnglish(str) {
    const t = String(str || '').trim();
    if (!t) return false;
    if (NOT_LATIN.test(t)) return false;
    return /[a-z]{2}/i.test(t);
  }

  /* Detects pinyin that's the wrong length for the hanzi it's supposed
     to gloss. Pinyin is genuinely Latin text — looksEnglish alone can't
     tell a well-formed roman field from one that's missing a syllable or
     has two run together, which happens without the field looking broken
     in any other way. Tone marks are stripped, then syllables are
     counted as maximal runs of vowel letters (a run like "iao" is one
     syllable, however many vowel letters it contains) — this counts
     fine whether or not multi-syllable words are joined without spaces,
     which is the normal way to write most disyllabic Mandarin words
     (e.g. "xièxie", "shénme"). Splitting on non-letters instead, so a
     word boundary counted as a syllable boundary, would misfire on
     exactly those. Mirrors tools/format-stats.js's syllableCount /
     hanziCount / erhuaCount.

     Not exact — erhua ("一点儿" -> "yìdiǎnr", one fewer syllable than
     characters, corrected for below) that's actually its own word
     ("儿子" -> "érzi", a syllable of its own instead) and reduplicated
     measure words can legitimately come out uneven — but those are rare
     enough that an occasional unnecessary repair call costs less than
     leaving a genuinely wrong count on screen. Only meaningful for a
     language pinyin actually gets checked against; callers gate on
     L.romanize (Chinese is the only one). */
  const ERHUA = /儿/g;
  function pinyinWrongLength(spoken, roman) {
    const say = String(spoken);
    const hanzi = (say.match(KANJI_G) || []).length;
    if (!hanzi) return false;
    const erhua = (say.match(ERHUA) || []).length;
    const toneless = String(roman || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/ü/g, 'v');
    const syllables = (toneless.match(/[aeiouv]+/g) || []).length;
    return Math.abs((hanzi - erhua) - syllables) > 1;
  }
  function rubyHTML(str) {
    // Keeps only ruby-family tags, stripped down to their bare form
    // (removing attributes but preserving structure); strips everything
    // else that looks like a tag.
    const bare = String(str).replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash, name) => {
      const n = name.toLowerCase();
      return RUBY_TAG.test(n) ? '<' + slash + n + '>' : '';
    });
    return escapeHTML(bare)
      .replace(/&lt;(\/?)(ruby|rb|rt|rtc|rp)&gt;/g, '<$1$2>')
      .replace(/<ruby>([\s\S]*?)<\/ruby>/g, dropKanaRuby);
  }

  /* Drops furigana readings over kana (katakana/hiragana already show
     their own pronunciation, so a reading there is redundant clutter) —
     keeps the base text, removes the annotation. */
  function dropKanaRuby(match, inner) {
    const base = String(inner)
      .replace(/<rt>[\s\S]*?<\/rt>/g, '')
      .replace(/<rp>[\s\S]*?<\/rp>/g, '')
      .replace(/<rtc>[\s\S]*?<\/rtc>/g, '')
      .replace(/<\/?(?:rb|rt|rtc|rp)>/g, '');
    return KANJI.test(base) ? match : base;
  }

  return { escapeHTML, rubyHTML, stripRuby, rubyMatches, usableRuby, normaliseFurigana,
           needsFurigana, looksEnglish, pinyinWrongLength };
})();
