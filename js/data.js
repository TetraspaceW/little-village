/* data.js — languages, phrasebook, the item pool, places, and the six villagers.
   The quest chain itself is generated at runtime; see chain.js.
   Plain <script> (no modules) so the game runs from file:// by double-click. */
window.LG = window.LG || {};

/* `tag` and `romanTag` are BCP-47, and they are what goes in the `lang`
   attribute wherever a villager's words reach the page. A font stack is a
   request; `lang` is the fact, and the browser needs the fact: Han characters
   are shared between Chinese and Japanese but drawn differently in each, so an
   untagged 直 gets whichever of the two the browser happened to reach for. It
   also tells the line breaker, the spellchecker, an IME and a screen reader
   which language they are looking at — none of which a font can say.

   `zh-Hans` rather than plain `zh` because the village writes simplified, and
   `zh` alone leaves the browser to guess between the two scripts. The `-Latn`
   tags mark a romanisation for what it is: the same language written in Latin
   letters. Pinyin is still Chinese, just not in its own script — and tagging it
   `en` would invite an English spellchecker to underline every syllable. */
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
    // asking for "pinyin" alone got tone marks on some syllables and not others
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
    // Standard Arabic isn't a country, so there's no Unicode flag sequence
    // and no glyph for it in any emoji font. flag holds U+F0000 instead, a
    // made-up private-use codepoint that a custom one-glyph font (see
    // css/style.css's @font-face and tools/flags/README.md) resolves to a
    // hand-rendered Arab League flag matching the local Noto Color Emoji
    // style — everywhere else this string just goes into the DOM as text.
    // Overridden just below on Gecko, where that glyph doesn't survive
    // #setLang's own dropdown popup.
    name: 'Arabic (MSA)', native: 'العربية', flag: '\u{F0000}',
    tag: 'ar', romanTag: 'ar',
    // Bare Arabic script carries no short vowels, so an unvocalised sentence
    // is legible only to someone who already half knows it — no help at all
    // to a learner. A parallel Latin line is how zh and ja solve that, but
    // Arabic already has the tool built in: tashkeel, the diacritics that
    // children's books, the Qur'an and learner texts write and everyone
    // else omits. That is the native answer, not a transliteration bolted
    // on beside it — so `romanize` stays off and `diacritics` (below) asks
    // for full tashkeel in the Arabic itself, the same slot furigana fills
    // for kanji: an annotation on the actual script, not a second script.
    romanize: false,
    diacritics: true,
    // right-to-left is a fact about the script, the same as `tag` and
    // `fontStack` are; css/style.css keys off `lang="ar"` to set it, so
    // nothing that already tags a span with L.tag needs to change here
    fontStack: "'Noto Naskh Arabic', 'Noto Sans Arabic', system-ui, sans-serif"
  }
};

/* Gecko's own #setLang renders the closed box from page @font-face fonts
   fine, but its *open* dropdown popup — at least on Linux — doesn't
   consult page fonts for <option> text at all, so the custom glyph above
   shows there as a bare "no glyph anywhere" placeholder instead of a flag
   (see tools/flags/README.md's "Known limitation" section for how that
   was confirmed). A plain Unicode flag has no such gap, since it's drawn
   by the platform's own emoji font rather than a page-authored one — so
   Gecko gets Saudi Arabia's flag here instead of the custom glyph: not
   accurate to the Arab League, but a real flag beats a broken one.
   Sniffed by the Gecko+rv: pair MDN recommends over a bare "Firefox"
   check: the bug is a property of the engine, so this should catch any
   Gecko fork (Floorp included), and other engines are known to plant a
   "like Gecko" token specifically to dodge sniffing that checks for the
   word "Gecko" alone.
   https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Browser_detection_using_the_user_agent
   This DOM patch runs inline here rather than waiting for DOMContentLoaded
   because data.js loads at the end of <body>, after #setLang already
   exists in the parsed document — see index.html's script order. */
if (typeof navigator !== 'undefined' && /Gecko/.test(navigator.userAgent) && /rv:/.test(navigator.userAgent)) {
  LG.LANGUAGES.ar.flag = '\u{1F1F8}\u{1F1E6}';
  var arOption = document.querySelector('#setLang option[value="ar"]');
  if (arOption) {
    arOption.textContent = arOption.textContent.replace('\u{F0000}', '\u{1F1F8}\u{1F1E6}');
  }
}

/* Difficulty is how hard the village is to *read*, not how far you have to walk.
   Chain length is rolled per village (see `depth` below) and is the same range at
   every level, because length turned out to be a poor difficulty knob — a longer
   chain deals out more facts to more villagers, which gives you more places to
   break in, so a five-link errand could easily be easier than a two-link one.
   What difficulty actually sets is who knows what: `spread` is how many villagers
   beyond the owner are told a chain fact, `taper` takes holders away as you go
   deeper down the chain (so length now *buries* the tail instead of exposing it),
   and `gossip` is how much of the chain the village gossip has picked up — she is
   a skeleton key at beginner and knows nothing but opinions at advanced.

   `prompt` is how a villager speaks *to the traveller*, so it is written as
   accommodation — meeting a learner where they are. `register` is for villagers
   talking to each other, where accommodation would be absurd: they are natives and
   the player is only overhearing. At advanced it is empty, because two natives with
   nobody to accommodate simply talk.

   But overhearing is a mechanic, not scenery, so `register` still has to land near
   the level. The beginner line used to end — the way you talk when you are not
   thinking about it — which is an instruction to be unguarded, and it beat the
   plain-words clause in front of it every time: a beginner village gossiped in
   蔫了, 白拿人家东西 and 回头再聊. What a register constrains is the words and the
   sentences, so that is all it names now; who they are speaking to stays out of it,
   which is the whole reason it is not `prompt`. */
LG.DEPTH = [4, 7];                       // links per errand, rolled per village

/* How to write furigana — one spec, used by every call site that asks for it.

   It was five separate wordings before, and four of the five illustrated it with
   the bare word \u6f22\u5b57, which never shows what to do about okurigana. \u7d50\u3076 is exactly
   the ambiguous case, and with no example for it the model fell back to writing
   \u7d50\u3076[\u3080\u3059\u3076] \u2014 a perfectly normal plain-text convention that our markup
   was not expecting. The worked line below carries an okurigana word on purpose. */
LG.FURIGANA = [
  'Write the readings as ruby tags, inline: <ruby>\u6751<rt>\u3080\u3089</rt></ruby>',
  'Okurigana stays outside the tag \u2014 \u7d50\u3076 is <ruby>\u7d50<rt>\u3080\u3059</rt></ruby>\u3076, not <ruby>\u7d50\u3076<rt>\u3080\u3059\u3076</rt></ruby>.',
  'A whole line, annotated: \u4eca\u65e5\u306f<ruby>\u6751<rt>\u3080\u3089</rt></ruby>\u3067<ruby>\u4f55<rt>\u306a\u306b</rt></ruby>\u304b<ruby>\u805e<rt>\u304d</rt></ruby>\u3044\u305f\uff1f',
  'Kanji only \u2014 katakana and hiragana stay bare.',
  'The reading is of the whole word as it is actually pronounced, never the character readings stitched together: \u5927\u5de5 is \u3060\u3044\u304f, not \u3060\u3044\u3053\u3046.',
  'Ruby tags, not square brackets \u2014 \u7cf8[\u3044\u3068] is not the format.'
].join('\n');

