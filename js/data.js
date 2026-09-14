/* data.js — static game data: languages, phrasebook, item pool, places,
   and the villager roster.
   The errand chain itself is generated at runtime; see chain.js.
   Plain <script> tags (no ES modules), so the game can be run by opening
   index.html directly as a file:// URL. */
window.LG = window.LG || {};

/* `tag` and `romanTag` are BCP-47 codes, used in the `lang` attribute
   wherever a villager's words appear on the page. A font stack is a
   rendering preference; `lang` is the actual fact the browser needs — Han
   characters are shared between Chinese and Japanese but rendered
   differently in each, so an untagged 直 could render with either
   language's glyph shapes depending on browser default. `lang` also
   drives the line breaker, spellchecker, IME, and screen reader — none of
   which a font stack alone can inform.

   `zh-Hans` rather than plain `zh`, since the village writes simplified
   Chinese and `zh` alone leaves the script ambiguous. The `-Latn` suffix
   marks a romanization as what it is — the same language, written in
   Latin letters. Pinyin is still Chinese, just not in Chinese script;
   tagging it `en` would incorrectly invite an English spellchecker to
   flag every syllable. */
LG.LANGUAGES = {
  ru: {
    name: 'Russian', native: 'Русский', flag: '🇷🇺',
    tag: 'ru', romanTag: 'ru-Latn',
    romanize: false, romanLabel: 'transliteration',
    fontStack: "'Noto Sans', system-ui, sans-serif"
  },
  en: {
    name: 'English', native: 'English', flag: '🇬🇧',
    tag: 'en', romanTag: 'en',
    romanize: false, fontStack: "system-ui, sans-serif"
  },
  zh: {
    name: 'Chinese (Mandarin)', native: '中文', flag: '🇨🇳',
    tag: 'zh-Hans', romanTag: 'zh-Latn',
    romanize: true, romanLabel: 'pinyin',
    // Asking for plain "pinyin" produced inconsistent tone-mark coverage across syllables.
    romanNote: 'with tone marks on every syllable \u2014 n\u01d0 h\u01ceo, not ni hao',
    fontStack: "'Noto Sans SC', system-ui, sans-serif"
  },
  ja: {
    name: 'Japanese', native: '日本語', flag: '🇯🇵',
    tag: 'ja', romanTag: 'ja-Latn',
    furigana: true,
    fontStack: "'Noto Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', system-ui, sans-serif"
  },
  fr: {
    name: 'French', native: 'Français', flag: '🇫🇷',
    tag: 'fr', romanTag: 'fr',
    romanize: false, fontStack: "system-ui, sans-serif"
  },
  es: {
    name: 'Spanish', native: 'Español', flag: '🇪🇸',
    tag: 'es', romanTag: 'es',
    romanize: false, fontStack: "system-ui, sans-serif"
  },
  pl: {
    name: 'Polish', native: 'Polski', flag: '🇵🇱',
    tag: 'pl', romanTag: 'pl',
    romanize: false, fontStack: "system-ui, sans-serif"
  },
  ar: {
    // Standard Arabic isn't a country, so there's no Unicode flag
    // sequence or emoji-font glyph for it. `flag` holds U+F0000 instead,
    // a private-use codepoint that a custom one-glyph font (see
    // css/style.css's @font-face and tools/flags/README.md) maps to a
    // custom flag glyph styled to match Noto Color Emoji. Elsewhere this
    // string is just inserted into the DOM as text.
    // Overridden below on Gecko, where that glyph doesn't render inside
    // #setLang's dropdown popup.
    name: 'Arabic (MSA)', native: 'العربية', flag: '\u{F0000}',
    tag: 'ar', romanTag: 'ar',
    // Bare Arabic script has no short vowels, so an unvocalized
    // sentence is only legible to someone who already half-knows the
    // word — no help to a learner. zh and ja solve this with a separate
    // Latin romanization line; Arabic instead has tashkeel, the
    // diacritics used in children's books, the Qur'an, and learner texts
    // (and omitted everywhere else). That's the native solution, not a
    // transliteration bolted on — so `romanize` stays off, and
    // `diacritics` (below) requests full tashkeel on the Arabic text
    // itself, the same role furigana plays for kanji: annotation on the
    // actual script, not a second script alongside it.
    romanize: false,
    diacritics: true,
    // Right-to-left is a property of the script itself, same as `tag`
    // and `fontStack` — css/style.css sets it via a `[lang="ar"]` CSS
    // rule, so any span already tagged with L.tag gets it automatically.
    fontStack: "'Noto Naskh Arabic', 'Noto Sans Arabic', system-ui, sans-serif"
  },
  tok: {
    // Both `name` and `native` are lowercase deliberately — toki pona is
    // always written lowercase by its speakers, including at the start
    // of a sentence or in a title. `name` is what the settings UI and
    // log display, so capitalizing it here would misspell the language's
    // own name.
    //
    // Like Arabic, toki pona has no associated country/Unicode flag.
    // `flag` uses U+F0001, the next private-use codepoint after the Arab
    // League's, resolved via a second one-glyph font (see @font-face in
    // css/style.css and tools/flags/README.md) to the toki pona
    // community's unofficial flag — a sun on pale blue — styled to match
    // Noto Color Emoji. Elsewhere this string is inserted as plain DOM
    // text. Overridden below on Gecko for the same dropdown-rendering
    // bug as Arabic.
    //
    // toki pona has only ~137 words, so text is composed entirely of
    // short phrases — no romanization, diacritics, or furigana needed.
    name: 'toki pona', native: 'toki pona', flag: '\u{F0001}',
    tag: 'tok', romanTag: 'tok',
    romanize: false, fontStack: "system-ui, sans-serif",
    // `stageInLang`: villager-to-villager chat kept inserting English
    // stage directions (e.g. *shuffles feet*) into otherwise-toki-pona
    // lines, which defeats the overhearing comprehension mechanic by
    // leaking English into the transcript. The corrective prompt line
    // (see `converse` in llm.js) is gated by this flag rather than
    // applied to every language, since this specific leak was only
    // measured for toki pona — other languages may or may not have the
    // same issue, untested.
    stageInLang: true,

    // `grammarNote`: DESIGN.md's general guidance is to avoid naming a
    // failure mode in a prompt (models tend to fixate on whatever's
    // named, even when it's named as something to avoid). Three
    // positively-framed alternatives were tried here — stating the rule
    // alone, the rule plus a correct/incorrect example pair, and a
    // juxtaposition that never used the word "error" — and none moved
    // the measured error rate outside normal run-to-run variance.
    // Explicitly naming the mistake was the only version that worked, so
    // this is a deliberate, measured exception to that general guidance,
    // not an oversight: across 298 replayed chatter prompts, incorrect
    // uses of the particle "pi" dropped from a 30/39 and 12/17 baseline
    // (two runs) to 2 after adding this line, with the per-use error
    // rate for "pi" also roughly halving — so this wasn't just villagers
    // avoiding the construction altogether. Best guess for why naming
    // the failure works here despite the general guidance: DESIGN.md's
    // concern is about stylistic failure modes a model might lean into;
    // "pi" needing 2+ following words is a syntactic rule with no
    // stylistic interpretation to lean into.
    grammarNote: 'never use pi with a single word. pi must always be followed by two or more words.'
  }
};

/* Workaround for a Gecko bug: #setLang's *closed* box renders page
   @font-face fonts correctly, but its *open* dropdown popup (at least on
   Linux) doesn't apply page fonts to <option> text at all, so the custom
   flag glyph renders as a missing-glyph placeholder there instead of a
   flag (confirmed in tools/flags/README.md's "Known limitation" section).
   A plain Unicode flag doesn't have this problem, since it's rendered by
   the platform's emoji font rather than a page-supplied one — so Gecko
   gets Saudi Arabia's flag substituted here: not accurate to the Arab
   League, but a working flag beats a broken glyph.
   Detected via the Gecko+"rv:" pair MDN recommends over a bare "Firefox"
   check — this is an engine-level bug, so it should also catch Gecko
   forks (e.g. Floorp), and some other engines deliberately include a
   "like Gecko" token to avoid being caught by checks for "Gecko" alone.
   https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent
   toki pona has the same problem and no Unicode flag to fall back to
   either, so it's substituted with a plain sun emoji — not its actual
   (unofficial) banner, but the recognizable half of it, and likewise
   drawn by the platform's own emoji font.
   Runs inline here rather than on DOMContentLoaded because data.js is
   loaded at the end of <body>, by which point #setLang already exists in
   the parsed document — see index.html's script order. */
if (typeof navigator !== 'undefined' && /Gecko/.test(navigator.userAgent) && /rv:/.test(navigator.userAgent)) {
  var geckoFlags = { ar: '\u{1F1F8}\u{1F1E6}', tok: '\u{1F31E}' };
  for (var code in geckoFlags) {
    var custom = LG.LANGUAGES[code].flag;
    LG.LANGUAGES[code].flag = geckoFlags[code];
    var opt = document.querySelector('#setLang option[value="' + code + '"]');
    if (opt) opt.textContent = opt.textContent.replace(custom, geckoFlags[code]);
  }
}

/* Difficulty controls how hard the village is to *understand*, not how
   far the player has to walk. Chain length is randomized per village
   (see `depth` in chain.js) using the same range at every difficulty —
   length turned out to be a poor difficulty knob, since a longer chain
   distributes facts to more villagers, giving more entry points to solve
   it, so a longer errand could easily be *easier* than a short one.
   What difficulty actually controls is who knows what: `spread` is how
   many villagers beyond a fact's owner also know it, `taper` reduces
   that count for facts further down the chain (so length now hides
   information rather than exposing more of it), and `gossip` sets how
   much of the whole chain the designated village gossip has picked up —
   she knows nearly everything at beginner and only opinions at advanced.

   `prompt` governs how a villager speaks *to the player* — written as
   deliberate accommodation of a learner. `register` governs villager-to-
   villager speech, where accommodation wouldn't make sense (two natives
   talking, with the player only overhearing) — empty at advanced, since
   two natives speaking freely need no register constraint at all.

   `register` still has to roughly track difficulty, though, since
   overhearing is a real mechanic, not just flavor text. An earlier
   version of the beginner `register` ended with "the way you talk when
   you're not thinking about it," meant to license natural, unguarded
   speech — but models weighted that phrase over the plain-words
   instruction before it, producing beginner-village gossip using
   advanced vocabulary and idiom. `register` now only constrains
   vocabulary/sentence complexity, not who's being addressed — which is
   also why it's a separate field from `prompt` rather than reused. */
LG.DEPTH = [4, 7];                       // links per errand, rolled per village

/* Furigana formatting spec — one shared definition, used by every call
   site that requests it.

   Previously five separate, slightly different wordings existed. Four of
   them illustrated the format using the bare word \u6f22\u5b57 ("kanji"), which
   never demonstrates how to handle okurigana (a word's non-kanji tail).
   \u7d50\u3076 ("to tie") is exactly that ambiguous case, and with no example
   covering it, models fell back to the plain-text bracket convention
   \u7d50\u3076[\u3080\u3059\u3076] instead of ruby markup — a legitimate convention, just
   not the one this game's markup parser expects. The worked example line
   below deliberately includes an okurigana word to cover this case. */
LG.FURIGANA = [
  'Write the readings as ruby tags, inline: <ruby>\u6751<rt>\u3080\u3089</rt></ruby>',
  'Okurigana stays outside the tag \u2014 \u7d50\u3076 is <ruby>\u7d50<rt>\u3080\u3059</rt></ruby>\u3076, not <ruby>\u7d50\u3076<rt>\u3080\u3059\u3076</rt></ruby>.',
  'A whole line, annotated: \u4eca\u65e5\u306f<ruby>\u6751<rt>\u3080\u3089</rt></ruby>\u3067<ruby>\u4f55<rt>\u306a\u306b</rt></ruby>\u304b<ruby>\u805e<rt>\u304d</rt></ruby>\u3044\u305f\uff1f',
  'Kanji only \u2014 katakana and hiragana stay bare.',
  'The reading is of the whole word as it is actually pronounced, never the character readings stitched together: \u5927\u5de5 is \u3060\u3044\u304f, not \u3060\u3044\u3053\u3046.',
  'Ruby tags, not square brackets \u2014 \u7cf8[\u3044\u3068] is not the format.'
].join('\n');

/* Tashkeel formatting spec — Arabic's equivalent of furigana. Not a
   separate romanization line, but full vowel diacritics on the Arabic
   script itself, the way children's books, the Qur'an, and learner texts
   write it — as opposed to the bare consonantal skeleton fluent readers
   normally read from context. One shared spec, used by every call site
   that requests it. */
LG.TASHKEEL = [
  'Mark every letter: the three short vowels (\u064e fatha, \u064f damma, \u0650 kasra), sukun \u0652 on a vowel-less consonant, shadda \u0651 on a doubled one, and tanween (\u064b \u064c \u064d) where the grammar calls for it.',
  'A whole line, fully marked: \u0623\u064e\u064a\u0652\u0646\u064e \u0627\u0644\u0645\u064e\u0637\u0652\u0639\u064e\u0645\u064f\u061f',
  'This is the standard of a vocalised text, not decoration \u2014 leaving a word bare is the mistake, not an option.'
].join('\n');

LG.LEVELS = {
  beginner: {
    label: 'Beginner (A1)', spread: 2, taper: 0, gossip: 1, deliver: false, speed: 0.75,
    register: 'Short sentences built from the most common everyday words. No idiom, no slang, no dialect colour.',
    prompt: 'Speak the way a kind native speaker speaks to someone on their first day — someone with a few hundred words, picking the rest up from what is in front of them: short, complete sentences built from the most common everyday words, about the here and now. One idea to a sentence, in the plainest construction your language has for it. No idioms, no slang, nothing literary.'
  },
  intermediate: {
    label: 'Intermediate (A2–B1)', spread: 1, taper: 1, gossip: 0.5, deliver: true, speed: 0.85,
    register: 'Ordinary everyday speech in plain words. Go light on idiom; nothing literary or obscure.',
    prompt: 'Speak simply but easily, the way you would to someone who can hold a conversation but still gropes for words. Everyday vocabulary, ordinary sentence structures, whatever the sentence actually needs to be correct. Go light on idiom and avoid rare or literary words.'
  },
  advanced: {
    label: 'Advanced (B2+)', spread: 0.5, taper: 1, gossip: 0, deliver: true, speed: 0.95,
    register: '',                        // two natives; they talk as they talk
    prompt: 'Speak exactly as you would to another native — full range, including idiom, colloquialism and whatever regional flavour you have.'
  }
};

/* ---------------------------------------------------------------- items
   `tags` drive the generator:
     hold    — a villager can plausibly be carrying it
     shop    — the shopkeeper can sell it
     ground  — it can be lying about in the world
     prize   — it makes a nice thank-you gift
     beast   — it is an animal that wanders and must be caught          */
