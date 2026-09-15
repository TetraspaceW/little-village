/* tools/books.js — where each language's full book comes from.

   The school bookshelf has no other content: opening it (js/game.js's
   openLibrary()) fetches the book listed here directly, in full --
   picking it up off the shelf just opens it, rather than showing a
   curated excerpt first. This file is the source list.

   This file is only ever read by tools/build-books.js, run by hand
   whenever a language's source changes -- never by the game itself and
   never at request time. Building fetches each source, cleans it up,
   and writes books/<lang>.json into the repo as an ordinary static
   asset (see that script's own header comment for why: no server-side
   dependency this way, so it works on a plain static host and not just
   under tools/logserver.js).

   Every entry below has been opened and confirmed to be the real book,
   in the right language, with a source this build script can actually
   read (see the `kind`s below) -- unlike an earlier pass at this file,
   which shipped nothing but unverified guesses. If you add a language,
   verify it the same way before trusting it: open the url, confirm the
   title and language, then check `node tools/build-books.js <lang>`
   actually produces readable prose, not a table of contents or mojibake.

   Three `kind`s of source, depending on what's actually available:

   - 'gutenberg': the simple case -- one Project Gutenberg book id whose
     plain-text mirror (pgNNNN.txt) is fetched as-is. English, Spanish,
     French and Polish all have a real edition of a real classic here.

   - 'wikisource': Gutenberg's catalog outside a handful of languages is
     thin to nonexistent (nothing usable in Chinese, Russian or Arabic
     was found there). Wikisource generally has the real thing instead,
     but splits a book across many separate wiki pages rather than
     shipping one plain-text file -- `pages` lists them in reading
     order, and build-books.js fetches each one (via the MediaWiki API's
     own HTML renderer, which is what actually expands the transclusion
     that puts a scanned book's text on the page at all) and stitches
     them together. Order matters and isn't discoverable from the API
     for every book (Gibran's *Dumʿa wa-Ibtisama* is ~60 loose essay
     pages with no machine-readable ordering found -- that's why `ar`
     below is a different, chapter-structured Gibran work instead).

   - 'aozora': Aozora Bunko (青空文庫), Japan's public-domain text
     archive, serves its HTML pages as Shift_JIS with no charset in the
     HTTP headers -- decoded as UTF-8 (as a naive fetch would) it comes
     out as mojibake. build-books.js decodes this kind with Node's own
     Shift_JIS-capable TextDecoder before stripping HTML.

   Two languages have no entry on purpose, not by oversight:
     - fr's *shelf* excerpt is Le Petit Prince, but the full book here
       is deliberately a different work: Le Petit Prince is public
       domain in France (Saint-Exupéry died 1944; France is life+70) but
       still under active US copyright, renewed through 2038.
     - tok: toki pona has no public-domain literature to point at at
       all -- its whole body of writing is recent and still in
       copyright, `pu` included. There's no substitute to offer. */
module.exports = {
  en: {
    title: 'The Wonderful Wizard of Oz', author: 'L. Frank Baum',
    kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/55/pg55.txt'
    // Gutenberg #55. Peter Rabbit (the shelf excerpt) is barely a few
    // pages -- too short to be worth a separate "read the whole book"
    // button. Oz is the standard answer to "first real English novel".
  },
  es: {
    title: 'Don Quijote de la Mancha', author: 'Miguel de Cervantes',
    kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/2000/pg2000.txt'
    // Gutenberg #2000, confirmed Spanish-language. (#66263, which an
    // id-pattern guess would have landed on, is a Hungarian translation
    // with a Spanish-looking title -- checked and rejected.)
  },
  fr: {
    title: 'Lettres de mon moulin', author: 'Alphonse Daudet',
    kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/11770/pg11770.txt'
    // Gutenberg #11770. Genuinely the standard "first real French book"
    // pick (La Chèvre de M. Seguin, in here, is a school staple) --
    // unlike Le Petit Prince, this one is actually free to fetch.
  },
  pl: {
    title: 'Pan Tadeusz', author: 'Adam Mickiewicz',
    kind: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/31536/pg31536.txt',
    verse: true // an epic poem -- its line breaks are real, not word-wrap;
                // see build-books.js's reflow(), which skips this flag
    // Gutenberg #31536, confirmed Polish. (#28240 is an English
    // translation of the same title -- checked and rejected.) Poland's
    // own national epic; a demanding first read, but the honest answer.
  },
  zh: {
    title: '阿Q正傳', titleEn: 'The True Story of Ah Q', author: '魯迅',
    kind: 'wikisource', site: 'zh', pages: ['阿Q正傳']
    // Lu Xun, 1921-22. Gutenberg has nothing usable in Chinese; this is
    // transcluded onto one Wikisource page (a scanned Complete Works
    // volume, pages 380-437), so it's a single fetch. The modern-
    // vernacular-Chinese answer to "the first serious book to actually
    // read" the way 活着 is today -- but Yu Hua is alive and 活着 (1993)
    // is very much still in copyright, so it can't be that.
  },
  ru: {
    title: 'Капитанская дочка', titleEn: "The Captain's Daughter", author: 'Александр Пушкин',
    kind: 'wikisource', site: 'ru',
    pages: [
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава I',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава II',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава III',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава IV',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава V',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава VI',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава VII',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава VIII',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава IX',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава X',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава XI',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава XII',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава XIII',
      'Капитанская дочка (Пушкин)/1960 (СО)/Глава XIV'
    ]
    // Pushkin, 1836 -- 14 chapters, each its own Wikisource page under
    // the 1960 Collected Works edition; the wiki's own chapter list
    // gives a clean, ordered set of page titles to fetch. Gutenberg has
    // almost no Russian-language text at all (two short unrelated
    // Pushkin poems and nothing else close).
  },
  ar: {
    title: 'الأجنحة المتكسرة', titleEn: 'Broken Wings', author: 'جبران خليل جبران',
    kind: 'wikisource', site: 'ar',
    pages: [
      'الأجنحة المتكسرة/توطئة',
      'الأجنحة المتكسرة/الكآبة الخرساء',
      'الأجنحة المتكسرة/يد القضاء',
      'الأجنحة المتكسرة/في باب الهيكل',
      'الأجنحة المتكسرة/الشعلة البيضاء',
      'الأجنحة المتكسرة/العاصفة',
      'الأجنحة المتكسرة/بحيرة النار',
      'الأجنحة المتكسرة/أمام عرش الموت',
      'الأجنحة المتكسرة/بين عشتروت والمسيح',
      'الأجنحة المتكسرة/التضحية',
      'الأجنحة المتكسرة/المنقذ'
    ]
    // Gibran, 1912 -- a preface plus 10 numbered chapters, one
    // continuous short novel, cleanly ordered on Wikisource. Not the
    // originally-proposed دمعة وابتسامة: that's a ~60-page loose essay
    // and poem anthology with no ordering the API exposes (each piece
    // is its own page; the collection page itself only transcludes the
    // scanned book's front matter). Gutenberg has essentially no Arabic
    // at all -- one unrelated title in its entire catalog.
  },
  ja: {
    title: '桃太郎', titleEn: 'Momotaro (Peach Boy)', author: '楠山正雄',
    kind: 'aozora', url: 'https://www.aozora.gr.jp/cards/000329/files/18376_12100.html'
    // Kusuyama Masao's retelling -- opens with the same line as the
    // shelf excerpt in js/data.js ("むかしむかし、あるところに、"),
    // unlike Akutagawa's more famous but differently-worded version.
  }
  // fr's shelf excerpt is Le Petit Prince but its full book above is a
  // different work, and tok has no entry -- both explained above.
};