/* How to write tashkeel \u2014 Arabic's equivalent of furigana: not a separate
   romanisation line but full vowel marks on the script that is actually
   spoken, the way a children's book, the Qur'an or a learner's textbook
   writes it, rather than the bare consonantal skeleton adults read from
   context. One spec, used by every call site that asks for it. */
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
    ru: 'блестящий камень', zh: '闪亮的石头', fr: 'pierre brillante', es: 'piedra brillante', ja: '光る石', ar: 'حجر لامع', pl: 'błyszczący kamień'
  },
  beans: {
    icon: '🫘', tags: ['hold', 'shop'], en: 'jar of beans', full: 'a jar of beans',
    ru: 'банка бобов', zh: '一罐豆子', fr: 'bocal de haricots', es: 'tarro de frijoles', ja: '豆のびん', ar: 'برطمان فول', pl: 'słoik fasoli'
  },
  coins: {
    icon: '🪙', tags: [], stackable: true, en: 'coins', full: 'coins',
    ru: 'монеты', zh: '硬币', fr: 'pièces', es: 'monedas', ja: 'コイン', ar: 'عملات', pl: 'monety'
  },
  bread: {
    icon: '🍞', tags: ['hold', 'shop', 'prize'], en: 'loaf of bread', full: 'a loaf of bread',
    ru: 'хлеб', zh: '面包', fr: 'pain', es: 'pan', ja: 'パン', ar: 'رغيف خبز', pl: 'bochenek chleba'
  },
  flower: {
    icon: '🌼', tags: ['hold', 'ground', 'prize'], en: 'flower', full: 'a flower',
    ru: 'цветок', zh: '花', fr: 'fleur', es: 'flor', ja: '花', ar: 'زهرة', pl: 'kwiat'
  },
  fish: {
    icon: '🐟', tags: ['hold', 'prize'], en: 'fish', full: 'a fish',
    ru: 'рыба', zh: '鱼', fr: 'poisson', es: 'pescado', ja: '魚', ar: 'سمكة', pl: 'ryba'
  },
  honey: {
    icon: '🍯', tags: ['hold', 'shop', 'prize'], en: 'jar of honey', full: 'a jar of honey',
    ru: 'банка мёда', zh: '一罐蜂蜜', fr: 'pot de miel', es: 'tarro de miel', ja: 'はちみつのびん', ar: 'برطمان عسل', pl: 'słoik miodu'
  },
  rope: {
    icon: '🪢', tags: ['hold', 'shop', 'ground'], en: 'rope', full: 'some rope',
    ru: 'верёвка', zh: '绳子', fr: 'corde', es: 'cuerda', ja: 'ロープ', ar: 'حبل', pl: 'lina'
  },
  mushrooms: {
    icon: '🍄', tags: ['hold', 'ground'], en: 'mushrooms', full: 'some mushrooms',
    ru: 'грибы', zh: '蘑菇', fr: 'champignons', es: 'setas', ja: 'きのこ', ar: 'فطر', pl: 'grzyby'
  },
  egg: {
    icon: '🥚', tags: ['hold', 'shop'], en: 'egg', full: 'an egg',
    ru: 'яйцо', zh: '鸡蛋', fr: 'œuf', es: 'huevo', ja: 'たまご', ar: 'بيضة', pl: 'jajko'
  },
  milk: {
    icon: '🥛', tags: ['hold', 'shop'], en: 'jug of milk', full: 'a jug of milk',
    ru: 'кувшин молока', zh: '一壶牛奶', fr: 'pot de lait', es: 'jarra de leche', ja: '牛乳のびん', ar: 'إبريق حليب', pl: 'dzbanek mleka'
  },
  apple: {
    icon: '🍎', tags: ['hold', 'shop', 'ground', 'prize'], en: 'apple', full: 'an apple',
    ru: 'яблоко', zh: '苹果', fr: 'pomme', es: 'manzana', ja: 'りんご', ar: 'تفاحة', pl: 'jabłko'
  },
  hat: {
    icon: '🎩', tags: ['hold', 'ground'], en: 'hat', full: 'a hat',
    ru: 'шляпа', zh: '帽子', fr: 'chapeau', es: 'sombrero', ja: '帽子', ar: 'قبعة', pl: 'kapelusz'
  },
  candle: {
    icon: '🕯️', tags: ['hold', 'shop'], en: 'candle', full: 'a candle',
    ru: 'свеча', zh: '蜡烛', fr: 'bougie', es: 'vela', ja: 'ろうそく', ar: 'شمعة', pl: 'świeca'
  },
  key: {
    icon: '🔑', tags: ['hold', 'ground'], en: 'key', full: 'a key',
    ru: 'ключ', zh: '钥匙', fr: 'clé', es: 'llave', ja: 'かぎ', ar: 'مفتاح', pl: 'klucz'
  },
  wool: {
    icon: '🧶', tags: ['hold', 'shop'], en: 'ball of wool', full: 'a ball of wool',
    ru: 'клубок шерсти', zh: '一团羊毛', fr: 'pelote de laine', es: 'ovillo de lana', ja: '毛糸玉', ar: 'كرة صوف', pl: 'kłębek wełny'
  },
  boots: {
    icon: '🥾', tags: ['hold', 'ground'], en: 'boots', full: 'a pair of boots',
    ru: 'сапоги', zh: '靴子', fr: 'bottes', es: 'botas', ja: 'ブーツ', ar: 'حذاء طويل', pl: 'botki'
  },
  lantern: {
    icon: '🏮', tags: ['hold', 'shop', 'ground'], en: 'lantern', full: 'a lantern',
    ru: 'фонарь', zh: '灯笼', fr: 'lanterne', es: 'linterna', ja: '提灯', ar: 'فانوس', pl: 'latarnia'
  },
  cat: {
    icon: '🐈', tags: ['beast'], en: 'cat', full: 'a cat',
    ru: 'кошка', zh: '猫', fr: 'chat', es: 'gato', ja: 'ねこ', ar: 'قطة', pl: 'kot'
  },
  dog: {
    icon: '🐕', tags: ['beast'], en: 'dog', full: 'a dog',
    ru: 'собака', zh: '狗', fr: 'chien', es: 'perro', ja: 'いぬ', ar: 'كلب', pl: 'pies'
  },
  goat: {
    icon: '🐐', tags: ['beast'], en: 'goat', full: 'a goat',
    ru: 'коза', zh: '山羊', fr: 'chèvre', es: 'cabra', ja: 'やぎ', ar: 'عنزة', pl: 'koza'
  },
  chicken: {
    icon: '🐔', tags: ['beast'], en: 'chicken', full: 'a chicken',
    ru: 'курица', zh: '鸡', fr: 'poule', es: 'gallina', ja: 'にわとり', ar: 'دجاجة', pl: 'kura'
  },
  duck: {
    icon: '🦆', tags: ['beast'], en: 'duck', full: 'a duck',
    ru: 'утка', zh: '鸭子', fr: 'canard', es: 'pato', ja: 'あひる', ar: 'بطة', pl: 'kaczka'
  },

  /* ---- the rest of the village's clutter ------------------------------- */
  onion: {
    icon: '🧅', tags: ['hold', 'shop'], en: 'onion', full: 'an onion',
    ru: 'лук', zh: '洋葱', ja: '玉ねぎ', fr: 'oignon', es: 'cebolla', ar: 'بصلة', pl: 'cebula'
  },
  carrot: {
    icon: '🥕', tags: ['hold', 'shop', 'ground'], en: 'carrot', full: 'a carrot',
    ru: 'морковь', zh: '胡萝卜', ja: 'にんじん', fr: 'carotte', es: 'zanahoria', ar: 'جزرة', pl: 'marchewka'
  },
  potato: {
    icon: '🥔', tags: ['hold', 'shop', 'ground'], en: 'potato', full: 'a potato',
    ru: 'картошка', zh: '土豆', ja: 'じゃがいも', fr: 'pomme de terre', es: 'patata', ar: 'بطاطا', pl: 'ziemniak'
  },
  cabbage: {
    icon: '🥬', tags: ['hold', 'shop', 'ground'], en: 'cabbage', full: 'a cabbage',
    ru: 'капуста', zh: '白菜', ja: 'キャベツ', fr: 'chou', es: 'col', ar: 'ملفوف', pl: 'kapusta'
  },
  tomato: {
    icon: '🍅', tags: ['hold', 'shop'], en: 'tomato', full: 'a tomato',
    ru: 'помидор', zh: '西红柿', ja: 'トマト', fr: 'tomate', es: 'tomate', ar: 'طماطم', pl: 'pomidor'
  },
  pumpkin: {
    icon: '🎃', tags: ['hold', 'shop', 'ground'], en: 'pumpkin', full: 'a pumpkin',
    ru: 'тыква', zh: '南瓜', ja: 'かぼちゃ', fr: 'citrouille', es: 'calabaza', ar: 'يقطينة', pl: 'dynia'
  },
  garlic: {
    icon: '🧄', tags: ['hold', 'shop'], en: 'garlic', full: 'a bulb of garlic',
    ru: 'чеснок', zh: '大蒜', ja: 'にんにく', fr: 'ail', es: 'ajo', ar: 'رأس ثوم', pl: 'główka czosnku'
  },
  corn: {
    icon: '🌽', tags: ['hold', 'shop', 'ground'], en: 'corn', full: 'an ear of corn',
    ru: 'кукуруза', zh: '玉米', ja: 'とうもろこし', fr: 'maïs', es: 'maíz', ar: 'كوز ذرة', pl: 'kolba kukurydzy'
  },
  pear: {
    icon: '🍐', tags: ['hold', 'shop', 'ground', 'prize'], en: 'pear', full: 'a pear',
    ru: 'груша', zh: '梨', ja: 'なし', fr: 'poire', es: 'pera', ar: 'كمثرى', pl: 'gruszka'
  },
  peach: {
    icon: '🍑', tags: ['hold', 'shop', 'prize'], en: 'peach', full: 'a peach',
    ru: 'персик', zh: '桃子', ja: 'もも', fr: 'pêche', es: 'melocotón', ar: 'خوخة', pl: 'brzoskwinia'
  },
  cherries: {
    icon: '🍒', tags: ['hold', 'shop', 'prize'], en: 'cherries', full: 'some cherries',
    ru: 'вишня', zh: '樱桃', ja: 'さくらんぼ', fr: 'cerises', es: 'cerezas', ar: 'كرز', pl: 'wiśnie'
  },
  grapes: {
    icon: '🍇', tags: ['hold', 'shop', 'prize'], en: 'grapes', full: 'some grapes',
    ru: 'виноград', zh: '葡萄', ja: 'ぶどう', fr: 'raisin', es: 'uvas', ar: 'عنب', pl: 'winogrona'
  },
  strawberry: {
    icon: '🍓', tags: ['hold', 'shop', 'prize'], en: 'strawberry', full: 'a strawberry',
    ru: 'клубника', zh: '草莓', ja: 'いちご', fr: 'fraise', es: 'fresa', ar: 'فراولة', pl: 'truskawka'
  },
  lemon: {
    icon: '🍋', tags: ['hold', 'shop'], en: 'lemon', full: 'a lemon',
    ru: 'лимон', zh: '柠檬', ja: 'レモン', fr: 'citron', es: 'limón', ar: 'ليمونة', pl: 'cytryna'
  },
  watermelon: {
    icon: '🍉', tags: ['hold', 'shop'], en: 'watermelon', full: 'a watermelon',
    ru: 'арбуз', zh: '西瓜', ja: 'すいか', fr: 'pastèque', es: 'sandía', ar: 'بطيخة', pl: 'arbuz'
  },
  chestnut: {
    icon: '🌰', tags: ['hold', 'ground'], en: 'chestnut', full: 'a chestnut',
    ru: 'каштан', zh: '栗子', ja: 'くり', fr: 'châtaigne', es: 'castaña', ar: 'كستناء', pl: 'kasztan'
  },
  cheese: {
    icon: '🧀', tags: ['hold', 'shop', 'prize'], en: 'cheese', full: 'a wheel of cheese',
    ru: 'сыр', zh: '奶酪', ja: 'チーズ', fr: 'fromage', es: 'queso', ar: 'قالب جبن', pl: 'krąg sera'
  },
  butter: {
    icon: '🧈', tags: ['hold', 'shop'], en: 'butter', full: 'a pat of butter',
    ru: 'масло', zh: '黄油', ja: 'バター', fr: 'beurre', es: 'mantequilla', ar: 'قطعة زبدة', pl: 'kostka masła'
  },
  salt: {
    icon: '🧂', tags: ['hold', 'shop'], en: 'salt', full: 'a pinch of salt',
    ru: 'соль', zh: '盐', ja: '塩', fr: 'sel', es: 'sal', ar: 'رشة ملح', pl: 'szczypta soli'
  },
  sweets: {
    icon: '🍬', tags: ['hold', 'shop', 'prize'], en: 'sweets', full: 'some sweets',
    ru: 'конфеты', zh: '糖果', ja: 'あめ', fr: 'bonbons', es: 'caramelos', ar: 'حلوى', pl: 'cukierki'
  },
  cake: {
    icon: '🍰', tags: ['hold', 'shop', 'prize'], en: 'cake', full: 'a slice of cake',
    ru: 'торт', zh: '蛋糕', ja: 'ケーキ', fr: 'gâteau', es: 'pastel', ar: 'قطعة كعك', pl: 'kawałek ciasta'
  },
  pie: {
    icon: '🥧', tags: ['hold', 'shop', 'prize'], en: 'pie', full: 'a pie',
    ru: 'пирог', zh: '派', ja: 'パイ', fr: 'tarte', es: 'tarta', ar: 'فطيرة', pl: 'placek'
  },
  jam: {
    icon: '🫙', tags: ['hold', 'shop', 'prize'], en: 'jam', full: 'a jar of jam',
    ru: 'варенье', zh: '果酱', ja: 'ジャム', fr: 'confiture', es: 'mermelada', ar: 'برطمان مربى', pl: 'słoik dżemu'
  },
  soup: {
    icon: '🍲', tags: ['hold', 'shop'], en: 'soup', full: 'a bowl of soup',
    ru: 'суп', zh: '汤', ja: 'スープ', fr: 'soupe', es: 'sopa', ar: 'طبق حساء', pl: 'miska zupy'
  },
  meat: {
    icon: '🍖', tags: ['hold', 'shop'], en: 'meat', full: 'a joint of meat',
    ru: 'мясо', zh: '肉', ja: '肉', fr: 'viande', es: 'carne', ar: 'قطعة لحم', pl: 'kawał mięsa'
  },
  bacon: {
    icon: '🥓', tags: ['hold', 'shop'], en: 'bacon', full: 'some bacon',
    ru: 'бекон', zh: '培根', ja: 'ベーコン', fr: 'lard', es: 'tocino', ar: 'لحم مقدد', pl: 'boczek'
  },
  rice: {
    icon: '🍚', tags: ['hold', 'shop'], en: 'rice', full: 'a bowl of rice',
    ru: 'рис', zh: '米饭', ja: 'ごはん', fr: 'riz', es: 'arroz', ar: 'طبق أرز', pl: 'miska ryżu'
  },
  noodles: {
    icon: '🍜', tags: ['hold', 'shop'], en: 'noodles', full: 'a bowl of noodles',
    ru: 'лапша', zh: '面条', ja: 'めん', fr: 'nouilles', es: 'fideos', ar: 'طبق نودلز', pl: 'miska makaronu'
  },
  wheat: {
    icon: '🌾', tags: ['hold', 'ground'], en: 'wheat', full: 'a sheaf of wheat',
    ru: 'пшеница', zh: '小麦', ja: '小麦', fr: 'blé', es: 'trigo', ar: 'حزمة قمح', pl: 'snop pszenicy'
  },
  tea: {
    icon: '🍵', tags: ['hold', 'shop', 'prize'], en: 'tea', full: 'a cup of tea',
    ru: 'чай', zh: '茶', ja: 'お茶', fr: 'thé', es: 'té', ar: 'كوب شاي', pl: 'filiżanka herbaty'
  },
  coffee: {
    icon: '☕', tags: ['hold', 'shop'], en: 'coffee', full: 'a cup of coffee',
    ru: 'кофе', zh: '咖啡', ja: 'コーヒー', fr: 'café', es: 'café', ar: 'كوب قهوة', pl: 'filiżanka kawy'
  },
  wine: {
    icon: '🍷', tags: ['hold', 'shop', 'prize'], en: 'wine', full: 'a bottle of wine',
    ru: 'вино', zh: '葡萄酒', ja: 'ワイン', fr: 'vin', es: 'vino', ar: 'زجاجة نبيذ', pl: 'butelka wina'
  },
  beer: {
    icon: '🍺', tags: ['hold', 'shop'], en: 'beer', full: 'a mug of beer',
    ru: 'пиво', zh: '啤酒', ja: 'ビール', fr: 'bière', es: 'cerveza', ar: 'كوب بيرة', pl: 'kufel piwa'
  },
  hammer: {
    icon: '🔨', tags: ['hold', 'shop', 'ground'], en: 'hammer', full: 'a hammer',
    ru: 'молоток', zh: '锤子', ja: 'かなづち', fr: 'marteau', es: 'martillo', ar: 'مطرقة', pl: 'młotek'
  },
  axe: {
    icon: '🪓', tags: ['hold', 'shop', 'ground'], en: 'axe', full: 'an axe',
    ru: 'топор', zh: '斧头', ja: 'おの', fr: 'hache', es: 'hacha', ar: 'فأس', pl: 'siekiera'
  },
  saw: {
    icon: '🪚', tags: ['hold', 'shop', 'ground'], en: 'saw', full: 'a saw',
    ru: 'пила', zh: '锯子', ja: 'のこぎり', fr: 'scie', es: 'sierra', ar: 'منشار', pl: 'piła'
  },
  screwdriver: {
    icon: '🪛', tags: ['hold', 'shop', 'ground'], en: 'screwdriver', full: 'a screwdriver',
    ru: 'отвёртка', zh: '螺丝刀', ja: 'ドライバー', fr: 'tournevis', es: 'destornillador', ar: 'مفك', pl: 'śrubokręt'
  },
  screw: {
    icon: '🔩', tags: ['hold', 'shop', 'ground'], en: 'screw', full: 'a screw',
    ru: 'винт', zh: '螺丝', ja: 'ねじ', fr: 'vis', es: 'tornillo', ar: 'برغي', pl: 'śrubka'
  },
  bucket: {
    icon: '🪣', tags: ['hold', 'shop', 'ground'], en: 'bucket', full: 'a bucket',
    ru: 'ведро', zh: '桶', ja: 'バケツ', fr: 'seau', es: 'cubo', ar: 'دلو', pl: 'wiadro'
  },
  basket: {
    icon: '🧺', tags: ['hold', 'shop', 'ground'], en: 'basket', full: 'a basket',
    ru: 'корзина', zh: '篮子', ja: 'かご', fr: 'panier', es: 'cesta', ar: 'سلة', pl: 'koszyk'
  },
  ladder: {
    icon: '🪜', tags: ['hold', 'ground'], en: 'ladder', full: 'a ladder',
    ru: 'лестница', zh: '梯子', ja: 'はしご', fr: 'échelle', es: 'escalera', ar: 'سلم', pl: 'drabina'
  },
  knife: {
    icon: '🔪', tags: ['hold', 'shop'], en: 'knife', full: 'a knife',
    ru: 'нож', zh: '刀', ja: 'ナイフ', fr: 'couteau', es: 'cuchillo', ar: 'سكين', pl: 'nóż'
  },
  scissors: {
    icon: '✂️', tags: ['hold', 'shop'], en: 'scissors', full: 'a pair of scissors',
    ru: 'ножницы', zh: '剪刀', ja: 'はさみ', fr: 'ciseaux', es: 'tijeras', ar: 'مقص', pl: 'nożyczki'
  },
  needle: {
    icon: '🪡', tags: ['hold', 'shop'], en: 'needle', full: 'a needle',
    ru: 'иголка', zh: '针', ja: 'はり', fr: 'aiguille', es: 'aguja', ar: 'إبرة', pl: 'igła'
  },
  thread: {
    icon: '🧵', tags: ['hold', 'shop'], en: 'thread', full: 'a reel of thread',
    ru: 'нитки', zh: '线', ja: '糸', fr: 'fil', es: 'hilo', ar: 'بكرة خيط', pl: 'szpulka nici'
  },
  fishing_rod: {
    icon: '🎣', tags: ['hold', 'ground'], en: 'fishing rod', full: 'a fishing rod',
    ru: 'удочка', zh: '钓竿', ja: 'つりざお', fr: 'canne à pêche', es: 'caña de pescar', ar: 'صنارة صيد', pl: 'wędka'
  },
  magnet: {
    icon: '🧲', tags: ['hold', 'ground'], en: 'magnet', full: 'a magnet',
    ru: 'магнит', zh: '磁铁', ja: '磁石', fr: 'aimant', es: 'imán', ar: 'مغناطيس', pl: 'magnes'
  },
  chain: {
    icon: '⛓️', tags: ['hold', 'ground'], en: 'chain', full: 'a chain',
    ru: 'цепь', zh: '链子', ja: 'くさり', fr: 'chaîne', es: 'cadena', ar: 'سلسلة', pl: 'łańcuch'
  },
  bell: {
    icon: '🔔', tags: ['hold', 'shop', 'prize'], en: 'bell', full: 'a bell',
    ru: 'колокольчик', zh: '铃铛', ja: 'すず', fr: 'cloche', es: 'campana', ar: 'جرس', pl: 'dzwonek'
  },
  broom: {
    icon: '🧹', tags: ['hold', 'shop'], en: 'broom', full: 'a broom',
    ru: 'метла', zh: '扫帚', ja: 'ほうき', fr: 'balai', es: 'escoba', ar: 'مكنسة', pl: 'miotła'
  },
  compass: {
    icon: '🧭', tags: ['hold', 'ground', 'prize'], en: 'compass', full: 'a compass',
    ru: 'компас', zh: '指南针', ja: 'コンパス', fr: 'boussole', es: 'brújula', ar: 'بوصلة', pl: 'kompas'
  },
  telescope: {
    icon: '🔭', tags: ['hold', 'prize'], en: 'telescope', full: 'a telescope',
    ru: 'телескоп', zh: '望远镜', ja: '望遠鏡', fr: 'télescope', es: 'telescopio', ar: 'تلسكوب', pl: 'teleskop'
  },
  magnifier: {
    icon: '🔍', tags: ['hold', 'ground'], en: 'magnifying glass', full: 'a magnifying glass',
    ru: 'лупа', zh: '放大镜', ja: '虫めがね', fr: 'loupe', es: 'lupa', ar: 'عدسة مكبرة', pl: 'szkło powiększające'
  },
  umbrella: {
    icon: '☂️', tags: ['hold', 'shop', 'ground'], en: 'umbrella', full: 'an umbrella',
    ru: 'зонт', zh: '雨伞', ja: 'かさ', fr: 'parapluie', es: 'paraguas', ar: 'مظلة', pl: 'parasol'
  },
  mirror: {
    icon: '🪞', tags: ['hold', 'shop', 'prize'], en: 'mirror', full: 'a mirror',
    ru: 'зеркало', zh: '镜子', ja: 'かがみ', fr: 'miroir', es: 'espejo', ar: 'مرآة', pl: 'lustro'
  },
  soap: {
    icon: '🧼', tags: ['hold', 'shop'], en: 'soap', full: 'a bar of soap',
    ru: 'мыло', zh: '肥皂', ja: 'せっけん', fr: 'savon', es: 'jabón', ar: 'قالب صابون', pl: 'kostka mydła'
  },
  teapot: {
    icon: '🫖', tags: ['hold', 'shop', 'prize'], en: 'teapot', full: 'a teapot',
    ru: 'чайник', zh: '茶壶', ja: 'きゅうす', fr: 'théière', es: 'tetera', ar: 'إبريق شاي', pl: 'czajniczek'
  },
  bottle: {
    icon: '🍾', tags: ['hold', 'shop', 'ground'], en: 'bottle', full: 'a bottle',
    ru: 'бутылка', zh: '瓶子', ja: 'びん', fr: 'bouteille', es: 'botella', ar: 'زجاجة', pl: 'butelka'
  },
  plate: {
    icon: '🍽️', tags: ['hold', 'shop'], en: 'plate', full: 'a plate',
    ru: 'тарелка', zh: '盘子', ja: 'おさら', fr: 'assiette', es: 'plato', ar: 'طبق', pl: 'talerz'
  },
  spoon: {
    icon: '🥄', tags: ['hold', 'shop'], en: 'spoon', full: 'a spoon',
    ru: 'ложка', zh: '勺子', ja: 'スプーン', fr: 'cuillère', es: 'cuchara', ar: 'ملعقة', pl: 'łyżka'
  },
  fork: {
    icon: '🍴', tags: ['hold', 'shop'], en: 'fork', full: 'a fork',
    ru: 'вилка', zh: '叉子', ja: 'フォーク', fr: 'fourchette', es: 'tenedor', ar: 'شوكة', pl: 'widelec'
  },
  clock: {
    icon: '🕰️', tags: ['hold', 'shop', 'prize'], en: 'clock', full: 'a clock',
    ru: 'часы', zh: '钟', ja: 'とけい', fr: 'horloge', es: 'reloj', ar: 'ساعة', pl: 'zegar'
  },
  oil_lamp: {
    icon: '🪔', tags: ['hold', 'shop', 'ground'], en: 'oil lamp', full: 'an oil lamp',
    ru: 'лампа', zh: '油灯', ja: 'ランプ', fr: 'lampe', es: 'lámpara', ar: 'مصباح زيت', pl: 'lampa naftowa'
  },
  chair: {
    icon: '🪑', tags: ['hold', 'shop'], en: 'chair', full: 'a chair',
    ru: 'стул', zh: '椅子', ja: 'いす', fr: 'chaise', es: 'silla', ar: 'كرسي', pl: 'krzesło'
  },
  box: {
    icon: '📦', tags: ['hold', 'ground'], en: 'box', full: 'a box',
    ru: 'коробка', zh: '箱子', ja: 'はこ', fr: 'boîte', es: 'caja', ar: 'صندوق', pl: 'pudełko'
  },
  book: {
    icon: '📖', tags: ['hold', 'shop', 'ground', 'prize'], en: 'book', full: 'a book',
    ru: 'книга', zh: '书', ja: 'ほん', fr: 'livre', es: 'libro', ar: 'كتاب', pl: 'książka'
  },
  letter: {
    icon: '✉️', tags: ['hold', 'ground'], en: 'letter', full: 'a letter',
    ru: 'письмо', zh: '信', ja: 'てがみ', fr: 'lettre', es: 'carta', ar: 'رسالة', pl: 'list'
  },
  pen: {
    icon: '🖊️', tags: ['hold', 'shop', 'ground'], en: 'pen', full: 'a pen',
    ru: 'ручка', zh: '钢笔', ja: 'ペン', fr: 'stylo', es: 'bolígrafo', ar: 'قلم حبر', pl: 'długopis'
  },
  pencil: {
    icon: '✏️', tags: ['hold', 'shop', 'ground'], en: 'pencil', full: 'a pencil',
    ru: 'карандаш', zh: '铅笔', ja: 'えんぴつ', fr: 'crayon', es: 'lápiz', ar: 'قلم رصاص', pl: 'ołówek'
  },
  paper: {
    icon: '📄', tags: ['hold', 'shop'], en: 'paper', full: 'a sheet of paper',
    ru: 'бумага', zh: '纸', ja: 'かみ', fr: 'papier', es: 'papel', ar: 'ورقة', pl: 'kartka papieru'
  },
  map: {
    icon: '🗺️', tags: ['hold', 'ground', 'prize'], en: 'map', full: 'a map',
    ru: 'карта', zh: '地图', ja: 'ちず', fr: 'carte', es: 'mapa', ar: 'خريطة', pl: 'mapa'
  },
  purse: {
    icon: '👛', tags: ['hold', 'shop', 'ground'], en: 'purse', full: 'a purse',
    ru: 'кошелёк', zh: '钱包', ja: 'さいふ', fr: 'porte-monnaie', es: 'monedero', ar: 'محفظة', pl: 'sakiewka'
  },
  backpack: {
    icon: '🎒', tags: ['hold', 'shop'], en: 'backpack', full: 'a backpack',
    ru: 'рюкзак', zh: '背包', ja: 'リュック', fr: 'sac à dos', es: 'mochila', ar: 'حقيبة ظهر', pl: 'plecak'
  },
  ring: {
    icon: '💍', tags: ['hold', 'ground', 'prize'], en: 'ring', full: 'a ring',
    ru: 'кольцо', zh: '戒指', ja: 'ゆびわ', fr: 'bague', es: 'anillo', ar: 'خاتم', pl: 'pierścionek'
  },
  crown: {
    icon: '👑', tags: ['hold', 'prize'], en: 'crown', full: 'a crown',
    ru: 'корона', zh: '王冠', ja: 'おうかん', fr: 'couronne', es: 'corona', ar: 'تاج', pl: 'korona'
  },
  crystal_ball: {
    icon: '🔮', tags: ['hold', 'prize'], en: 'crystal ball', full: 'a crystal ball',
    ru: 'хрустальный шар', zh: '水晶球', ja: '水晶玉', fr: 'boule de cristal', es: 'bola de cristal', ar: 'كرة بلورية', pl: 'kryształowa kula'
  },
  coat: {
    icon: '🧥', tags: ['hold', 'shop'], en: 'coat', full: 'a coat',
    ru: 'пальто', zh: '外套', ja: 'コート', fr: 'manteau', es: 'abrigo', ar: 'معطف', pl: 'płaszcz'
  },
  scarf: {
    icon: '🧣', tags: ['hold', 'shop', 'prize'], en: 'scarf', full: 'a scarf',
    ru: 'шарф', zh: '围巾', ja: 'マフラー', fr: 'écharpe', es: 'bufanda', ar: 'وشاح', pl: 'szalik'
  },
  gloves: {
    icon: '🧤', tags: ['hold', 'shop', 'ground'], en: 'gloves', full: 'a pair of gloves',
    ru: 'перчатки', zh: '手套', ja: 'てぶくろ', fr: 'gants', es: 'guantes', ar: 'قفازات', pl: 'rękawiczki'
  },
  socks: {
    icon: '🧦', tags: ['hold', 'shop'], en: 'socks', full: 'a pair of socks',
    ru: 'носки', zh: '袜子', ja: 'くつした', fr: 'chaussettes', es: 'calcetines', ar: 'جوارب', pl: 'skarpetki'
  },
  shirt: {
    icon: '👕', tags: ['hold', 'shop'], en: 'shirt', full: 'a shirt',
    ru: 'рубашка', zh: '衬衫', ja: 'シャツ', fr: 'chemise', es: 'camisa', ar: 'قميص', pl: 'koszula'
  },
  trousers: {
    icon: '👖', tags: ['hold', 'shop'], en: 'trousers', full: 'a pair of trousers',
    ru: 'штаны', zh: '裤子', ja: 'ズボン', fr: 'pantalon', es: 'pantalones', ar: 'بنطال', pl: 'spodnie'
  },
  dress: {
    icon: '👗', tags: ['hold', 'shop', 'prize'], en: 'dress', full: 'a dress',
    ru: 'платье', zh: '连衣裙', ja: 'ワンピース', fr: 'robe', es: 'vestido', ar: 'فستان', pl: 'sukienka'
  },
  shoes: {
    icon: '👞', tags: ['hold', 'shop', 'ground'], en: 'shoes', full: 'a pair of shoes',
    ru: 'туфли', zh: '鞋', ja: 'くつ', fr: 'chaussures', es: 'zapatos', ar: 'حذاء', pl: 'buty'
  },
  glasses: {
    icon: '👓', tags: ['hold', 'shop', 'ground'], en: 'glasses', full: 'a pair of glasses',
    ru: 'очки', zh: '眼镜', ja: 'めがね', fr: 'lunettes', es: 'gafas', ar: 'نظارة', pl: 'okulary'
  },
  ribbon: {
    icon: '🎀', tags: ['hold', 'shop', 'prize'], en: 'ribbon', full: 'a ribbon',
    ru: 'бант', zh: '蝴蝶结', ja: 'リボン', fr: 'ruban', es: 'lazo', ar: 'شريط', pl: 'wstążka'
  },
  feather: {
    icon: '🪶', tags: ['hold', 'ground'], en: 'feather', full: 'a feather',
    ru: 'перо', zh: '羽毛', ja: 'はね', fr: 'plume', es: 'pluma', ar: 'ريشة', pl: 'pióro'
  },
  shell: {
    icon: '🐚', tags: ['hold', 'ground', 'prize'], en: 'shell', full: 'a shell',
    ru: 'ракушка', zh: '贝壳', ja: 'かい', fr: 'coquillage', es: 'concha', ar: 'صدفة', pl: 'muszla'
  },
  leaf: {
    icon: '🍃', tags: ['hold', 'ground'], en: 'leaf', full: 'a leaf',
    ru: 'лист', zh: '叶子', ja: 'は', fr: 'feuille', es: 'hoja', ar: 'ورقة شجر', pl: 'liść'
  },
  log: {
    icon: '🪵', tags: ['hold', 'ground'], en: 'log', full: 'a log',
    ru: 'бревно', zh: '木头', ja: 'まるた', fr: 'bûche', es: 'tronco', ar: 'جذع خشب', pl: 'kłoda'
  },
  stone: {
    icon: '🪨', tags: ['hold', 'ground'], en: 'stone', full: 'a stone',
    ru: 'камень', zh: '石头', ja: 'いし', fr: 'pierre', es: 'piedra', ar: 'حجر', pl: 'kamień'
  },
  ice: {
    icon: '🧊', tags: ['hold', 'ground'], en: 'block of ice', full: 'a block of ice',
    ru: 'лёд', zh: '冰', ja: 'こおり', fr: 'glace', es: 'hielo', ar: 'قالب ثلج', pl: 'bryła lodu'
  },
  seedling: {
    icon: '🌱', tags: ['hold', 'shop', 'ground'], en: 'seedling', full: 'a seedling',
    ru: 'росток', zh: '幼苗', ja: 'なえ', fr: 'pousse', es: 'brote', ar: 'شتلة', pl: 'sadzonka'
  },
  herbs: {
    icon: '🌿', tags: ['hold', 'shop', 'ground'], en: 'herbs', full: 'a bunch of herbs',
    ru: 'травы', zh: '草药', ja: 'ハーブ', fr: 'herbes', es: 'hierbas', ar: 'حزمة أعشاب', pl: 'pęczek ziół'
  },
  drum: {
    icon: '🥁', tags: ['hold', 'prize'], en: 'drum', full: 'a drum',
    ru: 'барабан', zh: '鼓', ja: 'たいこ', fr: 'tambour', es: 'tambor', ar: 'طبل', pl: 'bęben'
  },
  violin: {
    icon: '🎻', tags: ['hold', 'prize'], en: 'violin', full: 'a violin',
    ru: 'скрипка', zh: '小提琴', ja: 'バイオリン', fr: 'violon', es: 'violín', ar: 'كمان', pl: 'skrzypce'
  },
  guitar: {
    icon: '🎸', tags: ['hold', 'prize'], en: 'guitar', full: 'a guitar',
    ru: 'гитара', zh: '吉他', ja: 'ギター', fr: 'guitare', es: 'guitarra', ar: 'جيتار', pl: 'gitara'
  },
  kite: {
    icon: '🪁', tags: ['hold', 'ground', 'prize'], en: 'kite', full: 'a kite',
    ru: 'воздушный змей', zh: '风筝', ja: 'たこ', fr: 'cerf-volant', es: 'cometa', ar: 'طائرة ورقية', pl: 'latawiec'
  },
  ball: {
    icon: '⚽', tags: ['hold', 'shop', 'ground', 'prize'], en: 'ball', full: 'a ball',
    ru: 'мяч', zh: '球', ja: 'ボール', fr: 'ballon', es: 'pelota', ar: 'كرة', pl: 'piłka'
  },
  teddy: {
    icon: '🧸', tags: ['hold', 'shop', 'prize'], en: 'teddy bear', full: 'a teddy bear',
    ru: 'плюшевый мишка', zh: '泰迪熊', ja: 'テディベア', fr: 'ours en peluche', es: 'osito de peluche', ar: 'دب محشو', pl: 'miś pluszowy'
  },
  dice: {
    icon: '🎲', tags: ['hold', 'ground'], en: 'dice', full: 'a pair of dice',
    ru: 'кубики', zh: '骰子', ja: 'サイコロ', fr: 'dés', es: 'dados', ar: 'زهر النرد', pl: 'kości do gry'
  },
  cards: {
    icon: '🃏', tags: ['hold', 'shop'], en: 'cards', full: 'a pack of cards',
    ru: 'карты', zh: '扑克牌', ja: 'トランプ', fr: 'cartes', es: 'cartas', ar: 'أوراق لعب', pl: 'talia kart'
  },
  puzzle: {
    icon: '🧩', tags: ['hold', 'shop', 'prize'], en: 'puzzle', full: 'a puzzle',
    ru: 'пазл', zh: '拼图', ja: 'パズル', fr: 'puzzle', es: 'puzle', ar: 'أحجية', pl: 'puzzle'
  },
  sheep: {
    icon: '🐑', tags: ['beast'], en: 'sheep', full: 'a sheep',
    ru: 'овца', zh: '绵羊', ja: 'ひつじ', fr: 'mouton', es: 'oveja', ar: 'خروف', pl: 'owca'
  },
  pig: {
    icon: '🐖', tags: ['beast'], en: 'pig', full: 'a pig',
    ru: 'свинья', zh: '猪', ja: 'ぶた', fr: 'cochon', es: 'cerdo', ar: 'خنزير', pl: 'świnia'
  },
  cow: {
    icon: '🐄', tags: ['beast'], en: 'cow', full: 'a cow',
    ru: 'корова', zh: '牛', ja: 'うし', fr: 'vache', es: 'vaca', ar: 'بقرة', pl: 'krowa'
  },
  horse: {
    icon: '🐎', tags: ['beast'], en: 'horse', full: 'a horse',
    ru: 'лошадь', zh: '马', ja: 'うま', fr: 'cheval', es: 'caballo', ar: 'حصان', pl: 'koń'
  },
  donkey: {
    icon: '🫏', tags: ['beast'], en: 'donkey', full: 'a donkey',
    ru: 'осёл', zh: '驴', ja: 'ロバ', fr: 'âne', es: 'burro', ar: 'حمار', pl: 'osioł'
  },
  rabbit: {
    icon: '🐇', tags: ['beast'], en: 'rabbit', full: 'a rabbit',
    ru: 'кролик', zh: '兔子', ja: 'うさぎ', fr: 'lapin', es: 'conejo', ar: 'أرنب', pl: 'królik'
  },
  goose: {
    icon: '🪿', tags: ['beast'], en: 'goose', full: 'a goose',
    ru: 'гусь', zh: '鹅', ja: 'ガチョウ', fr: 'oie', es: 'ganso', ar: 'إوزة', pl: 'gęś'
  },
  mouse: {
    icon: '🐁', tags: ['beast'], en: 'mouse', full: 'a mouse',
    ru: 'мышь', zh: '老鼠', ja: 'ねずみ', fr: 'souris', es: 'ratón', ar: 'فأر', pl: 'mysz'
  },
  frog: {
    icon: '🐸', tags: ['beast'], en: 'frog', full: 'a frog',
    ru: 'лягушка', zh: '青蛙', ja: 'かえる', fr: 'grenouille', es: 'rana', ar: 'ضفدع', pl: 'żaba'
  },
  hedgehog: {
    icon: '🦔', tags: ['beast'], en: 'hedgehog', full: 'a hedgehog',
    ru: 'ёж', zh: '刺猬', ja: 'ハリネズミ', fr: 'hérisson', es: 'erizo', ar: 'قنفذ', pl: 'jeż'
  },
  owl: {
    icon: '🦉', tags: ['beast'], en: 'owl', full: 'an owl',
    ru: 'сова', zh: '猫头鹰', ja: 'ふくろう', fr: 'hibou', es: 'búho', ar: 'بومة', pl: 'sowa'
  },
  turtle: {
    icon: '🐢', tags: ['beast'], en: 'turtle', full: 'a turtle',
    ru: 'черепаха', zh: '乌龟', ja: 'かめ', fr: 'tortue', es: 'tortuga', ar: 'سلحفاة', pl: 'żółw'
  },
  snail: {
    icon: '🐌', tags: ['beast'], en: 'snail', full: 'a snail',
    ru: 'улитка', zh: '蜗牛', ja: 'かたつむり', fr: 'escargot', es: 'caracol', ar: 'حلزون', pl: 'ślimak'
  },
  parrot: {
    icon: '🦜', tags: ['beast'], en: 'parrot', full: 'a parrot',
    ru: 'попугай', zh: '鹦鹉', ja: 'オウム', fr: 'perroquet', es: 'loro', ar: 'ببغاء', pl: 'papuga'
  },
  pony: {
    icon: '🐴', tags: ['beast'], en: 'pony', full: 'a pony',
    ru: 'пони', zh: '小马', ja: 'ポニー', fr: 'poney', es: 'poni', ar: 'مهر', pl: 'kucyk'
  }
};