LG.ITEMS = {
  shiny_rock: {
    icon: '💎', tags: ['hold', 'ground', 'prize'], en: 'shiny rock', full: 'a shiny rock',
    ru: 'блестящий камень', zh: '闪亮的石头', fr: 'pierre brillante', es: 'piedra brillante', ja: '光る石', ar: 'حجر لامع', pl: 'błyszczący kamień', tok: 'kiwen suno'
  },
  beans: {
    icon: '🫘', tags: ['hold', 'shop'], en: 'jar of beans', full: 'a jar of beans',
    ru: 'банка бобов', zh: '一罐豆子', fr: 'bocal de haricots', es: 'tarro de frijoles', ja: '豆のびん', ar: 'برطمان فول', pl: 'słoik fasoli', tok: 'poki pi kili lili'
  },
  coins: {
    icon: '🪙', tags: [], stackable: true, en: 'coins', full: 'coins',
    ru: 'монеты', zh: '硬币', fr: 'pièces', es: 'monedas', ja: 'コイン', ar: 'عملات', pl: 'monety', tok: 'mani'
  },
  bread: {
    icon: '🍞', tags: ['hold', 'shop', 'prize'], en: 'loaf of bread', full: 'a loaf of bread',
    ru: 'хлеб', zh: '面包', fr: 'pain', es: 'pan', ja: 'パン', ar: 'رغيف خبز', pl: 'bochenek chleba', tok: 'pan'
  },
  flower: {
    icon: '🌼', tags: ['hold', 'ground', 'prize'], en: 'flower', full: 'a flower',
    ru: 'цветок', zh: '花', fr: 'fleur', es: 'flor', ja: '花', ar: 'زهرة', pl: 'kwiat', tok: 'kasi kule'
  },
  fish: {
    icon: '🐟', tags: ['hold', 'prize'], en: 'fish', full: 'a fish',
    ru: 'рыба', zh: '鱼', fr: 'poisson', es: 'pescado', ja: '魚', ar: 'سمكة', pl: 'ryba', tok: 'kala'
  },
  honey: {
    icon: '🍯', tags: ['hold', 'shop', 'prize'], en: 'jar of honey', full: 'a jar of honey',
    ru: 'банка мёда', zh: '一罐蜂蜜', fr: 'pot de miel', es: 'tarro de miel', ja: 'はちみつのびん', ar: 'برطمان عسل', pl: 'słoik miodu', tok: 'poki pi telo suwi'
  },
  rope: {
    icon: '🪢', tags: ['hold', 'shop', 'ground'], en: 'rope', full: 'some rope',
    ru: 'верёвка', zh: '绳子', fr: 'corde', es: 'cuerda', ja: 'ロープ', ar: 'حبل', pl: 'lina', tok: 'linja wawa'
  },
  mushrooms: {
    icon: '🍄', tags: ['hold', 'ground'], en: 'mushrooms', full: 'some mushrooms',
    ru: 'грибы', zh: '蘑菇', fr: 'champignons', es: 'setas', ja: 'きのこ', ar: 'فطر', pl: 'grzyby', tok: 'soko'
  },
  egg: {
    icon: '🥚', tags: ['hold', 'shop'], en: 'egg', full: 'an egg',
    ru: 'яйцо', zh: '鸡蛋', fr: 'œuf', es: 'huevo', ja: 'たまご', ar: 'بيضة', pl: 'jajko', tok: 'sike waso'
  },
  milk: {
    icon: '🥛', tags: ['hold', 'shop'], en: 'jug of milk', full: 'a jug of milk',
    ru: 'кувшин молока', zh: '一壶牛奶', fr: 'pot de lait', es: 'jarra de leche', ja: '牛乳のびん', ar: 'إبريق حليب', pl: 'dzbanek mleka', tok: 'poki pi telo mama'
  },
  apple: {
    icon: '🍎', tags: ['hold', 'shop', 'ground', 'prize'], en: 'apple', full: 'an apple',
    ru: 'яблоко', zh: '苹果', fr: 'pomme', es: 'manzana', ja: 'りんご', ar: 'تفاحة', pl: 'jabłko', tok: 'kili loje'
  },
  hat: {
    icon: '🎩', tags: ['hold', 'ground'], en: 'hat', full: 'a hat',
    ru: 'шляпа', zh: '帽子', fr: 'chapeau', es: 'sombrero', ja: '帽子', ar: 'قبعة', pl: 'kapelusz', tok: 'len lawa'
  },
  candle: {
    icon: '🕯️', tags: ['hold', 'shop'], en: 'candle', full: 'a candle',
    ru: 'свеча', zh: '蜡烛', fr: 'bougie', es: 'vela', ja: 'ろうそく', ar: 'شمعة', pl: 'świeca', tok: 'palisa suno'
  },
  key: {
    icon: '🔑', tags: ['hold', 'ground'], en: 'key', full: 'a key',
    ru: 'ключ', zh: '钥匙', fr: 'clé', es: 'llave', ja: 'かぎ', ar: 'مفتاح', pl: 'klucz', tok: 'ilo open'
  },
  wool: {
    icon: '🧶', tags: ['hold', 'shop'], en: 'ball of wool', full: 'a ball of wool',
    ru: 'клубок шерсти', zh: '一团羊毛', fr: 'pelote de laine', es: 'ovillo de lana', ja: '毛糸玉', ar: 'كرة صوف', pl: 'kłębek wełny', tok: 'sike pi linja soweli'
  },
  boots: {
    icon: '🥾', tags: ['hold', 'ground'], en: 'boots', full: 'a pair of boots',
    ru: 'сапоги', zh: '靴子', fr: 'bottes', es: 'botas', ja: 'ブーツ', ar: 'حذاء طويل', pl: 'botki', tok: 'len noka suli'
  },
  lantern: {
    icon: '🏮', tags: ['hold', 'shop', 'ground'], en: 'lantern', full: 'a lantern',
    ru: 'фонарь', zh: '灯笼', fr: 'lanterne', es: 'linterna', ja: '提灯', ar: 'فانوس', pl: 'latarnia', tok: 'ilo suno'
  },
  cat: {
    icon: '🐈', tags: ['beast'], en: 'cat', full: 'a cat',
    ru: 'кошка', zh: '猫', fr: 'chat', es: 'gato', ja: 'ねこ', ar: 'قطة', pl: 'kot', tok: 'soweli mu'
  },
  dog: {
    icon: '🐕', tags: ['beast'], en: 'dog', full: 'a dog',
    ru: 'собака', zh: '狗', fr: 'chien', es: 'perro', ja: 'いぬ', ar: 'كلب', pl: 'pies', tok: 'soweli pona'
  },
  goat: {
    icon: '🐐', tags: ['beast'], en: 'goat', full: 'a goat',
    ru: 'коза', zh: '山羊', fr: 'chèvre', es: 'cabra', ja: 'やぎ', ar: 'عنزة', pl: 'koza', tok: 'soweli pi nena lawa'
  },
  chicken: {
    icon: '🐔', tags: ['beast'], en: 'chicken', full: 'a chicken',
    ru: 'курица', zh: '鸡', fr: 'poule', es: 'gallina', ja: 'にわとり', ar: 'دجاجة', pl: 'kura', tok: 'waso moku'
  },
  duck: {
    icon: '🦆', tags: ['beast'], en: 'duck', full: 'a duck',
    ru: 'утка', zh: '鸭子', fr: 'canard', es: 'pato', ja: 'あひる', ar: 'بطة', pl: 'kaczka', tok: 'waso telo'
  },

  /* ---- the rest of the village's clutter ------------------------------- */
  onion: {
    icon: '🧅', tags: ['hold', 'shop'], en: 'onion', full: 'an onion',
    ru: 'лук', zh: '洋葱', ja: '玉ねぎ', fr: 'oignon', es: 'cebolla', ar: 'بصلة', pl: 'cebula', tok: 'kili pi telo oko'
  },
  carrot: {
    icon: '🥕', tags: ['hold', 'shop', 'ground'], en: 'carrot', full: 'a carrot',
    ru: 'морковь', zh: '胡萝卜', ja: 'にんじん', fr: 'carotte', es: 'zanahoria', ar: 'جزرة', pl: 'marchewka', tok: 'kili palisa loje'
  },
  potato: {
    icon: '🥔', tags: ['hold', 'shop', 'ground'], en: 'potato', full: 'a potato',
    ru: 'картошка', zh: '土豆', ja: 'じゃがいも', fr: 'pomme de terre', es: 'patata', ar: 'بطاطا', pl: 'ziemniak', tok: 'kili ma'
  },
  cabbage: {
    icon: '🥬', tags: ['hold', 'shop', 'ground'], en: 'cabbage', full: 'a cabbage',
    ru: 'капуста', zh: '白菜', ja: 'キャベツ', fr: 'chou', es: 'col', ar: 'ملفوف', pl: 'kapusta', tok: 'kili lipu'
  },
  tomato: {
    icon: '🍅', tags: ['hold', 'shop'], en: 'tomato', full: 'a tomato',
    ru: 'помидор', zh: '西红柿', ja: 'トマト', fr: 'tomate', es: 'tomate', ar: 'طماطم', pl: 'pomidor', tok: 'kili loje pi telo mute'
  },
  pumpkin: {
    icon: '🎃', tags: ['hold', 'shop', 'ground'], en: 'pumpkin', full: 'a pumpkin',
    ru: 'тыква', zh: '南瓜', ja: 'かぼちゃ', fr: 'citrouille', es: 'calabaza', ar: 'يقطينة', pl: 'dynia', tok: 'kili suli jelo'
  },
  garlic: {
    icon: '🧄', tags: ['hold', 'shop'], en: 'garlic', full: 'a bulb of garlic',
    ru: 'чеснок', zh: '大蒜', ja: 'にんにく', fr: 'ail', es: 'ajo', ar: 'رأس ثوم', pl: 'główka czosnku', tok: 'kili ma walo'
  },
  corn: {
    icon: '🌽', tags: ['hold', 'shop', 'ground'], en: 'corn', full: 'an ear of corn',
    ru: 'кукуруза', zh: '玉米', ja: 'とうもろこし', fr: 'maïs', es: 'maíz', ar: 'كوز ذرة', pl: 'kolba kukurydzy', tok: 'pan jelo'
  },
  pear: {
    icon: '🍐', tags: ['hold', 'shop', 'ground', 'prize'], en: 'pear', full: 'a pear',
    ru: 'груша', zh: '梨', ja: 'なし', fr: 'poire', es: 'pera', ar: 'كمثرى', pl: 'gruszka', tok: 'kili nena'
  },
  peach: {
    icon: '🍑', tags: ['hold', 'shop', 'prize'], en: 'peach', full: 'a peach',
    ru: 'персик', zh: '桃子', ja: 'もも', fr: 'pêche', es: 'melocotón', ar: 'خوخة', pl: 'brzoskwinia', tok: 'kili loje jelo'
  },
  cherries: {
    icon: '🍒', tags: ['hold', 'shop', 'prize'], en: 'cherries', full: 'some cherries',
    ru: 'вишня', zh: '樱桃', ja: 'さくらんぼ', fr: 'cerises', es: 'cerezas', ar: 'كرز', pl: 'wiśnie', tok: 'kili loje lili'
  },
  grapes: {
    icon: '🍇', tags: ['hold', 'shop', 'prize'], en: 'grapes', full: 'some grapes',
    ru: 'виноград', zh: '葡萄', ja: 'ぶどう', fr: 'raisin', es: 'uvas', ar: 'عنب', pl: 'winogrona', tok: 'kili laso lili'
  },
  strawberry: {
    icon: '🍓', tags: ['hold', 'shop', 'prize'], en: 'strawberry', full: 'a strawberry',
    ru: 'клубника', zh: '草莓', ja: 'いちご', fr: 'fraise', es: 'fresa', ar: 'فراولة', pl: 'truskawka', tok: 'kili suwi loje'
  },
  lemon: {
    icon: '🍋', tags: ['hold', 'shop'], en: 'lemon', full: 'a lemon',
    ru: 'лимон', zh: '柠檬', ja: 'レモン', fr: 'citron', es: 'limón', ar: 'ليمونة', pl: 'cytryna', tok: 'kili jelo'
  },
  watermelon: {
    icon: '🍉', tags: ['hold', 'shop'], en: 'watermelon', full: 'a watermelon',
    ru: 'арбуз', zh: '西瓜', ja: 'すいか', fr: 'pastèque', es: 'sandía', ar: 'بطيخة', pl: 'arbuz', tok: 'kili suli telo'
  },
  chestnut: {
    icon: '🌰', tags: ['hold', 'ground'], en: 'chestnut', full: 'a chestnut',
    ru: 'каштан', zh: '栗子', ja: 'くり', fr: 'châtaigne', es: 'castaña', ar: 'كستناء', pl: 'kasztan', tok: 'kili kiwen'
  },
  cheese: {
    icon: '🧀', tags: ['hold', 'shop', 'prize'], en: 'cheese', full: 'a wheel of cheese',
    ru: 'сыр', zh: '奶酪', ja: 'チーズ', fr: 'fromage', es: 'queso', ar: 'قالب جبن', pl: 'krąg sera', tok: 'moku pi telo mama'
  },
  butter: {
    icon: '🧈', tags: ['hold', 'shop'], en: 'butter', full: 'a pat of butter',
    ru: 'масло', zh: '黄油', ja: 'バター', fr: 'beurre', es: 'mantequilla', ar: 'قطعة زبدة', pl: 'kostka masła', tok: 'ko pi telo mama'
  },
  salt: {
    icon: '🧂', tags: ['hold', 'shop'], en: 'salt', full: 'a pinch of salt',
    ru: 'соль', zh: '盐', ja: '塩', fr: 'sel', es: 'sal', ar: 'رشة ملح', pl: 'szczypta soli', tok: 'namako'
  },
  sweets: {
    icon: '🍬', tags: ['hold', 'shop', 'prize'], en: 'sweets', full: 'some sweets',
    ru: 'конфеты', zh: '糖果', ja: 'あめ', fr: 'bonbons', es: 'caramelos', ar: 'حلوى', pl: 'cukierki', tok: 'moku suwi'
  },
  cake: {
    icon: '🍰', tags: ['hold', 'shop', 'prize'], en: 'cake', full: 'a slice of cake',
    ru: 'торт', zh: '蛋糕', ja: 'ケーキ', fr: 'gâteau', es: 'pastel', ar: 'قطعة كعك', pl: 'kawałek ciasta', tok: 'pan suwi'
  },
  pie: {
    icon: '🥧', tags: ['hold', 'shop', 'prize'], en: 'pie', full: 'a pie',
    ru: 'пирог', zh: '派', ja: 'パイ', fr: 'tarte', es: 'tarta', ar: 'فطيرة', pl: 'placek', tok: 'pan pi kili suwi'
  },
  jam: {
    icon: '🫙', tags: ['hold', 'shop', 'prize'], en: 'jam', full: 'a jar of jam',
    ru: 'варенье', zh: '果酱', ja: 'ジャム', fr: 'confiture', es: 'mermelada', ar: 'برطمان مربى', pl: 'słoik dżemu', tok: 'ko kili'
  },
  soup: {
    icon: '🍲', tags: ['hold', 'shop'], en: 'soup', full: 'a bowl of soup',
    ru: 'суп', zh: '汤', ja: 'スープ', fr: 'soupe', es: 'sopa', ar: 'طبق حساء', pl: 'miska zupy', tok: 'telo moku'
  },
  meat: {
    icon: '🍖', tags: ['hold', 'shop'], en: 'meat', full: 'a joint of meat',
    ru: 'мясо', zh: '肉', ja: '肉', fr: 'viande', es: 'carne', ar: 'قطعة لحم', pl: 'kawał mięsa', tok: 'moku soweli'
  },
  bacon: {
    icon: '🥓', tags: ['hold', 'shop'], en: 'bacon', full: 'some bacon',
    ru: 'бекон', zh: '培根', ja: 'ベーコン', fr: 'lard', es: 'tocino', ar: 'لحم مقدد', pl: 'boczek', tok: 'moku pi soweli ko'
  },
  rice: {
    icon: '🍚', tags: ['hold', 'shop'], en: 'rice', full: 'a bowl of rice',
    ru: 'рис', zh: '米饭', ja: 'ごはん', fr: 'riz', es: 'arroz', ar: 'طبق أرز', pl: 'miska ryżu', tok: 'pan lili'
  },
  noodles: {
    icon: '🍜', tags: ['hold', 'shop'], en: 'noodles', full: 'a bowl of noodles',
    ru: 'лапша', zh: '面条', ja: 'めん', fr: 'nouilles', es: 'fideos', ar: 'طبق نودلز', pl: 'miska makaronu', tok: 'linja moku'
  },
  wheat: {
    icon: '🌾', tags: ['hold', 'ground'], en: 'wheat', full: 'a sheaf of wheat',
    ru: 'пшеница', zh: '小麦', ja: '小麦', fr: 'blé', es: 'trigo', ar: 'حزمة قمح', pl: 'snop pszenicy', tok: 'kasi pan'
  },
  tea: {
    icon: '🍵', tags: ['hold', 'shop', 'prize'], en: 'tea', full: 'a cup of tea',
    ru: 'чай', zh: '茶', ja: 'お茶', fr: 'thé', es: 'té', ar: 'كوب شاي', pl: 'filiżanka herbaty', tok: 'telo kasi'
  },
  coffee: {
    icon: '☕', tags: ['hold', 'shop'], en: 'coffee', full: 'a cup of coffee',
    ru: 'кофе', zh: '咖啡', ja: 'コーヒー', fr: 'café', es: 'café', ar: 'كوب قهوة', pl: 'filiżanka kawy', tok: 'telo pimeja'
  },
  wine: {
    icon: '🍷', tags: ['hold', 'shop', 'prize'], en: 'wine', full: 'a bottle of wine',
    ru: 'вино', zh: '葡萄酒', ja: 'ワイン', fr: 'vin', es: 'vino', ar: 'زجاجة نبيذ', pl: 'butelka wina', tok: 'telo nasa'
  },
  beer: {
    icon: '🍺', tags: ['hold', 'shop'], en: 'beer', full: 'a mug of beer',
    ru: 'пиво', zh: '啤酒', ja: 'ビール', fr: 'bière', es: 'cerveza', ar: 'كوب بيرة', pl: 'kufel piwa', tok: 'telo nasa pan'
  },
  hammer: {
    icon: '🔨', tags: ['hold', 'shop', 'ground'], en: 'hammer', full: 'a hammer',
    ru: 'молоток', zh: '锤子', ja: 'かなづち', fr: 'marteau', es: 'martillo', ar: 'مطرقة', pl: 'młotek', tok: 'ilo pi utala kiwen'
  },
  axe: {
    icon: '🪓', tags: ['hold', 'shop', 'ground'], en: 'axe', full: 'an axe',
    ru: 'топор', zh: '斧头', ja: 'おの', fr: 'hache', es: 'hacha', ar: 'فأس', pl: 'siekiera', tok: 'ilo pi kipisi kasi'
  },
  saw: {
    icon: '🪚', tags: ['hold', 'shop', 'ground'], en: 'saw', full: 'a saw',
    ru: 'пила', zh: '锯子', ja: 'のこぎり', fr: 'scie', es: 'sierra', ar: 'منشار', pl: 'piła', tok: 'ilo kipisi linja'
  },
  screwdriver: {
    icon: '🪛', tags: ['hold', 'shop', 'ground'], en: 'screwdriver', full: 'a screwdriver',
    ru: 'отвёртка', zh: '螺丝刀', ja: 'ドライバー', fr: 'tournevis', es: 'destornillador', ar: 'مفك', pl: 'śrubokręt', tok: 'ilo pi sike palisa'
  },
  screw: {
    icon: '🔩', tags: ['hold', 'shop', 'ground'], en: 'screw', full: 'a screw',
    ru: 'винт', zh: '螺丝', ja: 'ねじ', fr: 'vis', es: 'tornillo', ar: 'برغي', pl: 'śrubka', tok: 'palisa sike lili'
  },
  bucket: {
    icon: '🪣', tags: ['hold', 'shop', 'ground'], en: 'bucket', full: 'a bucket',
    ru: 'ведро', zh: '桶', ja: 'バケツ', fr: 'seau', es: 'cubo', ar: 'دلو', pl: 'wiadro', tok: 'poki telo'
  },
  basket: {
    icon: '🧺', tags: ['hold', 'shop', 'ground'], en: 'basket', full: 'a basket',
    ru: 'корзина', zh: '篮子', ja: 'かご', fr: 'panier', es: 'cesta', ar: 'سلة', pl: 'koszyk', tok: 'poki linja'
  },
  ladder: {
    icon: '🪜', tags: ['hold', 'ground'], en: 'ladder', full: 'a ladder',
    ru: 'лестница', zh: '梯子', ja: 'はしご', fr: 'échelle', es: 'escalera', ar: 'سلم', pl: 'drabina', tok: 'palisa pi tawa sewi'
  },
  knife: {
    icon: '🔪', tags: ['hold', 'shop'], en: 'knife', full: 'a knife',
    ru: 'нож', zh: '刀', ja: 'ナイフ', fr: 'couteau', es: 'cuchillo', ar: 'سكين', pl: 'nóż', tok: 'ilo kipisi'
  },
  scissors: {
    icon: '✂️', tags: ['hold', 'shop'], en: 'scissors', full: 'a pair of scissors',
    ru: 'ножницы', zh: '剪刀', ja: 'はさみ', fr: 'ciseaux', es: 'tijeras', ar: 'مقص', pl: 'nożyczki', tok: 'ilo kipisi tu'
  },
  needle: {
    icon: '🪡', tags: ['hold', 'shop'], en: 'needle', full: 'a needle',
    ru: 'иголка', zh: '针', ja: 'はり', fr: 'aiguille', es: 'aguja', ar: 'إبرة', pl: 'igła', tok: 'palisa lili'
  },
  thread: {
    icon: '🧵', tags: ['hold', 'shop'], en: 'thread', full: 'a reel of thread',
    ru: 'нитки', zh: '线', ja: '糸', fr: 'fil', es: 'hilo', ar: 'بكرة خيط', pl: 'szpulka nici', tok: 'linja lili'
  },
  fishing_rod: {
    icon: '🎣', tags: ['hold', 'ground'], en: 'fishing rod', full: 'a fishing rod',
    ru: 'удочка', zh: '钓竿', ja: 'つりざお', fr: 'canne à pêche', es: 'caña de pescar', ar: 'صنارة صيد', pl: 'wędka', tok: 'ilo pi alasa kala'
  },
  magnet: {
    icon: '🧲', tags: ['hold', 'ground'], en: 'magnet', full: 'a magnet',
    ru: 'магнит', zh: '磁铁', ja: '磁石', fr: 'aimant', es: 'imán', ar: 'مغناطيس', pl: 'magnes', tok: 'kiwen wawa'
  },
  chain: {
    icon: '⛓️', tags: ['hold', 'ground'], en: 'chain', full: 'a chain',
    ru: 'цепь', zh: '链子', ja: 'くさり', fr: 'chaîne', es: 'cadena', ar: 'سلسلة', pl: 'łańcuch', tok: 'linja kiwen'
  },
  bell: {
    icon: '🔔', tags: ['hold', 'shop', 'prize'], en: 'bell', full: 'a bell',
    ru: 'колокольчик', zh: '铃铛', ja: 'すず', fr: 'cloche', es: 'campana', ar: 'جرس', pl: 'dzwonek', tok: 'ilo kalama lili'
  },
  broom: {
    icon: '🧹', tags: ['hold', 'shop'], en: 'broom', full: 'a broom',
    ru: 'метла', zh: '扫帚', ja: 'ほうき', fr: 'balai', es: 'escoba', ar: 'مكنسة', pl: 'miotła', tok: 'ilo pi weka jaki'
  },
  compass: {
    icon: '🧭', tags: ['hold', 'ground', 'prize'], en: 'compass', full: 'a compass',
    ru: 'компас', zh: '指南针', ja: 'コンパス', fr: 'boussole', es: 'brújula', ar: 'بوصلة', pl: 'kompas', tok: 'ilo nasin'
  },
  telescope: {
    icon: '🔭', tags: ['hold', 'prize'], en: 'telescope', full: 'a telescope',
    ru: 'телескоп', zh: '望远镜', ja: '望遠鏡', fr: 'télescope', es: 'telescopio', ar: 'تلسكوب', pl: 'teleskop', tok: 'ilo pi lukin weka'
  },
  magnifier: {
    icon: '🔍', tags: ['hold', 'ground'], en: 'magnifying glass', full: 'a magnifying glass',
    ru: 'лупа', zh: '放大镜', ja: '虫めがね', fr: 'loupe', es: 'lupa', ar: 'عدسة مكبرة', pl: 'szkło powiększające', tok: 'ilo pi lukin suli'
  },
  umbrella: {
    icon: '☂️', tags: ['hold', 'shop', 'ground'], en: 'umbrella', full: 'an umbrella',
    ru: 'зонт', zh: '雨伞', ja: 'かさ', fr: 'parapluie', es: 'paraguas', ar: 'مظلة', pl: 'parasol', tok: 'ilo pi awen telo'
  },
  mirror: {
    icon: '🪞', tags: ['hold', 'shop', 'prize'], en: 'mirror', full: 'a mirror',
    ru: 'зеркало', zh: '镜子', ja: 'かがみ', fr: 'miroir', es: 'espejo', ar: 'مرآة', pl: 'lustro', tok: 'supa lukin'
  },
  soap: {
    icon: '🧼', tags: ['hold', 'shop'], en: 'soap', full: 'a bar of soap',
    ru: 'мыло', zh: '肥皂', ja: 'せっけん', fr: 'savon', es: 'jabón', ar: 'قالب صابون', pl: 'kostka mydła', tok: 'ko pi weka jaki'
  },
  teapot: {
    icon: '🫖', tags: ['hold', 'shop', 'prize'], en: 'teapot', full: 'a teapot',
    ru: 'чайник', zh: '茶壶', ja: 'きゅうす', fr: 'théière', es: 'tetera', ar: 'إبريق شاي', pl: 'czajniczek', tok: 'poki pi telo kasi'
  },
  bottle: {
    icon: '🍾', tags: ['hold', 'shop', 'ground'], en: 'bottle', full: 'a bottle',
    ru: 'бутылка', zh: '瓶子', ja: 'びん', fr: 'bouteille', es: 'botella', ar: 'زجاجة', pl: 'butelka', tok: 'poki palisa'
  },
  plate: {
    icon: '🍽️', tags: ['hold', 'shop'], en: 'plate', full: 'a plate',
    ru: 'тарелка', zh: '盘子', ja: 'おさら', fr: 'assiette', es: 'plato', ar: 'طبق', pl: 'talerz', tok: 'supa moku'
  },
  spoon: {
    icon: '🥄', tags: ['hold', 'shop'], en: 'spoon', full: 'a spoon',
    ru: 'ложка', zh: '勺子', ja: 'スプーン', fr: 'cuillère', es: 'cuchara', ar: 'ملعقة', pl: 'łyżka', tok: 'ilo moku'
  },
  fork: {
    icon: '🍴', tags: ['hold', 'shop'], en: 'fork', full: 'a fork',
    ru: 'вилка', zh: '叉子', ja: 'フォーク', fr: 'fourchette', es: 'tenedor', ar: 'شوكة', pl: 'widelec', tok: 'ilo moku palisa'
  },
  clock: {
    icon: '🕰️', tags: ['hold', 'shop', 'prize'], en: 'clock', full: 'a clock',
    ru: 'часы', zh: '钟', ja: 'とけい', fr: 'horloge', es: 'reloj', ar: 'ساعة', pl: 'zegar', tok: 'ilo tenpo'
  },
  oil_lamp: {
    icon: '🪔', tags: ['hold', 'shop', 'ground'], en: 'oil lamp', full: 'an oil lamp',
    ru: 'лампа', zh: '油灯', ja: 'ランプ', fr: 'lampe', es: 'lámpara', ar: 'مصباح زيت', pl: 'lampa naftowa', tok: 'ilo suno pi telo seli'
  },
  chair: {
    icon: '🪑', tags: ['hold', 'shop'], en: 'chair', full: 'a chair',
    ru: 'стул', zh: '椅子', ja: 'いす', fr: 'chaise', es: 'silla', ar: 'كرسي', pl: 'krzesło', tok: 'supa monsi'
  },
  box: {
    icon: '📦', tags: ['hold', 'ground'], en: 'box', full: 'a box',
    ru: 'коробка', zh: '箱子', ja: 'はこ', fr: 'boîte', es: 'caja', ar: 'صندوق', pl: 'pudełko', tok: 'poki kiwen'
  },
  book: {
    icon: '📖', tags: ['hold', 'shop', 'ground', 'prize'], en: 'book', full: 'a book',
    ru: 'книга', zh: '书', ja: 'ほん', fr: 'livre', es: 'libro', ar: 'كتاب', pl: 'książka', tok: 'lipu suli'
  },
  letter: {
    icon: '✉️', tags: ['hold', 'ground'], en: 'letter', full: 'a letter',
    ru: 'письмо', zh: '信', ja: 'てがみ', fr: 'lettre', es: 'carta', ar: 'رسالة', pl: 'list', tok: 'lipu toki'
  },
  pen: {
    icon: '🖊️', tags: ['hold', 'shop', 'ground'], en: 'pen', full: 'a pen',
    ru: 'ручка', zh: '钢笔', ja: 'ペン', fr: 'stylo', es: 'bolígrafo', ar: 'قلم حبر', pl: 'długopis', tok: 'ilo pi sitelen telo'
  },
  pencil: {
    icon: '✏️', tags: ['hold', 'shop', 'ground'], en: 'pencil', full: 'a pencil',
    ru: 'карандаш', zh: '铅笔', ja: 'えんぴつ', fr: 'crayon', es: 'lápiz', ar: 'قلم رصاص', pl: 'ołówek', tok: 'ilo sitelen'
  },
  paper: {
    icon: '📄', tags: ['hold', 'shop'], en: 'paper', full: 'a sheet of paper',
    ru: 'бумага', zh: '纸', ja: 'かみ', fr: 'papier', es: 'papel', ar: 'ورقة', pl: 'kartka papieru', tok: 'lipu'
  },
  map: {
    icon: '🗺️', tags: ['hold', 'ground', 'prize'], en: 'map', full: 'a map',
    ru: 'карта', zh: '地图', ja: 'ちず', fr: 'carte', es: 'mapa', ar: 'خريطة', pl: 'mapa', tok: 'lipu ma'
  },
  purse: {
    icon: '👛', tags: ['hold', 'shop', 'ground'], en: 'purse', full: 'a purse',
    ru: 'кошелёк', zh: '钱包', ja: 'さいふ', fr: 'porte-monnaie', es: 'monedero', ar: 'محفظة', pl: 'sakiewka', tok: 'poki mani'
  },
  backpack: {
    icon: '🎒', tags: ['hold', 'shop'], en: 'backpack', full: 'a backpack',
    ru: 'рюкзак', zh: '背包', ja: 'リュック', fr: 'sac à dos', es: 'mochila', ar: 'حقيبة ظهر', pl: 'plecak', tok: 'poki monsi'
  },
  ring: {
    icon: '💍', tags: ['hold', 'ground', 'prize'], en: 'ring', full: 'a ring',
    ru: 'кольцо', zh: '戒指', ja: 'ゆびわ', fr: 'bague', es: 'anillo', ar: 'خاتم', pl: 'pierścionek', tok: 'sike luka'
  },
  crown: {
    icon: '👑', tags: ['hold', 'prize'], en: 'crown', full: 'a crown',
    ru: 'корона', zh: '王冠', ja: 'おうかん', fr: 'couronne', es: 'corona', ar: 'تاج', pl: 'korona', tok: 'sike lawa'
  },
  crystal_ball: {
    icon: '🔮', tags: ['hold', 'prize'], en: 'crystal ball', full: 'a crystal ball',
    ru: 'хрустальный шар', zh: '水晶球', ja: '水晶玉', fr: 'boule de cristal', es: 'bola de cristal', ar: 'كرة بلورية', pl: 'kryształowa kula', tok: 'sike pi kiwen lukin'
  },
  coat: {
    icon: '🧥', tags: ['hold', 'shop'], en: 'coat', full: 'a coat',
    ru: 'пальто', zh: '外套', ja: 'コート', fr: 'manteau', es: 'abrigo', ar: 'معطف', pl: 'płaszcz', tok: 'len lete'
  },
  scarf: {
    icon: '🧣', tags: ['hold', 'shop', 'prize'], en: 'scarf', full: 'a scarf',
    ru: 'шарф', zh: '围巾', ja: 'マフラー', fr: 'écharpe', es: 'bufanda', ar: 'وشاح', pl: 'szalik', tok: 'len pi anpa lawa'
  },
  gloves: {
    icon: '🧤', tags: ['hold', 'shop', 'ground'], en: 'gloves', full: 'a pair of gloves',
    ru: 'перчатки', zh: '手套', ja: 'てぶくろ', fr: 'gants', es: 'guantes', ar: 'قفازات', pl: 'rękawiczki', tok: 'len luka'
  },
  socks: {
    icon: '🧦', tags: ['hold', 'shop'], en: 'socks', full: 'a pair of socks',
    ru: 'носки', zh: '袜子', ja: 'くつした', fr: 'chaussettes', es: 'calcetines', ar: 'جوارب', pl: 'skarpetki', tok: 'len noka lili'
  },
  shirt: {
    icon: '👕', tags: ['hold', 'shop'], en: 'shirt', full: 'a shirt',
    ru: 'рубашка', zh: '衬衫', ja: 'シャツ', fr: 'chemise', es: 'camisa', ar: 'قميص', pl: 'koszula', tok: 'len sijelo'
  },
  trousers: {
    icon: '👖', tags: ['hold', 'shop'], en: 'trousers', full: 'a pair of trousers',
    ru: 'штаны', zh: '裤子', ja: 'ズボン', fr: 'pantalon', es: 'pantalones', ar: 'بنطال', pl: 'spodnie', tok: 'len pi noka tu'
  },
  dress: {
    icon: '👗', tags: ['hold', 'shop', 'prize'], en: 'dress', full: 'a dress',
    ru: 'платье', zh: '连衣裙', ja: 'ワンピース', fr: 'robe', es: 'vestido', ar: 'فستان', pl: 'sukienka', tok: 'len suli'
  },
  shoes: {
    icon: '👞', tags: ['hold', 'shop', 'ground'], en: 'shoes', full: 'a pair of shoes',
    ru: 'туфли', zh: '鞋', ja: 'くつ', fr: 'chaussures', es: 'zapatos', ar: 'حذاء', pl: 'buty', tok: 'len noka'
  },
  glasses: {
    icon: '👓', tags: ['hold', 'shop', 'ground'], en: 'glasses', full: 'a pair of glasses',
    ru: 'очки', zh: '眼镜', ja: 'めがね', fr: 'lunettes', es: 'gafas', ar: 'نظارة', pl: 'okulary', tok: 'ilo lukin'
  },
  ribbon: {
    icon: '🎀', tags: ['hold', 'shop', 'prize'], en: 'ribbon', full: 'a ribbon',
    ru: 'бант', zh: '蝴蝶结', ja: 'リボン', fr: 'ruban', es: 'lazo', ar: 'شريط', pl: 'wstążka', tok: 'linja kule'
  },
  feather: {
    icon: '🪶', tags: ['hold', 'ground'], en: 'feather', full: 'a feather',
    ru: 'перо', zh: '羽毛', ja: 'はね', fr: 'plume', es: 'pluma', ar: 'ريشة', pl: 'pióro', tok: 'linja waso'
  },
  shell: {
    icon: '🐚', tags: ['hold', 'ground', 'prize'], en: 'shell', full: 'a shell',
    ru: 'ракушка', zh: '贝壳', ja: 'かい', fr: 'coquillage', es: 'concha', ar: 'صدفة', pl: 'muszla', tok: 'selo kala'
  },
  leaf: {
    icon: '🍃', tags: ['hold', 'ground'], en: 'leaf', full: 'a leaf',
    ru: 'лист', zh: '叶子', ja: 'は', fr: 'feuille', es: 'hoja', ar: 'ورقة شجر', pl: 'liść', tok: 'lipu kasi'
  },
  log: {
    icon: '🪵', tags: ['hold', 'ground'], en: 'log', full: 'a log',
    ru: 'бревно', zh: '木头', ja: 'まるた', fr: 'bûche', es: 'tronco', ar: 'جذع خشب', pl: 'kłoda', tok: 'palisa kasi'
  },
  stone: {
    icon: '🪨', tags: ['hold', 'ground'], en: 'stone', full: 'a stone',
    ru: 'камень', zh: '石头', ja: 'いし', fr: 'pierre', es: 'piedra', ar: 'حجر', pl: 'kamień', tok: 'kiwen'
  },
  ice: {
    icon: '🧊', tags: ['hold', 'ground'], en: 'block of ice', full: 'a block of ice',
    ru: 'лёд', zh: '冰', ja: 'こおり', fr: 'glace', es: 'hielo', ar: 'قالب ثلج', pl: 'bryła lodu', tok: 'telo lete kiwen'
  },
  seedling: {
    icon: '🌱', tags: ['hold', 'shop', 'ground'], en: 'seedling', full: 'a seedling',
    ru: 'росток', zh: '幼苗', ja: 'なえ', fr: 'pousse', es: 'brote', ar: 'شتلة', pl: 'sadzonka', tok: 'kasi lili'
  },
  herbs: {
    icon: '🌿', tags: ['hold', 'shop', 'ground'], en: 'herbs', full: 'a bunch of herbs',
    ru: 'травы', zh: '草药', ja: 'ハーブ', fr: 'herbes', es: 'hierbas', ar: 'حزمة أعشاب', pl: 'pęczek ziół', tok: 'kasi pi kon pona'
  },
  drum: {
    icon: '🥁', tags: ['hold', 'prize'], en: 'drum', full: 'a drum',
    ru: 'барабан', zh: '鼓', ja: 'たいこ', fr: 'tambour', es: 'tambor', ar: 'طبل', pl: 'bęben', tok: 'ilo kalama supa'
  },
  violin: {
    icon: '🎻', tags: ['hold', 'prize'], en: 'violin', full: 'a violin',
    ru: 'скрипка', zh: '小提琴', ja: 'バイオリン', fr: 'violon', es: 'violín', ar: 'كمان', pl: 'skrzypce', tok: 'ilo kalama linja'
  },
  guitar: {
    icon: '🎸', tags: ['hold', 'prize'], en: 'guitar', full: 'a guitar',
    ru: 'гитара', zh: '吉他', ja: 'ギター', fr: 'guitare', es: 'guitarra', ar: 'جيتار', pl: 'gitara', tok: 'ilo kalama pi linja luka'
  },
  kite: {
    icon: '🪁', tags: ['hold', 'ground', 'prize'], en: 'kite', full: 'a kite',
    ru: 'воздушный змей', zh: '风筝', ja: 'たこ', fr: 'cerf-volant', es: 'cometa', ar: 'طائرة ورقية', pl: 'latawiec', tok: 'len pi tawa sewi'
  },
  ball: {
    icon: '⚽', tags: ['hold', 'shop', 'ground', 'prize'], en: 'ball', full: 'a ball',
    ru: 'мяч', zh: '球', ja: 'ボール', fr: 'ballon', es: 'pelota', ar: 'كرة', pl: 'piłka', tok: 'sike musi'
  },
  teddy: {
    icon: '🧸', tags: ['hold', 'shop', 'prize'], en: 'teddy bear', full: 'a teddy bear',
    ru: 'плюшевый мишка', zh: '泰迪熊', ja: 'テディベア', fr: 'ours en peluche', es: 'osito de peluche', ar: 'دب محشو', pl: 'miś pluszowy', tok: 'soweli len'
  },
  dice: {
    icon: '🎲', tags: ['hold', 'ground'], en: 'dice', full: 'a pair of dice',
    ru: 'кубики', zh: '骰子', ja: 'サイコロ', fr: 'dés', es: 'dados', ar: 'زهر النرد', pl: 'kości do gry', tok: 'kiwen musi'
  },
  cards: {
    icon: '🃏', tags: ['hold', 'shop'], en: 'cards', full: 'a pack of cards',
    ru: 'карты', zh: '扑克牌', ja: 'トランプ', fr: 'cartes', es: 'cartas', ar: 'أوراق لعب', pl: 'talia kart', tok: 'lipu musi'
  },
  puzzle: {
    icon: '🧩', tags: ['hold', 'shop', 'prize'], en: 'puzzle', full: 'a puzzle',
    ru: 'пазл', zh: '拼图', ja: 'パズル', fr: 'puzzle', es: 'puzle', ar: 'أحجية', pl: 'puzzle', tok: 'musi sona'
  },
  sheep: {
    icon: '🐑', tags: ['beast'], en: 'sheep', full: 'a sheep',
    ru: 'овца', zh: '绵羊', ja: 'ひつじ', fr: 'mouton', es: 'oveja', ar: 'خروف', pl: 'owca', tok: 'soweli pi linja mute'
  },
  pig: {
    icon: '🐖', tags: ['beast'], en: 'pig', full: 'a pig',
    ru: 'свинья', zh: '猪', ja: 'ぶた', fr: 'cochon', es: 'cerdo', ar: 'خنزير', pl: 'świnia', tok: 'soweli ko'
  },
  cow: {
    icon: '🐄', tags: ['beast'], en: 'cow', full: 'a cow',
    ru: 'корова', zh: '牛', ja: 'うし', fr: 'vache', es: 'vaca', ar: 'بقرة', pl: 'krowa', tok: 'soweli mani'
  },
  horse: {
    icon: '🐎', tags: ['beast'], en: 'horse', full: 'a horse',
    ru: 'лошадь', zh: '马', ja: 'うま', fr: 'cheval', es: 'caballo', ar: 'حصان', pl: 'koń', tok: 'soweli tawa'
  },
  donkey: {
    icon: '🫏', tags: ['beast'], en: 'donkey', full: 'a donkey',
    ru: 'осёл', zh: '驴', ja: 'ロバ', fr: 'âne', es: 'burro', ar: 'حمار', pl: 'osioł', tok: 'soweli pali'
  },
  rabbit: {
    icon: '🐇', tags: ['beast'], en: 'rabbit', full: 'a rabbit',
    ru: 'кролик', zh: '兔子', ja: 'うさぎ', fr: 'lapin', es: 'conejo', ar: 'أرنب', pl: 'królik', tok: 'soweli pi kute suli'
  },
  goose: {
    icon: '🪿', tags: ['beast'], en: 'goose', full: 'a goose',
    ru: 'гусь', zh: '鹅', ja: 'ガチョウ', fr: 'oie', es: 'ganso', ar: 'إوزة', pl: 'gęś', tok: 'waso telo suli'
  },
  mouse: {
    icon: '🐁', tags: ['beast'], en: 'mouse', full: 'a mouse',
    ru: 'мышь', zh: '老鼠', ja: 'ねずみ', fr: 'souris', es: 'ratón', ar: 'فأر', pl: 'mysz', tok: 'soweli lili'
  },
  frog: {
    icon: '🐸', tags: ['beast'], en: 'frog', full: 'a frog',
    ru: 'лягушка', zh: '青蛙', ja: 'かえる', fr: 'grenouille', es: 'rana', ar: 'ضفدع', pl: 'żaba', tok: 'akesi'
  },
  hedgehog: {
    icon: '🦔', tags: ['beast'], en: 'hedgehog', full: 'a hedgehog',
    ru: 'ёж', zh: '刺猬', ja: 'ハリネズミ', fr: 'hérisson', es: 'erizo', ar: 'قنفذ', pl: 'jeż', tok: 'soweli pi palisa mute'
  },
  owl: {
    icon: '🦉', tags: ['beast'], en: 'owl', full: 'an owl',
    ru: 'сова', zh: '猫头鹰', ja: 'ふくろう', fr: 'hibou', es: 'búho', ar: 'بومة', pl: 'sowa', tok: 'waso pi tenpo pimeja'
  },
  turtle: {
    icon: '🐢', tags: ['beast'], en: 'turtle', full: 'a turtle',
    ru: 'черепаха', zh: '乌龟', ja: 'かめ', fr: 'tortue', es: 'tortuga', ar: 'سلحفاة', pl: 'żółw', tok: 'akesi pi poki kiwen'
  },
  snail: {
    icon: '🐌', tags: ['beast'], en: 'snail', full: 'a snail',
    ru: 'улитка', zh: '蜗牛', ja: 'かたつむり', fr: 'escargot', es: 'caracol', ar: 'حلزون', pl: 'ślimak', tok: 'pipi pi tomo kiwen'
  },
  parrot: {
    icon: '🦜', tags: ['beast'], en: 'parrot', full: 'a parrot',
    ru: 'попугай', zh: '鹦鹉', ja: 'オウム', fr: 'perroquet', es: 'loro', ar: 'ببغاء', pl: 'papuga', tok: 'waso kule'
  },
  pony: {
    icon: '🐴', tags: ['beast'], en: 'pony', full: 'a pony',
    ru: 'пони', zh: '小马', ja: 'ポニー', fr: 'poney', es: 'poni', ar: 'مهر', pl: 'kucyk', tok: 'soweli tawa lili'
  }
};

