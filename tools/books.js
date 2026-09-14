/* tools/books.js — where each language's full book comes from.

   The school bookshelf (js/data.js's LG.BOOKS) always has a short, hand-
   picked excerpt for every language -- that's static, ships with the
   game, and needs no network. This file is the *optional* extra: a real,
   complete, public-domain book tools/logserver.js can fetch once and
   cache, so a player can actually sit down and read the whole thing
   (see the /book/:lang route below, and openFullBook() in js/game.js).

   Two languages have no entry here on purpose, not by oversight:
     - fr: the shelf's excerpt is Le Petit Prince, but Le Petit Prince
       itself can't go here -- it's public domain in France (Saint-
       Exupéry died in 1944; France is life+70) but still under active
       US copyright, renewed through 2038. A different, actually public-
       domain French classic (Perrault's fairy tales) is configured
       below instead; the shelf quote and the full book are deliberately
       not the same work for this one language.
     - tok: toki pona has no public-domain literature to point at at
       all -- its whole body of writing is recent and still in
       copyright, `pu` included. There's no substitute to offer.

   IMPORTANT -- every url below is UNVERIFIED. This file was written in a
   development sandbox with no outbound network access (see the commit
   that added it), so these are best-recollection guesses at Project
   Gutenberg / Aozora Bunko catalog entries, not confirmed working links.
   `url: null` means "no guess I trust enough to write down" rather than
   "no such book exists" -- `search` is what to look for instead. Before
   relying on any entry: open its url, confirm it's really that book, in
   the right language, as plain UTF-8 text (Gutenberg's `.txt` mirror,
   not its HTML page) -- then remove this warning for that language once
   it's been checked. A wrong or dead url just 502s (see /book/:lang) --
   it can't silently serve the wrong book -- but a stale placeholder
   left in for months is worse than a missing one, so please prune this
   comment as entries get verified. */
module.exports = {
  en: {
    title: 'The Tale of Peter Rabbit', author: 'Beatrix Potter',
    url: null, search: 'Beatrix Potter "The Tale of Peter Rabbit" site:gutenberg.org'
  },
  es: {
    title: 'Don Quijote de la Mancha', author: 'Miguel de Cervantes',
    url: null, search: 'Don Quijote de la Mancha texto completo español site:gutenberg.org'
  },
  ru: {
    title: 'Сказки', author: 'Александр Пушкин',
    url: null, search: 'Пушкин сказки полный текст site:gutenberg.org'
  },
  zh: {
    title: '唐詩三百首', author: null,
    url: null, search: '唐詩三百首 全文 site:gutenberg.org OR site:ctext.org'
  },
  fr: {
    // Deliberately not Le Petit Prince -- see the file comment above.
    title: 'Contes de ma mère l’Oye', author: 'Charles Perrault',
    url: null, search: 'Charles Perrault Contes de ma mère l\'Oye site:gutenberg.org'
  },
  pl: {
    title: 'Pan Tadeusz', author: 'Adam Mickiewicz',
    url: null, search: 'Pan Tadeusz Mickiewicz pełny tekst site:gutenberg.org'
  },
  ar: {
    title: 'ألف ليلة وليلة', author: null,
    url: null, search: 'ألف ليلة وليلة نص كامل site:gutenberg.org OR site:al-mostafa.com'
  },
  ja: {
    title: '桃太郎', author: null,
    // Aozora Bunko (青空文庫) is Japan's own Gutenberg-equivalent public-
    // domain text archive -- more likely to actually have this than
    // Gutenberg's own (small) Japanese-language catalog.
    url: null, search: '桃太郎 site:aozora.gr.jp'
  }
  // tok: no entry -- see the file comment above.
};