/* What a thing is worth when nobody has priced it explicitly. */
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
   The village sits in the southern half of the map. North of it is forest —
   a real expanse of it, big enough to lose things in — and east of it, at the
   end of the high street, the platform of an unmanned railway halt, which is
   where the traveller gets off.

   `NORTH_WOODS` is how far south of the map's top edge the village begins. It
   is written down here rather than folded into the numbers because the forest
   and the village are laid out against opposite edges: the village grew from
   its own north edge and the woods run back from there to the treeline. Every
   coordinate in this file and in world.js is nonetheless *absolute* — this
   constant tells you where the boundary is, and is not an offset anyone has to
   apply. Two answers to "where is the bakery" is exactly the drift this
   codebase keeps paying for. */
LG.NORTH_WOODS = 40;             // rows of forest before the village starts

/* Where the traveller gets off the train: on the platform, a step from the
   nameboard and a short walk from the end of the high street. */
LG.START = { x: 86, y: 61 };

/* The green in the middle of the village. Anyone idle drifts here by day. */
LG.GREEN = { x: 31, y: 67, w: 20, h: 12 };

/* Just past the hall, where a board stands for anyone to pin a note to. It is
   a place a villager can choose to go, the same as the green or their own
   work — see `placesFor` in game.js — and not a scripted stop on anyone's
   round. */