/* Fallback price when an item has no explicit `price` field. */
LG.PRICE_BY_TAG = { beast: 6, prize: 4, shop: 2, hold: 2, ground: 1 };
LG.priceOf = function (id) {
  const it = LG.ITEMS[id];
  if (!it) return 0;
  if (it.price) return it.price;
  let p = 2;
  (it.tags || []).forEach(t => { if (LG.PRICE_BY_TAG[t]) p = Math.max(p, LG.PRICE_BY_TAG[t]); });
  return p;
};

LG.BEAST_NAMES = ['Musya', 'Bella', 'Pip', 'Nina', 'Rufus', 'Kolya', 'Tula', 'Bruno'];

/* ------------------------------------------------------------- the map
   The village occupies the southern half of the map. North of it is a
   large forest, big enough to plausibly lose things in; east of it, at
   the end of the high street, is the platform of an unmanned railway
   halt where the traveller arrives.

   `NORTH_WOODS` is the row where the village begins, counting from the
   map's top edge. Kept as a separate named constant rather than baked
   into other coordinates, since the forest and village are laid out from
   opposite edges (the village grows south from its own north edge; the
   woods extend north from the treeline). Every coordinate in this file
   and world.js is still *absolute* — this constant only marks where the
   boundary between the two regions is, not an offset to apply elsewhere.
   Coordinates expressed relative to each other in some places and
   absolutely in others is exactly the kind of drift that's caused bugs
   in this codebase before. */