LG.BOARD_SPOT = { x: 43, y: 65, w: 3, h: 2 };

/* --------------------------------------------------------- what a sign says
   Buildings and flavour spots keep their plain English `label` everywhere in
   the code — it is what everything else keys off, from `buildingByLabel` to a
   villager's own workplace. A sign is read, not looked up, so what is
   actually painted on it is in the language the village speaks, with English
   the fallback and the gloss underneath. */
LG.PLACENAMES = {
  'Village Hall': { en: 'Village Hall', ru: 'Сельская управа', zh: '村公所', ja: '村役場', fr: 'Mairie', es: 'Ayuntamiento', ar: 'قاعة القرية', pl: 'Ratusz' },
  Bakery:         { en: 'Bakery', ru: 'Пекарня', zh: '面包店', ja: 'パン屋', fr: 'Boulangerie', es: 'Panadería', ar: 'مخبز', pl: 'Piekarnia' },
  Shop:           { en: 'Shop', ru: 'Лавка', zh: '杂货店', ja: '雑貨屋', fr: 'Épicerie', es: 'Tienda', ar: 'متجر', pl: 'Sklep' },
  Inn:            { en: 'Inn', ru: 'Трактир', zh: '客栈', ja: '宿屋', fr: 'Auberge', es: 'Posada', ar: 'نزل', pl: 'Gospoda' },
  Farmhouse:      { en: 'Farmhouse', ru: 'Дом фермера', zh: '农舍', ja: '農家', fr: 'Ferme', es: 'Granja', ar: 'بيت المزرعة', pl: 'Zagroda' },
  Mill:           { en: 'Mill', ru: 'Мельница', zh: '磨坊', ja: '水車小屋', fr: 'Moulin', es: 'Molino', ar: 'طاحونة', pl: 'Młyn' },
  School:         { en: 'School', ru: 'Школа', zh: '学堂', ja: '学校', fr: 'École', es: 'Escuela', ar: 'مدرسة', pl: 'Szkoła' },
  Chapel:         { en: 'Chapel', ru: 'Часовня', zh: '小教堂', ja: '礼拝堂', fr: 'Chapelle', es: 'Capilla', ar: 'كنيسة صغيرة', pl: 'Kaplica' },
  Smithy:         { en: 'Smithy', ru: 'Кузница', zh: '铁匠铺', ja: '鍛冶屋', fr: 'Forge', es: 'Herrería', ar: 'حدادة', pl: 'Kuźnia' },
  Hut:            { en: 'Hut', ru: 'Хижина', zh: '小屋', ja: '小屋', fr: 'Cabane', es: 'Choza', ar: 'كوخ', pl: 'Chata' },
  'The Green':    { en: 'The Green', ru: 'Площадь', zh: '村中广场', ja: '広場', fr: 'La Place', es: 'La Plaza', ar: 'الساحة الخضراء', pl: 'Błonie' },
  Mine:           { en: 'Mine', ru: 'Шахта', zh: '矿场', ja: '鉱山', fr: 'Mine', es: 'Mina', ar: 'منجم', pl: 'Kopalnia' },
  Pond:           { en: 'Pond', ru: 'Пруд', zh: '池塘', ja: '池', fr: 'Étang', es: 'Estanque', ar: 'بركة', pl: 'Staw' },
  Fields:         { en: 'Fields', ru: 'Поля', zh: '田地', ja: '畑', fr: 'Champs', es: 'Campos', ar: 'حقول', pl: 'Pola' },
  Orchard:        { en: 'Orchard', ru: 'Сад', zh: '果园', ja: '果樹園', fr: 'Verger', es: 'Huerto', ar: 'بستان', pl: 'Sad' },
  Beeyard:        { en: 'Beeyard', ru: 'Пасека', zh: '养蜂场', ja: '養蜂場', fr: 'Rucher', es: 'Colmenar', ar: 'منحل', pl: 'Pasieka' },
  Woodpile:       { en: 'Woodpile', ru: 'Дровяной склад', zh: '木材堆场', ja: '薪置き場', fr: 'Tas de bois', es: 'Leñera', ar: 'كومة حطب', pl: 'Stos drewna' },
  Graveyard:      { en: 'Graveyard', ru: 'Кладбище', zh: '墓地', ja: '墓地', fr: 'Cimetière', es: 'Cementerio', ar: 'مقبرة', pl: 'Cmentarz' },
  Noticeboard:    { en: 'Noticeboard', ru: 'Доска объявлений', zh: '布告栏', ja: '掲示板', fr: "Panneau d'affichage", es: 'Tablón de anuncios', ar: 'لوحة إعلانات', pl: 'Tablica ogłoszeń' },
  Station:        { en: 'Station', ru: 'Станция', zh: '火车站', ja: '駅', fr: 'Gare', es: 'Estación', ar: 'محطة', pl: 'Stacja' },
  'The Woods':    { en: 'The Woods', ru: 'Лес', zh: '树林', ja: '森', fr: 'La Forêt', es: 'El Bosque', ar: 'الغابة', pl: 'Las' },
  'Big Clearing': { en: 'Big Clearing', ru: 'Поляна', zh: '大空地', ja: '大きな空き地', fr: 'La Clairière', es: 'El Claro', ar: 'الفسحة الكبيرة', pl: 'Duża Polana' },
  'Old Oak':      { en: 'Old Oak', ru: 'Старый дуб', zh: '老橡树', ja: '古い樫の木', fr: 'Le Vieux Chêne', es: 'El Roble Viejo', ar: 'البلوطة العجوز', pl: 'Stary Dąb' },
  'The Hollow':   { en: 'The Hollow', ru: 'Лощина', zh: '洼地', ja: 'くぼ地', fr: 'Le Vallon', es: 'La Hondonada', ar: 'المنخفض', pl: 'Kotlina' },
  'Charcoal Pit': { en: 'Charcoal Pit', ru: 'Угольная яма', zh: '烧炭坑', ja: '炭焼き窯', fr: 'La Charbonnière', es: 'La Carbonera', ar: 'حفرة الفحم', pl: 'Mielerz' },
  'Forest Spring':{ en: 'Forest Spring', ru: 'Лесной родник', zh: '林中泉', ja: '森の泉', fr: 'La Source', es: 'El Manantial', ar: 'نبع الغابة', pl: 'Leśne Źródło' },
  'Deep Woods':   { en: 'Deep Woods', ru: 'Чаща', zh: '密林深处', ja: '森の奥', fr: 'Le Bois Profond', es: 'La Espesura', ar: 'الغابة العميقة', pl: 'Głęboki Las' }
};
/* `label` is the internal id (a building's `label`, or one of the bare strings
   above); everything else always addresses a place by that id and only ever
   reaches for the translated form when it is about to put text on the screen. */
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