LG.NORTH_WOODS = 40;             // rows of forest before the village starts

/* Where the traveller arrives: on the platform, near the nameboard and
   a short walk from the end of the high street. */
LG.START = { x: 86, y: 61 };

/* The village green. Idle villagers drift here during the day. */
LG.GREEN = { x: 31, y: 67, w: 20, h: 12 };

/* The noticeboard's location, just past the hall. This is a place a
   villager can freely choose to walk to (see `placesFor` in game.js),
   same as the green or their own workplace — not a scripted stop on any
   fixed routine. */
LG.BOARD_SPOT = { x: 43, y: 65, w: 3, h: 2 };

/* --------------------------------------------------------- what a sign says
   Buildings and flavor spots use their plain English `label` as an
   internal id everywhere in the code (buildingByLabel, a villager's
   workplace, etc). A sign, though, is something the player reads, so its
   displayed text is in the village's actual language, falling back to
   English, with the English gloss shown underneath. */
LG.PLACENAMES = {
  'Village Hall': { en: 'Village Hall', ru: 'Сельская управа', zh: '村公所', ja: '村役場', fr: 'Mairie', es: 'Ayuntamiento', ar: 'قاعة القرية', pl: 'Ratusz', tok: 'tomo pi kulupu ma' },
  Bakery:         { en: 'Bakery', ru: 'Пекарня', zh: '面包店', ja: 'パン屋', fr: 'Boulangerie', es: 'Panadería', ar: 'مخبز', pl: 'Piekarnia', tok: 'tomo pan' },
  Shop:           { en: 'Shop', ru: 'Лавка', zh: '杂货店', ja: '雑貨屋', fr: 'Épicerie', es: 'Tienda', ar: 'متجر', pl: 'Sklep', tok: 'tomo esun' },
  Inn:            { en: 'Inn', ru: 'Трактир', zh: '客栈', ja: '宿屋', fr: 'Auberge', es: 'Posada', ar: 'نزل', pl: 'Gospoda', tok: 'tomo pi telo nasa' },
  Farmhouse:      { en: 'Farmhouse', ru: 'Дом фермера', zh: '农舍', ja: '農家', fr: 'Ferme', es: 'Granja', ar: 'بيت المزرعة', pl: 'Zagroda', tok: 'tomo pi pali ma' },
  Mill:           { en: 'Mill', ru: 'Мельница', zh: '磨坊', ja: '水車小屋', fr: 'Moulin', es: 'Molino', ar: 'طاحونة', pl: 'Młyn', tok: 'tomo pi pan ko' },
  School:         { en: 'School', ru: 'Школа', zh: '学堂', ja: '学校', fr: 'École', es: 'Escuela', ar: 'مدرسة', pl: 'Szkoła', tok: 'tomo sona' },
  Chapel:         { en: 'Chapel', ru: 'Часовня', zh: '小教堂', ja: '礼拝堂', fr: 'Chapelle', es: 'Capilla', ar: 'كنيسة صغيرة', pl: 'Kaplica', tok: 'tomo sewi' },
  Smithy:         { en: 'Smithy', ru: 'Кузница', zh: '铁匠铺', ja: '鍛冶屋', fr: 'Forge', es: 'Herrería', ar: 'حدادة', pl: 'Kuźnia', tok: 'tomo pi kiwen seli' },
  Hut:            { en: 'Hut', ru: 'Хижина', zh: '小屋', ja: '小屋', fr: 'Cabane', es: 'Choza', ar: 'كوخ', pl: 'Chata', tok: 'tomo lili' },
  'The Green':    { en: 'The Green', ru: 'Площадь', zh: '村中广场', ja: '広場', fr: 'La Place', es: 'La Plaza', ar: 'الساحة الخضراء', pl: 'Błonie', tok: 'ma kasi lili' },
  Mine:           { en: 'Mine', ru: 'Шахта', zh: '矿场', ja: '鉱山', fr: 'Mine', es: 'Mina', ar: 'منجم', pl: 'Kopalnia', tok: 'lupa ma' },
  Pond:           { en: 'Pond', ru: 'Пруд', zh: '池塘', ja: '池', fr: 'Étang', es: 'Estanque', ar: 'بركة', pl: 'Staw', tok: 'telo lili' },
  Fields:         { en: 'Fields', ru: 'Поля', zh: '田地', ja: '畑', fr: 'Champs', es: 'Campos', ar: 'حقول', pl: 'Pola', tok: 'ma pali' },
  Orchard:        { en: 'Orchard', ru: 'Сад', zh: '果园', ja: '果樹園', fr: 'Verger', es: 'Huerto', ar: 'بستان', pl: 'Sad', tok: 'ma kili' },
  Beeyard:        { en: 'Beeyard', ru: 'Пасека', zh: '养蜂场', ja: '養蜂場', fr: 'Rucher', es: 'Colmenar', ar: 'منحل', pl: 'Pasieka', tok: 'tomo pi pipi suwi' },
  Woodpile:       { en: 'Woodpile', ru: 'Дровяной склад', zh: '木材堆场', ja: '薪置き場', fr: 'Tas de bois', es: 'Leñera', ar: 'كومة حطب', pl: 'Stos drewna', tok: 'kulupu palisa' },
  Graveyard:      { en: 'Graveyard', ru: 'Кладбище', zh: '墓地', ja: '墓地', fr: 'Cimetière', es: 'Cementerio', ar: 'مقبرة', pl: 'Cmentarz', tok: 'ma pi jan moli' },
  Noticeboard:    { en: 'Noticeboard', ru: 'Доска объявлений', zh: '布告栏', ja: '掲示板', fr: "Panneau d'affichage", es: 'Tablón de anuncios', ar: 'لوحة إعلانات', pl: 'Tablica ogłoszeń', tok: 'supa lipu' },
  Station:        { en: 'Station', ru: 'Станция', zh: '火车站', ja: '駅', fr: 'Gare', es: 'Estación', ar: 'محطة', pl: 'Stacja', tok: 'tomo pi tomo tawa' },
  'The Woods':    { en: 'The Woods', ru: 'Лес', zh: '树林', ja: '森', fr: 'La Forêt', es: 'El Bosque', ar: 'الغابة', pl: 'Las', tok: 'ma kasi suli' },
  'Big Clearing': { en: 'Big Clearing', ru: 'Поляна', zh: '大空地', ja: '大きな空き地', fr: 'La Clairière', es: 'El Claro', ar: 'الفسحة الكبيرة', pl: 'Duża Polana', tok: 'ma suli pi kasi ala' },
  'Old Oak':      { en: 'Old Oak', ru: 'Старый дуб', zh: '老橡树', ja: '古い樫の木', fr: 'Le Vieux Chêne', es: 'El Roble Viejo', ar: 'البلوطة العجوز', pl: 'Stary Dąb', tok: 'kasi suli pi tenpo mute' },
  'The Hollow':   { en: 'The Hollow', ru: 'Лощина', zh: '洼地', ja: 'くぼ地', fr: 'Le Vallon', es: 'La Hondonada', ar: 'المنخفض', pl: 'Kotlina', tok: 'ma anpa' },
  'Charcoal Pit': { en: 'Charcoal Pit', ru: 'Угольная яма', zh: '烧炭坑', ja: '炭焼き窯', fr: 'La Charbonnière', es: 'La Carbonera', ar: 'حفرة الفحم', pl: 'Mielerz', tok: 'lupa pi palisa seli' },
  'Forest Spring':{ en: 'Forest Spring', ru: 'Лесной родник', zh: '林中泉', ja: '森の泉', fr: 'La Source', es: 'El Manantial', ar: 'نبع الغابة', pl: 'Leśne Źródło', tok: 'telo pi ma kasi' },
  'Deep Woods':   { en: 'Deep Woods', ru: 'Чаща', zh: '密林深处', ja: '森の奥', fr: 'Le Bois Profond', es: 'La Espesura', ar: 'الغابة العميقة', pl: 'Głęboki Las', tok: 'insa pi ma kasi' }
};
/* `label` is always the internal id (a building's `label`, or one of the
   bare strings above); code addresses places by that id everywhere and
   only looks up the translated form right before displaying text. */