/* Naming a thing to a villager takes both names, not either one.

   Every list of goods the game hands a villager — what they sell, what they
   would buy, what they are holding, what the deal is — was in English, on the
   reasoning that a villager can translate their own language. Mostly they
   can, and for French or Spanish "a bowl of soup" is a bowl of soup. But the
   names above are not a dictionary, they are this village's conventions: soup
   is `telo moku` and beer is `telo nasa pan` because that is what the signs
   and the traveller's own pockets say, and nothing about the English words
   "soup" and "beer" says so. Told only the English, an innkeeper invents
   something plausible and says that instead — or, having no word to invent
   from, says "soup", in English, in the middle of a sentence. Both were
   observed in one line of a toki pona village.

   So both travel together wherever an item is named: the English the game
   thinks in, and the name the player is already reading everywhere else. This
   is not a toki pona patch — a villager saying 光る石 while the inventory says
   光る石 is the consistency the place names have had all along, and the
   languages where the villager would have got it right anyway lose nothing by
   being told. English villages get one name, because they have one. */
LG.itemSaid = function (id, lang, short) {
  const it = LG.ITEMS[id];
  const en = (it && (short ? it.en : (it.full || it.en))) || id;
  return lang === 'en' ? en : en + ' (“' + LG.itemName(id, lang) + '”)';
};