LG.placeName = function (label, lang) {
  const p = LG.PLACENAMES[label];
  return (p && (p[lang] || p.en)) || label;
};

/* The same thing for items, and the same two callers: what the player sees on
   a button, and what a villager is told a thing is called. */
LG.itemName = function (id, lang) {
  const it = LG.ITEMS[id];
  return (it && (it[lang] || it.en)) || id;
};

/* Formats an item name for a villager's prompt, including both the
   English name and the village-language name.

   Item lists sent to a villager (what they sell, buy, hold, or are
   trading) used to be English-only, on the assumption a villager could
   translate on their own. That works for most languages — "a bowl of
   soup" translates predictably into French or Spanish. It doesn't work
   for names that are this village's specific convention rather than a
   literal translation: e.g. in toki pona, "soup" is `telo moku` and
   "beer" is `telo nasa pan`, terms that don't derive transparently from
   the English words. Given only English, a villager would either invent
   a plausible-but-wrong term, or fall back to saying the English word
   "soup" mid-sentence — both observed in testing.

   So both names are now included wherever an item is named: the English
   the game's internal logic uses, and the actual displayed name the
   player already sees elsewhere (signs, inventory, etc). This benefits
   every language, not just toki pona — it just wasn't wrong yet for
   languages where a literal translation happens to be correct. */
LG.itemSaid = function (id, lang, short) {
  const it = LG.ITEMS[id];
  const en = (it && (short ? it.en : (it.full || it.en))) || id;
  return lang === 'en' ? en : en + ' (“' + LG.itemName(id, lang) + '”)';
};

/* --------------------------------------------------------- what the game says
   Short lines the game itself narrates about a completed deal, in the
   village's language rather than English — "you hand over the rope" is
   as much language-learning content as anything a villager says. {items}
   and {name} are substituted in; {cost} stays a bare number so it reads
   consistently across languages. The English version doubles as the
   click-to-reveal gloss, same convention as the notebook and overheard
   speech. */
LG.CONJ = { ru: 'и', en: 'and', zh: '和', ja: 'と', fr: 'et', es: 'y', ar: 'و', pl: 'i', tok: 'en' };

LG.TXN = {
  buy: {
    en: 'You buy {items} from {name} for ¤{cost}.',
    ru: 'Вы покупаете {items} у {name} за ¤{cost}.',
    zh: '你以¤{cost}的价格从{name}那里买下了{items}。',
    ja: '¤{cost}で{name}から{items}を買った。',
    fr: 'Vous achetez {items} à {name} pour ¤{cost}.',
    es: 'Le compras {items} a {name} por ¤{cost}.',
    ar: 'اشتريت {items} من {name} مقابل ¤{cost}.',
    pl: 'Kupujesz {items} od {name} za ¤{cost}.',
    tok: 'sina esun e {items} tan {name} kepeken mani ¤{cost}.'
  },
  handOver: {
    en: 'You hand over {items} to {name} for ¤{cost}.',
    ru: 'Вы отдаёте {items} {name} за ¤{cost}.',
    zh: '你以¤{cost}的价格把{items}交给了{name}。',
    ja: '¤{cost}で{name}に{items}を渡した。',
    fr: 'Vous remettez {items} à {name} pour ¤{cost}.',
    es: 'Le entregas {items} a {name} por ¤{cost}.',
    ar: 'تم تسليم {items} إلى {name} مقابل ¤{cost}.',
    pl: 'Wręczasz {items} {name} za ¤{cost}.',
    tok: 'sina pana e {items} tawa {name} tan mani ¤{cost}.'
  },
  refund: {
    en: 'You return {items} to {name} and get ¤{cost} back.',
    ru: 'Вы возвращаете {items} {name} и получаете ¤{cost} обратно.',
    zh: '你把{items}还给了{name}，拿回了¤{cost}。',
    ja: '{name}に{items}を返して、¤{cost}を受け取った。',
    fr: 'Vous rendez {items} à {name} et récupérez ¤{cost}.',
    es: 'Le devuelves {items} a {name} y recuperas ¤{cost}.',
    ar: 'تم إرجاع {items} إلى {name} واسترجاع ¤{cost}.',
    pl: 'Zwracasz {items} {name} i odzyskujesz ¤{cost}.',
    tok: 'sina pana sin e {items} tawa {name}. sina kama jo sin e mani ¤{cost}.'
  },
  tradeReceive: {
    en: '{name} hands over {item}.',
    ru: '{name} отдаёт вам {item}.',
    zh: '{name}把{item}交给了你。',
    ja: '{name}が{item}を渡した。',
    fr: '{name} vous remet {item}.',
    es: '{name} te entrega {item}.',
    ar: 'تم تسليم {item} من {name}.',
    pl: '{name} wręcza ci {item}.',
    tok: '{name} li pana e {item}.'
  }
};
/* All other languages' four lines put the traveller in the grammatical
   subject position ("you buy", "vous remettez") since none of them mark
   the subject's gender. Arabic verbs do, and the game never asks the
   player's gender. Real Arabic solves this in exactly this genre —
   receipts, signs, notices — by dropping the personal subject: تم +
   المصدر ("the buying/handing over/returning of X took place"), the
   same impersonal construction a road sign uses to avoid assuming who's
   reading it. So the Arabic lines here are impersonal throughout, not
   "you"-translations with an arbitrarily picked gender. */

/* --------------------------------------------------------------- places
   Locations where an item can turn up or an animal can be found.
   Rectangles are in tile coordinates; the game snaps to the nearest
   walkable tile inside them. */
LG.PLACES = [
  { id: 'pond', en: 'down by the pond', rect: { x: 6, y: 65, w: 12, h: 3 } },
  { id: 'mine', en: 'inside the mine', rect: { x: 3, y: 52, w: 5, h: 5 } },
  { id: 'fields', en: 'out in the fields', rect: { x: 60, y: 74, w: 15, h: 5 } },
  { id: 'green', en: 'on the village green', rect: { x: 32, y: 67, w: 18, h: 12 } },
  { id: 'hall', en: 'outside the village hall', rect: { x: 36, y: 65, w: 10, h: 2 } },
  { id: 'woods', en: 'at the edge of the woods', rect: { x: 12, y: 44, w: 10, h: 3 } },
  { id: 'behind', en: 'behind the farmhouse', rect: { x: 60, y: 60, w: 2, h: 6 } },
  { id: 'road', en: 'along the west road', rect: { x: 10, y: 58, w: 6, h: 4 } },
  { id: 'orchard', en: 'out in the orchard', rect: { x: 63, y: 64, w: 14, h: 7 } },
  { id: 'beeyard', en: 'up by the beeyard', rect: { x: 73, y: 52, w: 4, h: 3 } },
  { id: 'mill', en: 'round the back of the mill', rect: { x: 66, y: 82, w: 9, h: 3 } },
  { id: 'school', en: 'in the schoolyard', rect: { x: 16, y: 85, w: 8, h: 3 } },
  { id: 'chapel', en: 'on the chapel steps', rect: { x: 28, y: 84, w: 8, h: 2 } },
  { id: 'graves', en: 'in the graveyard', rect: { x: 37, y: 89, w: 7, h: 4 } },
  { id: 'woodpile', en: 'by the woodpile', rect: { x: 16, y: 63, w: 8, h: 7 } },
  { id: 'smithy', en: 'outside the smithy', rect: { x: 45, y: 83, w: 9, h: 3 } },
  { id: 'hut', en: 'by the hut at the east end', rect: { x: 70, y: 63, w: 5, h: 2 } },

  /* Forest locations. Each is a glade that world.js clears to open,
     walkable ground and connects via a track — without both, an item
     placed inside an unreachable stand of trees would be effectively
     gone, not just hidden. `label` is the name shown on a sign near the
     glade, so a player can match it against what a villager described. */
  { id: 'glade', en: 'in the big clearing', label: 'Big Clearing',
    rect: { x: 30, y: 20, w: 8, h: 6 }, woods: true },
  { id: 'oak', en: 'under the old oak', label: 'Old Oak',
    rect: { x: 14, y: 12, w: 6, h: 5 }, woods: true },
  { id: 'hollow', en: 'down in the hollow', label: 'The Hollow',
    rect: { x: 52, y: 26, w: 7, h: 5 }, woods: true },
  { id: 'charcoal', en: 'by the charcoal burner’s pit', label: 'Charcoal Pit',
    rect: { x: 66, y: 14, w: 6, h: 5 }, woods: true },
  { id: 'spring', en: 'at the forest spring', label: 'Forest Spring',
    rect: { x: 22, y: 30, w: 6, h: 4 }, woods: true },
  { id: 'deepwoods', en: 'deep in the woods', label: 'Deep Woods',
    rect: { x: 44, y: 8, w: 7, h: 5 }, woods: true },

  { id: 'platform', en: 'on the station platform', rect: { x: 84, y: 52, w: 4, h: 13 } }
];
/* The list this used to be, before the forest and the station joined it, is
   `LG.saveMigrate.PLACES_V1_IDS` in save-migrate.js — a historical fact
   about an old save format, not something that belongs next to the places
   as they stand today. */