/* --------------------------------------------------------- what the game says
   A handful of short lines the game narrates about a deal, in the language the
   village speaks rather than English — "you hand over the rope" is as much a
   chance to read the language as anything a villager says. {items} and {name}
   are substituted in; {cost} is left as a bare number so it reads the same
   everywhere. English doubles as the gloss shown underneath, click-to-reveal,
   the same convention the notebook and overheard speech already use. */
LG.CONJ = { ru: 'и', en: 'and', zh: '和', ja: 'と', fr: 'et', es: 'y', ar: 'و', pl: 'i' };

LG.TXN = {
  buy: {
    en: 'You buy {items} from {name} for ¤{cost}.',
    ru: 'Вы покупаете {items} у {name} за ¤{cost}.',
    zh: '你以¤{cost}的价格从{name}那里买下了{items}。',
    ja: '¤{cost}で{name}から{items}を買った。',
    fr: 'Vous achetez {items} à {name} pour ¤{cost}.',
    es: 'Le compras {items} a {name} por ¤{cost}.',
    ar: 'اشتريت {items} من {name} مقابل ¤{cost}.',
    pl: 'Kupujesz {items} od {name} za ¤{cost}.'
  },
  handOver: {
    en: 'You hand over {items} to {name} for ¤{cost}.',
    ru: 'Вы отдаёте {items} {name} за ¤{cost}.',
    zh: '你以¤{cost}的价格把{items}交给了{name}。',
    ja: '¤{cost}で{name}に{items}を渡した。',
    fr: 'Vous remettez {items} à {name} pour ¤{cost}.',
    es: 'Le entregas {items} a {name} por ¤{cost}.',
    ar: 'تم تسليم {items} إلى {name} مقابل ¤{cost}.',
    pl: 'Wręczasz {items} {name} za ¤{cost}.'
  },
  refund: {
    en: 'You return {items} to {name} and get ¤{cost} back.',
    ru: 'Вы возвращаете {items} {name} и получаете ¤{cost} обратно.',
    zh: '你把{items}还给了{name}，拿回了¤{cost}。',
    ja: '{name}に{items}を返して、¤{cost}を受け取った。',
    fr: 'Vous rendez {items} à {name} et récupérez ¤{cost}.',
    es: 'Le devuelves {items} a {name} y recuperas ¤{cost}.',
    ar: 'تم إرجاع {items} إلى {name} واسترجاع ¤{cost}.',
    pl: 'Zwracasz {items} {name} i odzyskujesz ¤{cost}.'
  },
  tradeReceive: {
    en: '{name} hands over {item}.',
    ru: '{name} отдаёт вам {item}.',
    zh: '{name}把{item}交给了你。',
    ja: '{name}が{item}を渡した。',
    fr: '{name} vous remet {item}.',
    es: '{name} te entrega {item}.',
    ar: 'تم تسليم {item} من {name}.',
    pl: '{name} wręcza ci {item}.'
  }
};
/* Every other language's four lines put the traveller in the grammatical
   subject seat — "you buy", "vous remettez" — because none of them mark the
   subject's gender for it. Arabic verbs do, and the traveller's gender is
   nothing the game ever asks after. Real Arabic solves exactly this problem
   in exactly this genre — a receipt, a sign, a notice — by dropping the
   personal subject altogether: تم + المصدر ("the buying/handing over/
   returning of X took place"), the same impersonal construction that keeps
   a road sign from having to guess who is reading it. So the Arabic lines
   are impersonal throughout, not translations of "you" with a gender
   picked for it. */

/* --------------------------------------------------------------- places
   Where a dropped thing can turn up, and where an animal likes to loiter.
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

  /* Up in the woods. Each of these is a glade world.js clears to open ground
     and threads a track to, which is what makes them findable — a thing lying
     in a stand of trees nobody can walk into is not lost, it is gone. The
     `label` is the name painted up on the map when you get near, so a glade
     can be recognised from the sentence a villager said about it. */
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

/* The order and membership LG.PLACES had before the forest and the station
   joined it. `LG.chain.generate` picks the terminal item's home with
   `pick(LG.PLACES..., rnd)`, which reads nothing but the list's length and
   order — so growing the list from 17 places to 24 is, on its own, enough to
   send the same seed's item somewhere else. A save written under the old
   list is not wrong, it is answering a question that has since changed
   shape, and the only way to still get its answer is to ask the old
   question. See the v1 migration in save.js.

   This is a historical fact about what LG.PLACES *used to be*, not a mirror
   of what it is — it must never be "kept in sync" with the array above. */
LG.PLACES_V1_IDS = ['pond', 'mine', 'fields', 'green', 'hall', 'woods', 'behind', 'road',
                     'orchard', 'beeyard', 'mill', 'school', 'chapel', 'graves', 'woodpile',
                     'smithy', 'hut'];

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
   Identity only. What each one wants, knows and will trade is decided
   per playthrough by chain.js. */
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
    workRect: { x: 3, y: 52, w: 5, h: 5 },
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
    workRect: { x: 32, y: 67, w: 18, h: 12 },
    sells: [{ i: 'flower', p: 1 }, { i: 'shell', p: 1 }, { i: 'feather', p: 1 }],
    buys: [{ i: 'sweets', p: 1 }, { i: 'apple', p: 1 }]
  },

  {
    id: 'yuri', name: 'Yuri', emoji: '🎣', color: '#3d5a80', job: 'the fisherman',
    persona: 'Dreamy and philosophical, half asleep, answers questions with questions about fish.',
    x: 12, y: 67, home: { x: 6, y: 66, w: 11, h: 2 },
    voice: { gender: 'male', age: 'middle' },
    workRect: { x: 6, y: 65, w: 12, h: 3 },
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
    workRect: { x: 63, y: 64, w: 14, h: 7 },
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
    workRect: { x: 16, y: 63, w: 8, h: 7 },
    sells: [{ i: 'log', p: 2 }, { i: 'rope', p: 3 }, { i: 'mushrooms', p: 2 }, { i: 'chestnut', p: 1 }],
    buys: [{ i: 'axe', p: 4 }, { i: 'saw', p: 4 }]
  }
];