/* ------------------------------------------------------------- flavour */
LG.REASONS = [
  'it is for your mother\'s birthday tomorrow',
  'you promised it to your daughter and you cannot go back on that',
  'you lost the last one and you have not slept since',
  'you need it for the festival on Sunday',
  'you lost a bet and this is what you owe',
  'your grandmother had one exactly like it',
  'you cannot finish the work you started without it',
  'it is the one thing your neighbour does not have'
];

LG.OPINIONS = [
  'never washes', 'talks far too much', 'is the kindest person in the village',
  'still owes them money', 'snores loud enough to hear from the road',
  'cheats at cards', 'makes the best soup for miles',
  'has not told the truth since the spring', 'is frightened of geese',
  'sings badly but sings anyway'
];

/* ----------------------------------------------------------- villagers
   Static identity data only — name, job, appearance, base stock. What
   each villager wants, knows, and will trade in a given playthrough is
   decided per-game by chain.js. */
LG.NPCS = [
  {
    id: 'mira', name: 'Mira', emoji: '👩‍🍳', color: '#e07a5f', job: 'the village baker',
    persona: 'Warm, chatty, a little scattered. Calls everyone "dear". Smells of flour.',
    x: 17, y: 54, home: { x: 13, y: 53, w: 9, h: 3 },
    voice: { gender: 'female', age: 'middle' },
    workplace: 'Bakery',
    sells: [{ i: 'bread', p: 2 }, { i: 'cake', p: 3 }, { i: 'pie', p: 3 }],
    buys: [{ i: 'wheat', p: 2 }, { i: 'egg', p: 1 }, { i: 'milk', p: 2 }]
  },

  {
    id: 'boris', name: 'Boris', emoji: '⛏️', color: '#6b705c', job: 'the miner',
    persona: 'Gruff, short sentences, secretly soft-hearted. Complains about his back.',
    x: 6, y: 56, home: { x: 3, y: 53, w: 6, h: 6 },
    voice: { gender: 'male', age: 'old' },
    workRect: { x: 3, y: 52, w: 5, h: 5 }, workLabel: 'the mine',
    sells: [{ i: 'stone', p: 1 }, { i: 'lantern', p: 4 }, { i: 'shiny_rock', p: 6 }],
    buys: [{ i: 'candle', p: 1 }, { i: 'rope', p: 2 }]
  },

  {
    id: 'nadia', name: 'Nadia', emoji: '🧕', color: '#81b29a', job: 'the shopkeeper',
    persona: 'Brisk and businesslike, proud of her shop, never gives anything away for free.',
    x: 33, y: 55, home: { x: 29, y: 54, w: 9, h: 3 }, prefers: 'shop',
    voice: { gender: 'female', age: 'young' },
    workplace: 'Shop',
    sells: [{ i: 'beans', p: 2 }, { i: 'candle', p: 2 }, { i: 'rope', p: 3 }, { i: 'soap', p: 2 }, { i: 'salt', p: 1 }, { i: 'sweets', p: 2 }, { i: 'paper', p: 1 }, { i: 'bucket', p: 3 }, { i: 'basket', p: 3 }],
    sellsTags: ['shop'], buysTags: ['shop'],
    buys: [{ i: 'mushrooms', p: 1 }, { i: 'herbs', p: 1 }, { i: 'shell', p: 1 }, { i: 'feather', p: 1 }]
  },

  {
    id: 'olo', name: 'Olo', emoji: '👨‍🌾', color: '#c9a227', job: 'the farmer',
    persona: 'Slow, kindly, wanders off topic to talk about the weather and his turnips.',
    x: 65, y: 67, home: { x: 61, y: 66, w: 9, h: 3 }, prefers: 'beast',
    voice: { gender: 'male', age: 'old' },
    workplace: 'Farmhouse',
    sells: [{ i: 'egg', p: 1 }, { i: 'milk', p: 2 }, { i: 'apple', p: 1 }, { i: 'wool', p: 3 }, { i: 'pumpkin', p: 2 }, { i: 'carrot', p: 1 }],
    buys: [{ i: 'rope', p: 2 }, { i: 'bucket', p: 2 }]
  },

  {
    id: 'petra', name: 'Petra', emoji: '🧒', color: '#9d4edd', job: 'a child who runs everywhere',
    persona: 'Excitable, nosy, knows everybody\'s business, speaks in short bursts. Asks questions back.',
    x: 41, y: 75, home: { x: 34, y: 73, w: 14, h: 6 }, prefers: 'gossip',
    voice: { gender: 'female', age: 'young' },
    workRect: { x: 32, y: 67, w: 18, h: 12 }, workLabel: 'the village green',
    sells: [{ i: 'flower', p: 1 }, { i: 'shell', p: 1 }, { i: 'feather', p: 1 }],
    buys: [{ i: 'sweets', p: 1 }, { i: 'apple', p: 1 }]
  },

  {
    id: 'yuri', name: 'Yuri', emoji: '🎣', color: '#3d5a80', job: 'the fisherman',
    persona: 'Dreamy and philosophical, half asleep, answers questions with questions about fish.',
    x: 12, y: 67, home: { x: 6, y: 66, w: 11, h: 2 },
    voice: { gender: 'male', age: 'middle' },
    workRect: { x: 6, y: 65, w: 12, h: 3 }, workLabel: 'the lake',
    sells: [{ i: 'fish', p: 2 }, { i: 'rope', p: 3 }],
    buys: [{ i: 'bread', p: 2 }, { i: 'beer', p: 2 }]
  },

  {
    id: 'sanna', name: 'Sanna', emoji: '🍺', color: '#c46d3f', job: 'the innkeeper',
    persona: 'Loud, welcoming, remembers what everyone drinks and nothing else. Talks over you cheerfully.',
    x: 65, y: 56, home: { x: 61, y: 55, w: 9, h: 3 },
    voice: { gender: 'female', age: 'middle' },
    workplace: 'Inn',
    sells: [{ i: 'beer', p: 2 }, { i: 'soup', p: 2 }, { i: 'wine', p: 4 }, { i: 'bread', p: 2 }],
    buys: [{ i: 'fish', p: 2 }, { i: 'meat', p: 3 }, { i: 'wheat', p: 2 }]
  },

  {
    id: 'tomas', name: 'Tomas', emoji: '🔨', color: '#7a5c3e', job: 'the blacksmith',
    persona: 'Deliberate and deaf in one ear. Says "eh?" a lot and answers a beat late, then very precisely.',
    x: 49, y: 84, home: { x: 45, y: 83, w: 9, h: 3 },
    voice: { gender: 'male', age: 'old' },
    workplace: 'Smithy',
    sells: [{ i: 'hammer', p: 4 }, { i: 'screw', p: 1 }, { i: 'knife', p: 3 }, { i: 'key', p: 3 }, { i: 'chain', p: 4 }],
    buys: [{ i: 'stone', p: 1 }, { i: 'log', p: 2 }]
  },

  {
    id: 'rosa', name: 'Rosa', emoji: '📚', color: '#4f7a52', job: 'the schoolteacher',
    persona: 'Precise and kind. Repeats your sentence back correctly before answering it, without making a fuss of it.',
    x: 16, y: 83, home: { x: 12, y: 82, w: 9, h: 3 },
    voice: { gender: 'female', age: 'old' },
    workplace: 'School',
    sells: [{ i: 'book', p: 4 }, { i: 'paper', p: 1 }, { i: 'pencil', p: 1 }, { i: 'pen', p: 2 }],
    buys: [{ i: 'feather', p: 1 }, { i: 'paper', p: 1 }]
  },

  {
    id: 'kesh', name: 'Kesh', emoji: '⚙️', color: '#8a8478', job: 'the miller',
    persona: 'Anxious and always mid-task. Talks while working and keeps losing the thread of what he was saying.',
    x: 71, y: 83, home: { x: 66, y: 82, w: 9, h: 3 },
    voice: { gender: 'male', age: 'young' },
    workplace: 'Mill',
    sells: [{ i: 'wheat', p: 2 }, { i: 'rice', p: 2 }, { i: 'noodles', p: 2 }],
    buys: [{ i: 'wheat', p: 1 }, { i: 'corn', p: 1 }]
  },

  {
    id: 'wren', name: 'Wren', emoji: '🐝', color: '#d9a441', job: 'the beekeeper',
    persona: 'Soft-spoken and easily distracted, trails off mid-sentence to look at something. Unbothered by everything.',
    x: 70, y: 68, home: { x: 63, y: 66, w: 14, h: 6 },
    voice: { gender: 'female', age: 'young' },
    workRect: { x: 63, y: 64, w: 14, h: 7 }, workLabel: 'the apiary',
    sells: [{ i: 'honey', p: 4 }, { i: 'candle', p: 2 }, { i: 'flower', p: 1 }],
    buys: [{ i: 'flower', p: 1 }, { i: 'herbs', p: 1 }]
  },

  {
    id: 'mikhalych', name: 'Mikhalych', emoji: '🍚', color: '#a26769', job: 'the rice merchant',
    persona: 'Old, unhurried, and certain. Never says "I don\'t know" \u2014 he would rather send you somewhere than send you away. Measures the world in bowls.',
    x: 73, y: 61, home: { x: 72, y: 60, w: 4, h: 2 },
    voice: { gender: 'male', age: 'old' },
    workplace: 'Hut',
    sells: [{ i: 'rice', p: 2 }, { i: 'noodles', p: 2 }, { i: 'tea', p: 2 }, { i: 'basket', p: 3 }],
    buys: [{ i: 'wheat', p: 2 }, { i: 'corn', p: 1 }]
  },

  {
    id: 'ilya', name: 'Ilya', emoji: '🪵', color: '#6b4a2f', job: 'the woodcutter',
    persona: 'Says little, and what he says is dry. Answers questions with one word unless the subject is trees.',
    x: 19, y: 65, home: { x: 16, y: 63, w: 8, h: 7 },
    voice: { gender: 'male', age: 'middle' },
    workRect: { x: 16, y: 63, w: 8, h: 7 }, workLabel: 'the grove',
    sells: [{ i: 'log', p: 2 }, { i: 'rope', p: 3 }, { i: 'mushrooms', p: 2 }, { i: 'chestnut', p: 1 }],
    buys: [{ i: 'axe', p: 4 }, { i: 'saw', p: 4 }]
  }
];

/* ---------------------------------------------------- gossip mutterings
   Filler lines shown as speech bubbles when villagers chat without an
   API key available (see LG.dialogue.chatterLine). */
LG.CHATTER = {
  ru: ['Слышал новость?', 'Да ты что!', 'Ага, точно.', 'Не может быть!'],
  en: ['Did you hear?', "You don't say!", "Aye, that's right.", 'Never!'],
  zh: ['你听说了吗？', '真的吗！', '对，没错。', '不会吧！'],
  ja: ['聞いた？', 'まさか！', 'そうそう。', '本当に？'],
  fr: ['Tu as entendu ?', 'Sans blague !', "Oui, c'est ça.", 'Pas possible !'],
  es: ['¿Te has enterado?', '¡No me digas!', 'Sí, eso es.', '¡No puede ser!'],
  ar: ['سمعت؟', 'مستحيل!', 'نعم، هذا صحيح.', 'لا يمكن!'],
  pl: ['Słyszałeś?', 'Co ty powiesz!', 'No, zgadza się.', 'Nigdy!'],
  tok: ['sina kute ala kute e ni?', 'a! lon ala!', 'lon. ni li lon.', 'ken ala!']
};

/* ------------------------------------------------------------ phrasebook
   Clickable starter phrases for the player. Keep these SHORT — they're
   training wheels, not full sentences to study.

   These are the player's own lines, several addressed directly to the
   villager — a different register from LG.TXN's impersonal captions.
   Unlike LG.TXN's Arabic (which avoids gendering the player), these use
   the masculine second-person form and leave it there, matching the
   ordinary convention of a phrasebook (rather than a public notice, which
   avoids assuming who's reading it). */
LG.PHRASES = [
  { en: 'Hello!', ru: 'Привет!', zh: '你好！', fr: 'Bonjour !', es: '¡Hola!', ja: 'こんにちは！', ar: 'مرحباً!', pl: 'Cześć!', tok: 'toki!' },
  { en: 'Who are you?', ru: 'Кто ты?', zh: '你是谁？', fr: 'Qui es-tu ?', es: '¿Quién eres?', ja: 'あなたはだれですか？', ar: 'من أنت؟', pl: 'Kim jesteś?', tok: 'sina jan seme?' },
  {
    en: 'What is your name?', ru: 'Как тебя зовут?', zh: '你叫什么名字？',
    fr: "Comment tu t'appelles ?", es: '¿Cómo te llamas?', ja: 'お名前は何ですか？',
    jaRuby: 'お<ruby>名前<rt>なまえ</rt></ruby>は<ruby>何<rt>なん</rt></ruby>ですか？',
    ar: 'ما اسمك؟', pl: 'Jak masz na imię?', tok: 'nimi sina li seme?'
  },
  {
    en: 'What do you need?', ru: 'Что тебе нужно?', zh: '你需要什么？', fr: 'De quoi as-tu besoin ?', es: '¿Qué necesitas?', ja: '何がいりますか？',
    jaRuby: '<ruby>何<rt>なに</rt></ruby>がいりますか？',
    ar: 'ماذا تحتاج؟', pl: 'Czego potrzebujesz?', tok: 'sina wile e seme?'
  },
  {
    en: 'Can you help me?', ru: 'Ты можешь мне помочь?', zh: '你能帮我吗？', fr: 'Peux-tu m’aider ?', es: '¿Puedes ayudarme?', ja: '手伝ってくれますか？',
    jaRuby: '<ruby>手伝<rt>てつだ</rt></ruby>ってくれますか？',
    ar: 'هل يمكنك مساعدتي؟', pl: 'Możesz mi pomóc?', tok: 'sina ken ala ken pana e pona tawa mi?'
  },
  {
    en: 'Who has it?', ru: 'У кого это есть?', zh: '谁有？', fr: 'Qui l’a ?', es: '¿Quién lo tiene?', ja: 'だれが持っていますか？',
    jaRuby: 'だれが<ruby>持<rt>も</rt></ruby>っていますか？',
    ar: 'من لديه؟', pl: 'Kto to ma?', tok: 'jan seme li jo e ona?'
  },
  { en: 'Where is it?', ru: 'Где это?', zh: '在哪里？', fr: 'Où est-ce ?', es: '¿Dónde está?', ja: 'どこにありますか？', ar: 'أين هو؟', pl: 'Gdzie to jest?', tok: 'ona li lon seme?' },
  {
    en: 'I have it!', ru: 'У меня есть!', zh: '我有！', fr: 'Je l’ai !', es: '¡Lo tengo!', ja: '持っています！',
    jaRuby: '<ruby>持<rt>も</rt></ruby>っています！',
    ar: 'عندي!', pl: 'Mam to!', tok: 'mi jo e ona!'
  },
  { en: 'Here you go.', ru: 'Вот, держи.', zh: '给你。', fr: 'Tiens.', es: 'Toma.', ja: 'はい、どうぞ。', ar: 'تفضل.', pl: 'Proszę.', tok: 'ni li tawa sina.' },
  { en: 'How much does it cost?', ru: 'Сколько это стоит?', zh: '这个多少钱？', fr: 'Ça coûte combien ?', es: '¿Cuánto cuesta?', ja: 'いくらですか？', ar: 'كم يكلف؟', pl: 'Ile to kosztuje?', tok: 'ni li mani seme?' },
  { en: 'Thank you!', ru: 'Спасибо!', zh: '谢谢！', fr: 'Merci !', es: '¡Gracias!', ja: 'ありがとう！', ar: 'شكراً!', pl: 'Dziękuję!', tok: 'pona!' },
  { en: "I don't understand.", ru: 'Я не понимаю.', zh: '我不明白。', fr: 'Je ne comprends pas.', es: 'No entiendo.', ja: 'わかりません。', ar: 'لا أفهم.', pl: 'Nie rozumiem.', tok: 'mi sona ala.' },
  {
    en: 'Say that again, slowly.', ru: 'Повтори, медленно.', zh: '请再说一遍，慢一点。', fr: 'Répète, lentement.', es: 'Repite, despacio.', ja: 'もう一度、ゆっくり言ってください。',
    jaRuby: 'もう<ruby>一度<rt>いちど</rt></ruby>、ゆっくり<ruby>言<rt>い</rt></ruby>ってください。',
    ar: 'قل ذلك مرة أخرى، ببطء.', pl: 'Powtórz to, powoli.', tok: 'o toki sin kepeken tenpo suli.'
  }
];