/* ---------------------------------------------------- gossip mutterings
   What villagers say to each other in passing when they swap news. */
LG.CHATTER = {
  ru: ['Слышал новость?', 'Да ты что!', 'Ага, точно.', 'Не может быть!'],
  en: ['Did you hear?', "You don't say!", "Aye, that's right.", 'Never!'],
  zh: ['你听说了吗？', '真的吗！', '对，没错。', '不会吧！'],
  ja: ['聞いた？', 'まさか！', 'そうそう。', '本当に？'],
  fr: ['Tu as entendu ?', 'Sans blague !', "Oui, c'est ça.", 'Pas possible !'],
  es: ['¿Te has enterado?', '¡No me digas!', 'Sí, eso es.', '¡No puede ser!'],
  ar: ['سمعت؟', 'مستحيل!', 'نعم، هذا صحيح.', 'لا يمكن!'],
  pl: ['Słyszałeś?', 'Co ty powiesz!', 'No, zgadza się.', 'Nigdy!']
};

/* ------------------------------------------------------------ phrasebook
   Clickable starter phrases. Keep these SHORT — they are training wheels.

   These are the traveller's own lines, several of them addressed to
   whichever villager is on the other side of the box — a different register
   from LG.TXN's impersonal captions, and one real Arabic phrasebooks don't
   dodge the same way a sign does: they give the masculine second-person
   form and leave it there, the ordinary convention for a phrasebook rather
   than a notice. So these do too. */
LG.PHRASES = [
  { en: 'Hello!', ru: 'Привет!', zh: '你好！', fr: 'Bonjour !', es: '¡Hola!', ja: 'こんにちは！', ar: 'مرحباً!', pl: 'Cześć!' },
  { en: 'Who are you?', ru: 'Кто ты?', zh: '你是谁？', fr: 'Qui es-tu ?', es: '¿Quién eres?', ja: 'あなたはだれですか？', ar: 'من أنت؟', pl: 'Kim jesteś?' },
  {
    en: 'What is your name?', ru: 'Как тебя зовут?', zh: '你叫什么名字？',
    fr: "Comment tu t'appelles ?", es: '¿Cómo te llamas?', ja: 'お名前は何ですか？',
    jaRuby: 'お<ruby>名前<rt>なまえ</rt></ruby>は<ruby>何<rt>なん</rt></ruby>ですか？',
    ar: 'ما اسمك؟', pl: 'Jak masz na imię?'
  },
  {
    en: 'What do you need?', ru: 'Что тебе нужно?', zh: '你需要什么？', fr: 'De quoi as-tu besoin ?', es: '¿Qué necesitas?', ja: '何がいりますか？',
    jaRuby: '<ruby>何<rt>なに</rt></ruby>がいりますか？',
    ar: 'ماذا تحتاج؟', pl: 'Czego potrzebujesz?'
  },
  {
    en: 'Can you help me?', ru: 'Ты можешь мне помочь?', zh: '你能帮我吗？', fr: 'Peux-tu m’aider ?', es: '¿Puedes ayudarme?', ja: '手伝ってくれますか？',
    jaRuby: '<ruby>手伝<rt>てつだ</rt></ruby>ってくれますか？',
    ar: 'هل يمكنك مساعدتي؟', pl: 'Możesz mi pomóc?'
  },
  {
    en: 'Who has it?', ru: 'У кого это есть?', zh: '谁有？', fr: 'Qui l’a ?', es: '¿Quién lo tiene?', ja: 'だれが持っていますか？',
    jaRuby: 'だれが<ruby>持<rt>も</rt></ruby>っていますか？',
    ar: 'من لديه؟', pl: 'Kto to ma?'
  },
  { en: 'Where is it?', ru: 'Где это?', zh: '在哪里？', fr: 'Où est-ce ?', es: '¿Dónde está?', ja: 'どこにありますか？', ar: 'أين هو؟', pl: 'Gdzie to jest?' },
  {
    en: 'I have it!', ru: 'У меня есть!', zh: '我有！', fr: 'Je l’ai !', es: '¡Lo tengo!', ja: '持っています！',
    jaRuby: '<ruby>持<rt>も</rt></ruby>っています！',
    ar: 'عندي!', pl: 'Mam to!'
  },
  { en: 'Here you go.', ru: 'Вот, держи.', zh: '给你。', fr: 'Tiens.', es: 'Toma.', ja: 'はい、どうぞ。', ar: 'تفضل.', pl: 'Proszę.' },
  { en: 'How much does it cost?', ru: 'Сколько это стоит?', zh: '这个多少钱？', fr: 'Ça coûte combien ?', es: '¿Cuánto cuesta?', ja: 'いくらですか？', ar: 'كم يكلف؟', pl: 'Ile to kosztuje?' },
  { en: 'Thank you!', ru: 'Спасибо!', zh: '谢谢！', fr: 'Merci !', es: '¡Gracias!', ja: 'ありがとう！', ar: 'شكراً!', pl: 'Dziękuję!' },
  { en: "I don't understand.", ru: 'Я не понимаю.', zh: '我不明白。', fr: 'Je ne comprends pas.', es: 'No entiendo.', ja: 'わかりません。', ar: 'لا أفهم.', pl: 'Nie rozumiem.' },
  {
    en: 'Say that again, slowly.', ru: 'Повтори, медленно.', zh: '请再说一遍，慢一点。', fr: 'Répète, lentement.', es: 'Repite, despacio.', ja: 'もう一度、ゆっくり言ってください。',
    jaRuby: 'もう<ruby>一度<rt>いちど</rt></ruby>、ゆっくり<ruby>言<rt>い</rt></ruby>ってください。',
    ar: 'قل ذلك مرة أخرى، ببطء.', pl: 'Powtórz to, powoli.'
  }
];