/* --------------------------------------------------------- the school
   Two pieces of teaching material on the school's shelf and wall, keyed
   by village language exactly like everything else above.

   LG.BOOKS is one real, public-domain-old excerpt per language, at a
   level a beginner could plausibly be handed -- a children's classic or
   a folktale's traditional opening -- rather than invented sample text,
   the same principle behind everything else the player reads in-game
   (see itemSaid above). Short on purpose: a line or two to read on the
   shelf, not the whole book. `en` glosses each line, same click-to-reveal
   convention as the noticeboard; the English entry has nothing to gloss,
   so its lines carry no `en` at all.

   toki pona has no novel of its own to excerpt with any confidence of
   quoting it correctly, so its "book" is `pu` -- toki pona's own name for
   its official source text (Sonja Lang's Toki Pona: The Language of
   Good) -- shown as two of the first sentences a learner actually meets,
   not a passage claimed to be copied from somewhere. */
LG.BOOKS = {
  ru: {
    title: 'Сказка о рыбаке и рыбке', titleEn: 'The Tale of the Fisherman and the Fish', author: 'Александр Пушкин',
    lines: [
      { text: 'Жил старик со своею старухой', en: 'There lived an old man with his old wife' },
      { text: 'У самого синего моря;', en: 'By the very edge of the blue sea;' }
    ]
  },
  en: {
    title: 'The Tale of Peter Rabbit', author: 'Beatrix Potter',
    lines: [
      { text: 'Once upon a time there were four little Rabbits,' },
      { text: 'and their names were— Flopsy, Mopsy, Cotton-tail, and Peter.' }
    ]
  },
  zh: {
    title: '静夜思', titleEn: 'Quiet Night Thoughts', author: '李白',
    lines: [
      { text: '床前明月光，', en: 'Before my bed, the bright moonlight,' },
      { text: '疑是地上霜。', en: 'I took it for frost on the ground.' },
      { text: '举头望明月，', en: 'I raise my head to gaze at the bright moon,' },
      { text: '低头思故乡。', en: 'I lower it, thinking of home.' }
    ]
  },
  fr: {
    // The user's own reference point for this feature, so it gets the
    // most recognizable line in the book rather than the technically-first one.
    title: 'Le Petit Prince', titleEn: 'The Little Prince', author: 'Antoine de Saint-Exupéry',
    lines: [
      { text: '– S’il vous plaît… dessine-moi un mouton !', en: '– Please... draw me a sheep!' },
      { text: 'Alors j’ai fait le dessin d’un mouton.', en: 'So I made a drawing of a sheep.' }
    ]
  },
  es: {
    title: 'Don Quijote de la Mancha', titleEn: 'Don Quixote', author: 'Miguel de Cervantes',
    lines: [
      { text: 'En un lugar de la Mancha,', en: 'In a village of La Mancha,' },
      { text: 'de cuyo nombre no quiero acordarme,', en: 'whose name I do not care to remember,' }
    ]
  },
  pl: {
    title: 'Pan Tadeusz', author: 'Adam Mickiewicz',
    lines: [
      { text: 'Litwo! Ojczyzno moja! ty jesteś jak zdrowie:', en: 'Lithuania, my homeland! You are like health:' },
      { text: 'Ile cię trzeba cenić, ten tylko się dowie,', en: 'how much you must be valued, only he will learn' },
      { text: 'Kto cię stracił.', en: 'who has lost you.' }
    ]
  },
  ar: {
    title: 'ألف ليلة وليلة', titleEn: 'One Thousand and One Nights',
    lines: [
      { text: 'كَانَ يَا مَا كَانَ فِي قَدِيمِ الزَّمَانِ...', en: 'Once upon a time, in ancient days...' },
      { text: 'بَلَغَنِي أَيُّهَا الْمَلِكُ السَّعِيدُ أَنَّ...', en: 'It has reached me, O Happy King, that...' }
    ]
  },
  ja: {
    title: '桃太郎', titleEn: 'Momotaro (Peach Boy)',
    lines: [
      { text: 'むかしむかし、あるところに、', en: 'Once upon a time, in a certain place,' },
      { text: 'おじいさんとおばあさんが いました。', en: 'there lived an old man and an old woman.' }
    ]
  },
  tok: {
    title: 'pu', titleEn: 'the official toki pona reader', author: 'jan Sonja',
    lines: [
      { text: 'jan lili li lon.', en: 'There is a small person.' },
      { text: 'ona li pona.', en: 'They are good.' }
    ]
  }
};

/* LG.ALPHABET is the wall board: one letter, one everyday word that uses
   it, one picture. French, Spanish, Polish, Russian, Arabic and toki pona
   all have an actual alphabet, so those go A-to-Z (toki pona's is famously
   tiny -- fourteen letters, all of them here). Chinese and Japanese don't,
   so each gets the nearest real equivalent instead of an invented one.

   Japanese gets the gojūon kana chart every Japanese classroom actually
   hangs on the wall. Chinese gets radicals (部首) that are also complete
   characters on their own -- what a radical-indexed dictionary lists as
   that radical's "+0 strokes" entry, when one exists. Not every radical
   qualifies (讠 and 辶, say, are never standalone words), but a couple
   hundred of the 214 Kangxi radicals are, and these forty are common,
   everyday ones spread across the full index rather than clustered at
   the pictographic low end -- systematic rather than a curated top-of-
   the-primer list, and closer to how a real dictionary actually presents
   the writing system's building blocks.

   A few letters can't start a native word at all (Russian ъ/ы, Polish
   ą/ę/ń/ó/y, Japanese を/ん) -- real children's primers handle this by
   showing a word that *contains* or *ends with* the letter instead, and
   these entries do the same, noted in `en`. */

/* The board's own title, shown on the panel itself instead of an English
   UI label -- the village's own word for "alphabet", or the nearest real
   equivalent for the two languages that don't have one: 部首表 ("radical
   table") for Chinese, 五十音表 ("the fifty-sound table") for Japanese --
   both the actual names of the real charts these boards are modeled on,
   not translations of "alphabet". */
LG.ALPHABET_NAME = {
  en: 'The Alphabet', fr: 'L’alphabet', es: 'El alfabeto', pl: 'Alfabet',
  ru: 'Алфавит', ar: 'الأبجدية', tok: 'sitelen', zh: '部首表', ja: '五十音表'
};

LG.ALPHABET = {
  en: [
    { ch: 'A', word: 'apple', emoji: '🍎' }, { ch: 'B', word: 'ball', emoji: '⚽' },
    { ch: 'C', word: 'cat', emoji: '🐱' }, { ch: 'D', word: 'dog', emoji: '🐶' },
    { ch: 'E', word: 'elephant', emoji: '🐘' }, { ch: 'F', word: 'fish', emoji: '🐟' },
    { ch: 'G', word: 'giraffe', emoji: '🦒' }, { ch: 'H', word: 'house', emoji: '🏠' },
    { ch: 'I', word: 'ice cream', emoji: '🍦' }, { ch: 'J', word: 'jam', emoji: '🍯' },
    { ch: 'K', word: 'kite', emoji: '🪁' }, { ch: 'L', word: 'lion', emoji: '🦁' },
    { ch: 'M', word: 'moon', emoji: '🌙' }, { ch: 'N', word: 'nest', emoji: '🪺' },
    { ch: 'O', word: 'owl', emoji: '🦉' }, { ch: 'P', word: 'pig', emoji: '🐷' },
    { ch: 'Q', word: 'queen', emoji: '👑' }, { ch: 'R', word: 'rainbow', emoji: '🌈' },
    { ch: 'S', word: 'sun', emoji: '☀️' }, { ch: 'T', word: 'tree', emoji: '🌳' },
    { ch: 'U', word: 'umbrella', emoji: '☂️' }, { ch: 'V', word: 'violin', emoji: '🎻' },
    { ch: 'W', word: 'whale', emoji: '🐳' }, { ch: 'X', word: 'xylophone', emoji: '🎵' },
    { ch: 'Y', word: 'yo-yo', emoji: '🪀' }, { ch: 'Z', word: 'zebra', emoji: '🦓' }
  ],
  fr: [
    { ch: 'A', word: 'avion', en: 'airplane', emoji: '✈️' }, { ch: 'B', word: 'ballon', en: 'ball', emoji: '⚽' },
    { ch: 'C', word: 'chat', en: 'cat', emoji: '🐱' }, { ch: 'D', word: 'dauphin', en: 'dolphin', emoji: '🐬' },
    { ch: 'E', word: 'éléphant', en: 'elephant', emoji: '🐘' }, { ch: 'F', word: 'fleur', en: 'flower', emoji: '🌸' },
    { ch: 'G', word: 'girafe', en: 'giraffe', emoji: '🦒' }, { ch: 'H', word: 'hibou', en: 'owl', emoji: '🦉' },
    { ch: 'I', word: 'île', en: 'island', emoji: '🏝️' }, { ch: 'J', word: 'jardin', en: 'garden', emoji: '🏡' },
    { ch: 'K', word: 'kangourou', en: 'kangaroo', emoji: '🦘' }, { ch: 'L', word: 'lune', en: 'moon', emoji: '🌙' },
    { ch: 'M', word: 'maison', en: 'house', emoji: '🏠' }, { ch: 'N', word: 'nuage', en: 'cloud', emoji: '☁️' },
    { ch: 'O', word: 'oiseau', en: 'bird', emoji: '🐦' }, { ch: 'P', word: 'poisson', en: 'fish', emoji: '🐟' },
    { ch: 'Q', word: 'quatre', en: 'four', emoji: '4️⃣' }, { ch: 'R', word: 'renard', en: 'fox', emoji: '🦊' },
    { ch: 'S', word: 'soleil', en: 'sun', emoji: '☀️' }, { ch: 'T', word: 'tortue', en: 'turtle', emoji: '🐢' },
    { ch: 'U', word: 'usine', en: 'factory', emoji: '🏭' }, { ch: 'V', word: 'vélo', en: 'bicycle', emoji: '🚲' },
    { ch: 'W', word: 'wagon', en: 'train car', emoji: '🚃' }, { ch: 'X', word: 'xylophone', en: 'xylophone', emoji: '🎵' },
    { ch: 'Y', word: 'yaourt', en: 'yogurt', emoji: '🍦' }, { ch: 'Z', word: 'zèbre', en: 'zebra', emoji: '🦓' }
  ],
  es: [
    { ch: 'A', word: 'araña', en: 'spider', emoji: '🕷️' }, { ch: 'B', word: 'barco', en: 'boat', emoji: '⛵' },
    { ch: 'C', word: 'casa', en: 'house', emoji: '🏠' }, { ch: 'D', word: 'delfín', en: 'dolphin', emoji: '🐬' },
    { ch: 'E', word: 'elefante', en: 'elephant', emoji: '🐘' }, { ch: 'F', word: 'flor', en: 'flower', emoji: '🌸' },
    { ch: 'G', word: 'gato', en: 'cat', emoji: '🐱' }, { ch: 'H', word: 'helado', en: 'ice cream', emoji: '🍦' },
    { ch: 'I', word: 'isla', en: 'island', emoji: '🏝️' }, { ch: 'J', word: 'jirafa', en: 'giraffe', emoji: '🦒' },
    { ch: 'K', word: 'koala', en: 'koala', emoji: '🐨' }, { ch: 'L', word: 'luna', en: 'moon', emoji: '🌙' },
    { ch: 'M', word: 'mono', en: 'monkey', emoji: '🐒' }, { ch: 'N', word: 'nube', en: 'cloud', emoji: '☁️' },
    { ch: 'Ñ', word: 'ñu', en: 'wildebeest', emoji: '🐃' }, { ch: 'O', word: 'oso', en: 'bear', emoji: '🐻' },
    { ch: 'P', word: 'pez', en: 'fish', emoji: '🐟' }, { ch: 'Q', word: 'queso', en: 'cheese', emoji: '🧀' },
    { ch: 'R', word: 'ratón', en: 'mouse', emoji: '🐭' }, { ch: 'S', word: 'sol', en: 'sun', emoji: '☀️' },
    { ch: 'T', word: 'tigre', en: 'tiger', emoji: '🐯' }, { ch: 'U', word: 'uva', en: 'grape', emoji: '🍇' },
    { ch: 'V', word: 'vaca', en: 'cow', emoji: '🐮' }, { ch: 'W', word: 'waterpolo', en: 'water polo', emoji: '🤽' },
    { ch: 'X', word: 'xilófono', en: 'xylophone', emoji: '🎵' }, { ch: 'Y', word: 'yoyó', en: 'yo-yo', emoji: '🪀' },
    { ch: 'Z', word: 'zorro', en: 'fox', emoji: '🦊' }
  ],
  pl: [
    { ch: 'A', word: 'auto', en: 'car', emoji: '🚗' },
    { ch: 'Ą', word: 'wąż', en: 'snake (contains ą -- almost nothing starts with it)', emoji: '🐍' },
    { ch: 'B', word: 'banan', en: 'banana', emoji: '🍌' }, { ch: 'C', word: 'cebula', en: 'onion', emoji: '🧅' },
    { ch: 'Ć', word: 'ćma', en: 'moth', emoji: '🦋' }, { ch: 'D', word: 'dom', en: 'house', emoji: '🏠' },
    { ch: 'E', word: 'ekran', en: 'screen', emoji: '🖥️' },
    { ch: 'Ę', word: 'ręka', en: 'hand (contains ę -- it almost never starts a word)', emoji: '✋' },
    { ch: 'F', word: 'fasola', en: 'bean', emoji: '🫘' }, { ch: 'G', word: 'gwiazda', en: 'star', emoji: '⭐' },
    { ch: 'H', word: 'helikopter', en: 'helicopter', emoji: '🚁' }, { ch: 'I', word: 'igła', en: 'needle', emoji: '🪡' },
    { ch: 'J', word: 'jabłko', en: 'apple', emoji: '🍎' }, { ch: 'K', word: 'kot', en: 'cat', emoji: '🐱' },
    { ch: 'L', word: 'lampa', en: 'lamp', emoji: '💡' }, { ch: 'Ł', word: 'łódź', en: 'boat', emoji: '⛵' },
    { ch: 'M', word: 'mysz', en: 'mouse', emoji: '🐭' }, { ch: 'N', word: 'noc', en: 'night', emoji: '🌃' },
    { ch: 'Ń', word: 'koń', en: 'horse (ends in ń -- it never starts a word)', emoji: '🐴' },
    { ch: 'O', word: 'okno', en: 'window', emoji: '🪟' },
    { ch: 'Ó', word: 'ósmy', en: 'eighth', emoji: '8️⃣' },
    { ch: 'P', word: 'pies', en: 'dog', emoji: '🐶' }, { ch: 'R', word: 'ryba', en: 'fish', emoji: '🐟' },
    { ch: 'S', word: 'słońce', en: 'sun', emoji: '☀️' }, { ch: 'Ś', word: 'śnieg', en: 'snow', emoji: '❄️' },
    { ch: 'T', word: 'tygrys', en: 'tiger', emoji: '🐯' }, { ch: 'U', word: 'ucho', en: 'ear', emoji: '👂' },
    { ch: 'W', word: 'woda', en: 'water', emoji: '💧' },
    { ch: 'Y', word: 'syn', en: 'son (contains y -- nothing in Polish starts with it)', emoji: '👦' },
    { ch: 'Z', word: 'zebra', en: 'zebra', emoji: '🦓' }, { ch: 'Ź', word: 'źrebię', en: 'foal', emoji: '🐎' },
    { ch: 'Ż', word: 'żaba', en: 'frog', emoji: '🐸' }
  ],
  ru: [
    { ch: 'А', word: 'арбуз', en: 'watermelon', emoji: '🍉' }, { ch: 'Б', word: 'банан', en: 'banana', emoji: '🍌' },
    { ch: 'В', word: 'вода', en: 'water', emoji: '💧' }, { ch: 'Г', word: 'гриб', en: 'mushroom', emoji: '🍄' },
    { ch: 'Д', word: 'дом', en: 'house', emoji: '🏠' }, { ch: 'Е', word: 'ель', en: 'fir tree', emoji: '🌲' },
    { ch: 'Ё', word: 'ёж', en: 'hedgehog', emoji: '🦔' }, { ch: 'Ж', word: 'жираф', en: 'giraffe', emoji: '🦒' },
    { ch: 'З', word: 'змея', en: 'snake', emoji: '🐍' }, { ch: 'И', word: 'игрушка', en: 'toy', emoji: '🧸' },
    { ch: 'Й', word: 'йогурт', en: 'yogurt', emoji: '🍦' }, { ch: 'К', word: 'кот', en: 'cat', emoji: '🐱' },
    { ch: 'Л', word: 'лиса', en: 'fox', emoji: '🦊' }, { ch: 'М', word: 'мяч', en: 'ball', emoji: '⚽' },
    { ch: 'Н', word: 'нос', en: 'nose', emoji: '👃' }, { ch: 'О', word: 'облако', en: 'cloud', emoji: '☁️' },
    { ch: 'П', word: 'пчела', en: 'bee', emoji: '🐝' }, { ch: 'Р', word: 'рыба', en: 'fish', emoji: '🐟' },
    { ch: 'С', word: 'слон', en: 'elephant', emoji: '🐘' }, { ch: 'Т', word: 'тигр', en: 'tiger', emoji: '🐯' },
    { ch: 'У', word: 'утка', en: 'duck', emoji: '🦆' }, { ch: 'Ф', word: 'флаг', en: 'flag', emoji: '🚩' },
    { ch: 'Х', word: 'хлеб', en: 'bread', emoji: '🍞' }, { ch: 'Ц', word: 'цветок', en: 'flower', emoji: '🌸' },
    { ch: 'Ч', word: 'чашка', en: 'cup', emoji: '☕' }, { ch: 'Ш', word: 'шар', en: 'balloon', emoji: '🎈' },
    { ch: 'Щ', word: 'щенок', en: 'puppy', emoji: '🐶' },
    { ch: 'Ъ', word: 'объект', en: 'object (contains ъ -- nothing starts with it)', emoji: '📦' },
    { ch: 'Ы', word: 'мыло', en: 'soap (contains ы -- nothing starts with it either)', emoji: '🧼' },
    { ch: 'Ь', word: 'мышь', en: 'mouse (ends in ь -- it never starts a word)', emoji: '🐭' },
    { ch: 'Э', word: 'экскаватор', en: 'excavator', emoji: '🚜' }, { ch: 'Ю', word: 'юла', en: 'spinning top', emoji: '🪀' },
    { ch: 'Я', word: 'яблоко', en: 'apple', emoji: '🍎' }
  ],
  ar: [
    { ch: 'ا', word: 'أَسَد', en: 'lion', emoji: '🦁' }, { ch: 'ب', word: 'بَطَّة', en: 'duck', emoji: '🦆' },
    { ch: 'ت', word: 'تُفَّاحَة', en: 'apple', emoji: '🍎' }, { ch: 'ث', word: 'ثَعْلَب', en: 'fox', emoji: '🦊' },
    { ch: 'ج', word: 'جَمَل', en: 'camel', emoji: '🐫' }, { ch: 'ح', word: 'حِصَان', en: 'horse', emoji: '🐴' },
    { ch: 'خ', word: 'خَرُوف', en: 'sheep', emoji: '🐑' }, { ch: 'د', word: 'دَجَاجَة', en: 'hen', emoji: '🐔' },
    { ch: 'ذ', word: 'ذِئْب', en: 'wolf', emoji: '🐺' }, { ch: 'ر', word: 'رَجُل', en: 'man', emoji: '🧑' },
    { ch: 'ز', word: 'زَرَافَة', en: 'giraffe', emoji: '🦒' }, { ch: 'س', word: 'سَمَكَة', en: 'fish', emoji: '🐟' },
    { ch: 'ش', word: 'شَمْس', en: 'sun', emoji: '☀️' }, { ch: 'ص', word: 'صَقْر', en: 'falcon', emoji: '🦅' },
    { ch: 'ض', word: 'ضِفْدَع', en: 'frog', emoji: '🐸' }, { ch: 'ط', word: 'طَائِر', en: 'bird', emoji: '🐦' },
    { ch: 'ظ', word: 'ظَرْف', en: 'envelope', emoji: '✉️' }, { ch: 'ع', word: 'عَيْن', en: 'eye', emoji: '👁️' },
    { ch: 'غ', word: 'غَزَال', en: 'gazelle', emoji: '🦌' }, { ch: 'ف', word: 'فِيل', en: 'elephant', emoji: '🐘' },
    { ch: 'ق', word: 'قِطَّة', en: 'cat', emoji: '🐱' }, { ch: 'ك', word: 'كَلْب', en: 'dog', emoji: '🐶' },
    { ch: 'ل', word: 'لَيْمُون', en: 'lemon', emoji: '🍋' }, { ch: 'م', word: 'مَوْز', en: 'banana', emoji: '🍌' },
    { ch: 'ن', word: 'نَجْمَة', en: 'star', emoji: '⭐' }, { ch: 'ه', word: 'هِلَال', en: 'crescent moon', emoji: '🌙' },
    { ch: 'و', word: 'وَرْدَة', en: 'rose', emoji: '🌹' }, { ch: 'ي', word: 'يَد', en: 'hand', emoji: '✋' }
  ],
  tok: [
    { ch: 'a', word: 'akesi', en: 'reptile', emoji: '🦎' }, { ch: 'e', word: 'esun', en: 'market', emoji: '🏪' },
    { ch: 'i', word: 'ijo', en: 'thing', emoji: '📦' }, { ch: 'j', word: 'jan', en: 'person', emoji: '🧑' },
    { ch: 'k', word: 'kili', en: 'fruit', emoji: '🍎' }, { ch: 'l', word: 'lipu', en: 'paper, book', emoji: '📄' },
    { ch: 'm', word: 'moku', en: 'food', emoji: '🍽️' }, { ch: 'n', word: 'nasin', en: 'path, way', emoji: '🛤️' },
    { ch: 'o', word: 'oko', en: 'eye', emoji: '👁️' }, { ch: 'p', word: 'pipi', en: 'bug', emoji: '🐛' },
    { ch: 's', word: 'suno', en: 'sun', emoji: '☀️' }, { ch: 't', word: 'telo', en: 'water', emoji: '💧' },
    { ch: 'u', word: 'uta', en: 'mouth', emoji: '👄' }, { ch: 'w', word: 'waso', en: 'bird', emoji: '🐦' }
  ],
  // Ordered by Kangxi radical number (1 through 196), not grouped by
  // meaning -- the same "systematic, not curated" logic as an alphabet
  // going A-to-Z. `word` is the pinyin reading, same tone-marked
  // convention as everywhere else zh is romanized (see romanNote above).
  zh: [
    { ch: '一', word: 'yī', en: 'one', emoji: '1️⃣' }, { ch: '人', word: 'rén', en: 'person', emoji: '🧑' },
    { ch: '八', word: 'bā', en: 'eight', emoji: '8️⃣' }, { ch: '刀', word: 'dāo', en: 'knife', emoji: '🔪' },
    { ch: '力', word: 'lì', en: 'strength', emoji: '💪' }, { ch: '十', word: 'shí', en: 'ten', emoji: '🔟' },
    { ch: '口', word: 'kǒu', en: 'mouth', emoji: '👄' }, { ch: '土', word: 'tǔ', en: 'earth, soil', emoji: '🟫' },
    { ch: '大', word: 'dà', en: 'big', emoji: '🦣' }, { ch: '女', word: 'nǚ', en: 'woman', emoji: '👩' },
    { ch: '子', word: 'zǐ', en: 'child', emoji: '👶' }, { ch: '小', word: 'xiǎo', en: 'small', emoji: '🤏' },
    { ch: '山', word: 'shān', en: 'mountain', emoji: '⛰️' }, { ch: '工', word: 'gōng', en: 'work', emoji: '🔧' },
    { ch: '心', word: 'xīn', en: 'heart', emoji: '❤️' }, { ch: '手', word: 'shǒu', en: 'hand', emoji: '✋' },
    { ch: '日', word: 'rì', en: 'sun', emoji: '☀️' }, { ch: '月', word: 'yuè', en: 'moon', emoji: '🌙' },
    { ch: '木', word: 'mù', en: 'tree', emoji: '🌳' }, { ch: '水', word: 'shuǐ', en: 'water', emoji: '💧' },
    { ch: '火', word: 'huǒ', en: 'fire', emoji: '🔥' }, { ch: '父', word: 'fù', en: 'father', emoji: '👨' },
    { ch: '牛', word: 'niú', en: 'ox, cow', emoji: '🐮' }, { ch: '犬', word: 'quǎn', en: 'dog', emoji: '🐕' },
    { ch: '生', word: 'shēng', en: 'life, to be born', emoji: '🌱' }, { ch: '田', word: 'tián', en: 'field', emoji: '🌾' },
    { ch: '白', word: 'bái', en: 'white', emoji: '⚪' }, { ch: '目', word: 'mù', en: 'eye', emoji: '👁️' },
    { ch: '石', word: 'shí', en: 'stone', emoji: '🪨' }, { ch: '米', word: 'mǐ', en: 'rice', emoji: '🍚' },
    { ch: '羊', word: 'yáng', en: 'sheep', emoji: '🐑' }, { ch: '耳', word: 'ěr', en: 'ear', emoji: '👂' },
    { ch: '虫', word: 'chóng', en: 'insect', emoji: '🐛' }, { ch: '贝', word: 'bèi', en: 'shell', emoji: '🐚' },
    { ch: '走', word: 'zǒu', en: 'walk', emoji: '🚶' }, { ch: '车', word: 'chē', en: 'cart, vehicle', emoji: '🚗' },
    { ch: '门', word: 'mén', en: 'door', emoji: '🚪' }, { ch: '雨', word: 'yǔ', en: 'rain', emoji: '🌧️' },
    { ch: '鱼', word: 'yú', en: 'fish', emoji: '🐟' }, { ch: '鸟', word: 'niǎo', en: 'bird', emoji: '🐦' }
  ],
  ja: [
    { ch: 'あ', word: 'あり', en: 'ant', emoji: '🐜' }, { ch: 'い', word: 'いぬ', en: 'dog', emoji: '🐶' },
    { ch: 'う', word: 'うま', en: 'horse', emoji: '🐴' }, { ch: 'え', word: 'えき', en: 'station', emoji: '🚉' },
    { ch: 'お', word: 'おかし', en: 'sweets', emoji: '🍬' }, { ch: 'か', word: 'かさ', en: 'umbrella', emoji: '☂️' },
    { ch: 'き', word: 'き', en: 'tree', emoji: '🌳' }, { ch: 'く', word: 'くも', en: 'cloud', emoji: '☁️' },
    { ch: 'け', word: 'けむり', en: 'smoke', emoji: '💨' }, { ch: 'こ', word: 'こおり', en: 'ice', emoji: '🧊' },
    { ch: 'さ', word: 'さかな', en: 'fish', emoji: '🐟' }, { ch: 'し', word: 'しま', en: 'island', emoji: '🏝️' },
    { ch: 'す', word: 'すいか', en: 'watermelon', emoji: '🍉' }, { ch: 'せ', word: 'せかい', en: 'world', emoji: '🌍' },
    { ch: 'そ', word: 'そら', en: 'sky', emoji: '🌤️' }, { ch: 'た', word: 'たいよう', en: 'sun', emoji: '☀️' },
    { ch: 'ち', word: 'ちず', en: 'map', emoji: '🗺️' }, { ch: 'つ', word: 'つき', en: 'moon', emoji: '🌙' },
    { ch: 'て', word: 'て', en: 'hand', emoji: '✋' }, { ch: 'と', word: 'とり', en: 'bird', emoji: '🐦' },
    { ch: 'な', word: 'なつ', en: 'summer', emoji: '🏖️' }, { ch: 'に', word: 'にじ', en: 'rainbow', emoji: '🌈' },
    { ch: 'ぬ', word: 'ぬの', en: 'cloth', emoji: '🧵' }, { ch: 'ね', word: 'ねこ', en: 'cat', emoji: '🐱' },
    { ch: 'の', word: 'のはら', en: 'meadow', emoji: '🌾' }, { ch: 'は', word: 'はな', en: 'flower', emoji: '🌸' },
    { ch: 'ひ', word: 'ひ', en: 'fire', emoji: '🔥' }, { ch: 'ふ', word: 'ふね', en: 'boat', emoji: '🚢' },
    { ch: 'へ', word: 'へび', en: 'snake', emoji: '🐍' }, { ch: 'ほ', word: 'ほし', en: 'star', emoji: '⭐' },
    { ch: 'ま', word: 'まど', en: 'window', emoji: '🪟' }, { ch: 'み', word: 'みず', en: 'water', emoji: '💧' },
    { ch: 'む', word: 'むし', en: 'bug', emoji: '🐛' }, { ch: 'め', word: 'め', en: 'eye', emoji: '👁️' },
    { ch: 'も', word: 'もり', en: 'forest', emoji: '🌲' }, { ch: 'や', word: 'やま', en: 'mountain', emoji: '⛰️' },
    { ch: 'ゆ', word: 'ゆき', en: 'snow', emoji: '❄️' }, { ch: 'よ', word: 'よる', en: 'night', emoji: '🌃' },
    { ch: 'ら', word: 'らくだ', en: 'camel', emoji: '🐫' }, { ch: 'り', word: 'りんご', en: 'apple', emoji: '🍎' },
    { ch: 'る', word: 'るすばん', en: 'looking after the house while others are out', emoji: '🏠' },
    { ch: 'れ', word: 'れもん', en: 'lemon', emoji: '🍋' }, { ch: 'ろ', word: 'ろうそく', en: 'candle', emoji: '🕯️' },
    { ch: 'わ', word: 'わに', en: 'crocodile', emoji: '🐊' },
    { ch: 'を', word: 'を', en: '(marks the object of a verb -- a grammar particle, not a picture word)', emoji: '👉' },
    { ch: 'ん', word: 'ほん', en: 'book (ん never starts a word, only ends one)', emoji: '📕' }
  ]
};
