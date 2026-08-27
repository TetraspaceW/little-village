/* dialogue.js — talking to the little guys: prompt building, model calls,
   trades, memory, and the conversation UI. */
window.LG = window.LG || {};

LG.dialogue = (function () {
  let current = null;      // the npc we're talking to
  let busy = false;

  const el = {};
  function bind() {
    ['dlg','dlgName','dlgRole','dlgLog','dlgInput','dlgSend','dlgClose','dlgPhrases',
     'dlgItems','dlgStatus','dlgAvatar'].forEach(id => el[id] = document.getElementById(id));
  }

  function chatterLine() {
    const arr = LG.CHATTER[LG.game.settings.lang] || LG.CHATTER.en;
    return arr[(Math.random() * arr.length) | 0];
  }

  /* Furigana arrives as markup from the model, so escape everything and then
     let exactly three tags back through — no attributes, nothing else. */
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  // <rb> and <rtc> are part of the ruby family and models do emit them
  const RUBY_TAG = /^(?:ruby|rb|rt|rtc|rp)$/;

  /* Peel the furigana back off, permissively — attributes, casing and the whole
     ruby tag family. This only feeds the comparison below, never the page. */
  function stripRuby(html) {
    return String(html)
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<rtc\b[^>]*>[\s\S]*?<\/rtc>/gi, '')
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
      .replace(/<\/?(?:ruby|rb|rt|rtc|rp)\b[^>]*>/gi, '');
  }
  /* Compare loosely enough to survive width and spacing differences, strictly
     enough that we never show the player words the villager did not say. */
  function normText(str) {
    let t = String(str);
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.replace(/\s/g, '');
  }
  function rubyMatches(ruby, say) {
    if (!ruby) return false;
    return normText(stripRuby(ruby)) === normText(say);
  }

  /* A reply may arrive fenced or quoted. Try the plausible unwrappings and take
     the first that survives validation — nothing unvalidated is ever accepted. */
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
  /* Readings written as 糸[いと] rather than as ruby tags.

     This is a real and common convention — it is how furigana is written in plain
     text everywhere — so a model reaching for it is not malfunctioning, and the
     fix is to accept it rather than to keep insisting. Only a run of kanji
     followed by a bracket containing nothing but kana converts; anything else is
     left exactly as it was, so ordinary brackets in a sentence survive. */
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
      /* A reading written this way covers the whole word, okurigana included —
         \u7d50\u3076[\u3080\u3059\u3076] is \u7d50\u3076 read \u3080\u3059\u3076. Ruby goes on the kanji alone, so the
         okurigana has to come back off the reading: \u7d50 gets \u3080\u3059 and the \u3076 stays bare.
         If the reading does not end in the okurigana we cannot safely split it,
         so the whole word is wrapped rather than guessed at. */
      if (okuri && reading.length > okuri.length &&
          reading.slice(-okuri.length) === okuri) {
        return '<ruby>' + kanji + '<rt>' + reading.slice(0, -okuri.length) + '</rt></ruby>' + okuri;
      }
      return '<ruby>' + kanji + okuri + '<rt>' + reading + '</rt></ruby>';
    });
  }

  function needsFurigana(say) { return KANJI.test(String(say)); }

  /* A villager sometimes writes the target language into the English field. A
     translation full of hanzi, kana or Cyrillic is worse than no translation,
     so treat it as missing and fetch a real one. */
  const NOT_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;
  function looksEnglish(str) {
    const t = String(str || '').trim();
    if (!t) return false;
    if (NOT_LATIN.test(t)) return false;
    return /[a-z]{2}/i.test(t);
  }
  function rubyHTML(str) {
    return String(str)
      // Keep the ruby family but strip it back to a bare tag — that removes every
      // attribute while preserving the structure. Anything else tag-shaped goes.
      .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash, name) => {
        const n = name.toLowerCase();
        return RUBY_TAG.test(n) ? '<' + slash + n + '>' : '';
      })
      .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/&lt;(\/?)(ruby|rb|rt|rtc|rp)&gt;/g, '<$1$2>')
      .replace(/<ruby>([\s\S]*?)<\/ruby>/g, dropKanaRuby);
  }

  /* Katakana and hiragana already say how they sound, so a reading over them is
     just clutter. Keep the base text, drop the annotation. */
  function dropKanaRuby(match, inner) {
    const base = String(inner)
      .replace(/<rt>[\s\S]*?<\/rt>/g, '')
      .replace(/<rp>[\s\S]*?<\/rp>/g, '')
      .replace(/<rtc>[\s\S]*?<\/rtc>/g, '')
      .replace(/<\/?(?:rb|rt|rtc|rp)>/g, '');
    return KANJI.test(base) ? match : base;
  }

  function itemName(id, lang) {
    const it = LG.ITEMS[id];
    return (it && (it[lang] || it.en)) || id;
  }

  /* -------------------------------------------------------- prompt build */
  /* The prompt and the schema come out of one call because they come out of one
     field list — see `fields` below. `systemPrompt` stays the string-returning
     wrapper the tests and the prompt dump use. */
  function buildReply(npc, offered) {
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const lvl = LG.LEVELS[s.level];
    /* One villager, assembled once — the same assembly that decides where they
       stand and what they say to each other. See view.js for why this stopped
       being three separate readings of the same character. */
    const v = LG.view.of(npc, 'player');
    const inv = LG.game.inventoryList();
    const trade = v.trade.deal;

    const lines = [];
    const coins = n => n + (n === 1 ? ' coin' : ' coins');
    lines.push('You are ' + v.name + ', who lives in this village and speaks ' + L.name + '.');
    lines.push('');
    lines.push('# Your character');
    lines.push('Name: ' + v.name + ' — ' + v.job + '.');
    lines.push('Personality: ' + v.persona);
    lines.push('Your current concern: ' + v.goal);
    lines.push('');
    /* Everybody in a village this size knows everybody else, at least by name
       and trade — that is background, not a fact anyone had to tell them, and
       it is not the same thing as the *player* learning a name (see
       `nameKnown` below): a villager saying "Tomas" to the traveller does not
       put Tomas's name on screen until Tomas says it himself. Without this a
       villager asked about a neighbour they had not personally exchanged a
       fact with had nothing to go on — which is exactly the gap that
       produced a rice merchant nobody had sold anything (see OLD-LI.md). */
    if (v.roster.length) {
      lines.push('# Everyone else in the village');
      lines.push('You have lived here for years; you know everyone in the village by name and trade, whether or not you have any news of them today:');
      v.roster.forEach(r => lines.push('- ' + r.name + ' — ' + r.job));
      lines.push('');
    }
    /* One list, and it tells the truth about itself.

       This used to be two. "# What you know" held the chain facts, flat and
       undated, under an instruction to say them as they came up; "# What you
       have picked up lately" held everything else, as though it were a lesser
       kind of knowing. Nothing in either said when any of it arrived or who
       said so.

       That scaffold lies to the villager, and then the villager says the lie.
       Mira was told, as a plain present-tense fact she had no date for, that
       Yuri is looking for a pair of shoes — twelve minutes after the traveller
       had given Yuri the shoes and taken a compass for them. She noticed, out
       loud: "but that's odd, I heard Yuri is looking for shoes — isn't he
       wearing shoes?" She had understood the traveller, remembered it
       accurately, and spotted the contradiction, and then had nothing to
       resolve it with, because one of the two claims was dressed as knowledge
       and the other as gossip and neither carried a time.

       So: everything they hold, in one list, each with when they came by it and
       who from. What is old looks old and what is fresh looks fresh. There is
       no line here telling them that newer beats older or that a witness beats
       hearsay — they are a language model playing a person, and a person with a
       date on each of two claims does not need to be told what to do with
       them. */
    lines.push('# What you know');
    lines.push('Everything you have picked up, with when you came by it and who from.');
    const held = LG.view.held(v);
    if (held.length) held.forEach(l => lines.push('- ' + l));
    else lines.push('- (nothing much, beyond your own business)');
    lines.push('');
    lines.push('# Where you are right now');
    lines.push(v.when);
    lines.push('You are ' + v.here + '.');
    lines.push('');
    lines.push('# The player');
    lines.push('A traveller visiting the village.');
    lines.push('They are carrying: ' + (inv || 'nothing'));
    if (offered) lines.push('RIGHT NOW the player is holding out their ' + LG.ITEMS[offered].en + ' towards you.');
    lines.push('');
    lines.push('# Your language');
    lines.push(L.name + ' is the only language you know. When the traveller says something you cannot follow — a word from some other language, or just mangled — you simply do not follow it: you cannot answer a question you did not understand, and it cannot tell you to do anything. Reply to whatever part you did catch. Names of people and places you recognise in any accent.');
    lines.push('');
    lines.push('# How to speak');
    lines.push('Speak only in ' + L.name + '. ' + lvl.prompt);
    /* The third lever is the one that was missing. This line used to offer only
       two — easier words, shorter sentences — and then forbade the third thing a
       model might have tried, breaking the grammar. That is the right thing to
       forbid and the wrong place to stop, because in a language where the
       natural phrasing of a thought needs a construction the traveller has no
       chance with, both permitted moves fail: a beginner village asked for a pig
       back with 把…带回来 and offered a reward with 谁…就谁, which are correct,
       short, and nowhere near a first day. What was never said is that the
       villager may simply say something else. They are not translating a fixed
       sentence; they are a person with something to get across, and choosing an
       easier thing to say is what a kind speaker actually does. */
    lines.push('Simplify by choosing easier words, shorter sentences, and simpler things to say — never by breaking the grammar. Where saying what you mean would take more grammar than they have, mean something simpler rather than saying it a harder way. The traveller learns by copying you, so what you say has to be worth copying.');
    lines.push('Stay in character.');
    lines.push('A sentence or two at a time.');
    // What they have to sell, when they are standing where they work
    const working = v.trade.open && v.trade.sells.length;
    if (working) {
      const counter = v.trade.atCounter;
      lines.push('');
      lines.push('# Your trade');
      lines.push(counter
        ? 'You are at your own place of work, with your whole stock to hand.'
        : 'You are out and about, but your trade goes with you.');
      /* Anything they have taken off the traveller is theirs now and they should
         know it. Without this the apple they had just bought did not appear
         anywhere in what they could see, and they went on saying they had no
         apples — truthfully, from where they were standing. */
      if (v.trade.stock.length) {
        lines.push('In your hands right now, bought off the traveller: ' +
          v.trade.stock.map(it => it.full + (it.n > 1 ? ' \u00d7' + it.n : '')).join(', ') +
          '. You have these; you can say so, and sell them on if you like.');
      }
      lines.push('These are yours to sell. The price is what you usually ask, not a rule:');
      v.trade.sells.forEach(w => lines.push('- ' + LG.ITEMS[w.i].full + ' — ' + coins(w.p) + ' [' + w.i + ']'));
      if (v.trade.sellsTags.length) {
        const more = Object.keys(LG.ITEMS)
          .filter(k => k !== 'coins' && !v.trade.sells.some(w => w.i === k) &&
                       v.trade.sellsTags.some(t => (LG.ITEMS[k].tags || []).indexOf(t) !== -1));
        lines.push('You also keep the ordinary run of shop goods, about ' +
          coins(Math.max(1, Math.round(LG.priceOf(more[0] || 'salt')))) + ' apiece — among them ' +
          more.slice(0, 14).map(k => LG.ITEMS[k].en + ' [' + k + ']').join(', ') +
          ', and plenty besides. If the traveller asks for something a village shop would stock, you have it.');
      }
      if (v.trade.buys.length) {
        lines.push('You would also buy, if the traveller happens to have one:');
        v.trade.buys.forEach(w => lines.push('- ' + LG.ITEMS[w.i].full + ' — you would pay about ' +
          coins(w.p) + ' [' + w.i + ']'));
      }
      lines.push('The traveller has ' + coins(LG.game.count('coins')) + ' on them.');

      lines.push('Offer your goods the way you would to any customer, and haggle if it suits you.');
      /* This used to stop at "that is them paying you", unconditionally, which is
         an instruction to complete a sale that says nothing about whether one is
         outstanding. Tomas had already been paid for the knife and the till in
         front of him said so — and then the traveller held out coins, because
         from where they stood the deal struck a moment ago had not been settled
         yet, and the rule told him to hand another knife over. He did. */
      lines.push('If the traveller holds out their coins, that is them paying you for something you have not handed over yet — take the money and hand the goods over in the same breath. Something the record already shows you were paid for is not being bought a second time.');
      lines.push('Two things at once is still one sale: put both tags in "item" and the total in "price". Only list what you are actually handing over this turn.');
    } else if (v.trade.sells.length) {
      /* The small hours are the one time the shop is shut, and saying nothing
         about it left them selling anyway: Mikhalych took two coins for a cup of
         tea at midnight, twice, and the game turned both down without a word to
         either party. If they cannot trade they have to know it.

         Their situation, and nothing else. The first version of this told them
         not to offer, not to name a price and not to take the money, and added
         that they would like the custom — which is three failure modes named out
         loud and a feeling issued to a character who already has one. What they
         do about being shut is theirs. */
      lines.push('');
      lines.push('# Your trade');
      lines.push('It is the middle of the night. Your trade is shut until morning.');
    }

    {
      /* The till: what the game actually did, as its own record rather than
         buried in the conversational memory. A villager who can read this can
         work out for themselves that they were paid for two drinks and handed
         over one — which is the sort of thing a shopkeeper does without needing
         a rule written for it. It sits outside the block above on purpose: a
         villager who has just been told a sale did not go through needs to read
         that whether or not they are open for business. */
      const till = v.trade.till;
      if (till.length) {
        lines.push('');
        lines.push('# The till');
        lines.push('What has actually changed hands between you and this traveller:');
        till.forEach(t => {
          if (t.failed) { lines.push('- (nothing happened: ' + t.note + ')'); return; }
          const line = t.act === 'sell'
            ? 'you handed over ' + t.names + ' and took ' + coins(t.coins)
            : t.refund ? 'they gave back ' + t.names + ' and you refunded ' + coins(t.coins)
                       : 'you took ' + t.names + ' off them for ' + coins(t.coins);
          lines.push('- ' + t.at + ' \u2014 ' + line +
            (t.asked !== t.coins ? ' (you said ' + t.asked + ', the till took ' + t.coins + ')' : ''));
        });
        /* With the count. Tomas sold the same traveller two knives, and this line
           said "knife" — so the ledger above him listed two sales and the summary
           beside it named one object, and when the traveller held a knife out he
           reasoned from his trade ("I don't buy knives, I make them") rather than
           from the two he had just sold. */
        if (v.trade.sold.length) lines.push('Still in their hands, from you: ' +
          v.trade.sold.map(it => (it.n > 1 ? it.n + ' \u00d7 ' + it.en : it.en)).join(', ') + '.');
        lines.push('This is the record. If it does not match what you thought, the record is right.');
      }
    }

    if (trade) {
      lines.push('');
      lines.push('# Your deal');
      lines.push('You want: ' + (trade.wants === 'coins'
        ? coins(trade.wantsCount)
        : LG.ITEMS[trade.wants].full) + '.');
      lines.push('You will give in return: ' + (trade.gives === 'coins'
        ? coins(trade.givesCount)
        : LG.ITEMS[trade.gives].full) + '.');
      lines.push(trade.hint);
    }
    /* A concluded deal has to say so. It used simply to vanish from the prompt
       the moment it completed, leaving the villager with no sign it had ever
       happened — so they went on trying to finish it, and the schema turned each
       attempt into another transaction. Silence is not the same as closure. */
    if (v.trade.done) {
      const r = v.trade.done;
      lines.push('');
      lines.push('# Your deal');
      lines.push('Done, earlier today: the traveller gave you ' +
        (r.wants === 'coins' ? coins(r.wantsCount) : LG.ITEMS[r.wants].full) +
        ' and you handed over ' +
        (r.gives === 'coins' ? coins(r.givesCount) : LG.ITEMS[r.gives].full) +
        '. That exchange is finished and does not want doing again.');
    }
    /* Furigana gets its own section with a worked sentence. It used to live inside
       the JSON block as the description of the "say" field, which meant the only
       example of the markup was nested inside a JSON string inside a schema — easy
       to skim past, and easy to mangle. A whole annotated sentence, shown outside
       the schema, is a far better specification than a rule about one word. */
    if (L.furigana) {
      lines.push('');
      lines.push('# Furigana');
      lines.push('What you say goes in "say" with the readings already in it.');
      lines.push(LG.FURIGANA);
    }
    if (L.diacritics) {
      lines.push('');
      lines.push('# Diacritics');
      lines.push('What you say goes in "say" fully vocalised, tashkeel and all.');
      lines.push(LG.TASHKEEL);
    }
    const acts = ['none'];
    if (trade) acts.push('trade');
    if (working) acts.push('sell', 'buy');

    /* One list, three readers. The block the villager reads, the sentence naming
       what is never omitted, and — where the provider will take one — the JSON
       Schema that stops this being a matter of the model's judgement at all are
       all rendered from the same array, so a field cannot be described in the
       prompt and missing from the schema, or typed one way and explained
       another. Which fields exist is a decision about the game; it is made once,
       here. */
    const fields = [
      { k: 'say', always: true, type: { type: 'string' },
        desc: 'what you say out loud, in ' + L.name +
              (L.furigana ? ', with the furigana as above' : '') +
              (L.diacritics ? ', with the tashkeel as above' : '') },
      { k: 'translation', always: true, type: { type: 'string' },
        desc: 'an English translation of exactly what you said' }
    ];
    if (L.romanize) fields.push({ k: 'roman', always: true, type: { type: 'string' },
      desc: 'the ' + L.romanLabel + ' of what you said' +
            (L.romanNote ? ', ' + L.romanNote : '') });
    fields.push({ k: 'understood', always: true,
      type: { type: 'string', enum: ['full', 'partial', 'none'] },
      desc: 'full | partial | none — how much of what the traveller just said you actually understood' });
    fields.push({ k: 'revealed', arr: true,
      type: { type: 'array', items: { type: 'string' } },
      desc: 'tags of any facts above that you plainly TOLD the traveller this turn — [] if none' });
    /* This used to read "OPTIONAL: ... a NEW fact you just learned from the
       traveller. Omit this unless you understood them." — which makes
       understanding them the whole of the test, and a villager who understood a
       greeting perfectly well has been told a new fact is there to be stated. So
       one did: Petra met "こんにちは！" and wrote down that the traveller's name
       was Mira — a name nobody had said. Ask instead for what was worth keeping,
       the way the villager-to-villager call already does, and give "nothing was"
       a spelling of its own. */
    fields.push({ k: 'remember', type: { type: ['string', 'null'] },
      desc: 'anything the traveller has said that is worth remembering, as one short English sentence — null if nothing was' });
    if (working) {
      /* commerce() already takes either a tag or a list, so the schema asks for
         the list — one shape to check rather than two to allow. */
      fields.push({ k: 'item', type: { type: ['array', 'null'], items: { type: 'string' } },
        desc: 'the [tag] of the goods, or a list of tags if it is more than one thing — only with sell or buy' });
      fields.push({ k: 'price', type: { type: ['number', 'null'] },
        desc: 'the coins agreed for all of it together, as a number — only with sell or buy' });
    }
    fields.push({ k: 'action', type: { type: 'string', enum: acts },
      desc: acts.join(' | ') });

    lines.push('');
    lines.push('# Reply format');
    lines.push('Reply with a single JSON object and nothing else:');
    lines.push('{');
    fields.forEach((f, i) => {
      const val = f.arr ? '["' + f.desc + '"]' : '"' + f.desc + '"';
      lines.push('  "' + f.k + '": ' + val + (i < fields.length - 1 ? ',' : ''));
    });
    lines.push('}');
    // (the word-reading rule lives in LG.FURIGANA now, with the rest of the spec)
    /* Which fields are never omitted, spelled out. Every field but "say" used to
       carry a hedge — OPTIONAL, only with sell or buy, [] if none, when in doubt
       leave it out — and nothing anywhere said that any field was mandatory, so
       the object as a whole read as mostly-optional. On a turn with nothing to
       report the model took the obvious next step and dropped the tail: a third
       of the player-facing replies in one session came back as a bare
       {"say": …}, every one of them a courtesy ("you're welcome") or a
       vocabulary gloss ("a pig is a kind of animal") — exactly the turns where
       "revealed" is [] and "action" is "none". The villager-to-villager call,
       whose three fields carry no hedges at all, was perfect across the same
       session, which is what makes this the schema's fault rather than the
       model's. So: name the always-fields, and give "nothing happened" a
       spelling of its own so it does not have to be expressed by absence. */
    const always = fields.filter(f => f.always).map(f => '"' + f.k + '"');
    lines.push('Every reply carries ' + always.slice(0, -1).join(', ') + ' and ' +
               always[always.length - 1] + '. A one-word answer, a greeting, or ' +
               'explaining what a word means carries them just the same as a long ' +
               'reply — there is no short form of this object.');
    lines.push('Where nothing happened, say so in the field rather than dropping it: ' +
               '"revealed" is [], "remember" is null, "action" is "none".' +
               (working ? ' Only "item" and "price" are ever absent.'
                        : ' No field is ever absent.'));
    /* And a worked one, because this project has learned twice now that a filled-in
       example specifies a format better than a sentence about it does — the
       furigana spec moved out of the schema for the same reason. The rule above
       says the tail is never dropped; this shows a reply that had nothing at all
       to report and still carries every field, which is the exact turn that was
       coming back bare. */
    const shown = { say: '"<your line, in ' + L.name + '>"',
                    translation: '"<the same line, in English>"',
                    roman: '"<the ' + L.romanLabel + '>"',
                    understood: '"full"' };
    const ex = fields.filter(f => f.always).map(f => '"' + f.k + '": ' + shown[f.k]);
    ex.push('"revealed": []', '"remember": null, "action": "none"');
    lines.push('A turn where nothing at all happened — a greeting, a thank-you, ' +
               'telling them what a word means — still looks like this:');
    lines.push('{' + ex.join(', ') + '}');
    lines.push('"translation" and "remember" are notes for the game, not speech — writing English there does not mean you understand any.');
    lines.push('"revealed" is about what you asserted, not what you talked about: using the word, explaining what it means, or asking after it does not count. When in doubt, leave the tag out of the list.');
    lines.push('"remember" is about what they told you — what they want, who they are, what they are carrying, what they are like. Not everything said is worth remembering: a greeting, a thank-you, or a word they were asking after tells you nothing, and that is null. Write down what they said, never what you assumed.');
    if (working) {
      lines.push('Use "sell" at the moment you actually hand goods over and take the money, and "buy" when you take something off the traveller and pay for it — not while the two of you are still discussing it.');
    }
    if (trade) {
      lines.push('Set "action" to "trade" at the moment you actually hand over ' + (trade.gives === 'coins' ? 'the coins' : LG.ITEMS[trade.gives].full) + ', and not before.');
      lines.push('Someone holding an object out to you is a gesture you understand without words — but a gesture is not yet a bargain. If it is not clear what the two of you are exchanging, ask them before you take it. Once the exchange is plain to you both, take it and hand yours over in the same breath.');
    }
    /* Every field is required and the optional ones are nullable, rather than
       some being absent from `required`: that is the one shape both providers
       accept, and it is also the shape that says what the prompt says — nothing
       is omitted, and a turn with nothing to report spells that out as null, []
       and "none". */
    const props = {}, required = [];
    fields.forEach(f => { props[f.k] = f.type; required.push(f.k); });
    return { text: lines.join('\n'),
             schema: { type: 'object', properties: props, required: required,
                       additionalProperties: false } };
  }

  function systemPrompt(npc, offered) { return buildReply(npc, offered).text; }

  function historyMessages(npc) {
    const msgs = [];
    npc.history.slice(-8).forEach(h => {
      msgs.push({ role: 'user', content: h.player });
      msgs.push({ role: 'assistant', content: JSON.stringify({ say: h.say }) });
    });
    return msgs;
  }

  /* ---------------------------------------------------------------- UI */
  /* `why`, if given, means the villager came looking for the traveller —
     LG.game.talkTo passes it through from `n.why`, empty string and all —
     and it is their turn to speak first, the way it would be in real life if
     someone went out of their way to find you. `undefined` for the ordinary
     case, where the player speaks first as always. */
  function open(npc, why) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    current = npc;
    npc.frozen = true;
    npc.metPlayer = true;
    el.dlg.classList.add('open');
    /* The player types the village's language into this box, so it is tagged
       as that: it is what an IME keys off, and what stops a browser's English
       spellchecker underlining every word the player gets right. */
    el.dlgInput.lang = L.tag;
    // The role sits right underneath, so a name placeholder that repeated it
    // ("the village baker" over "the village baker") would read as a glitch
    // rather than a mystery — the same mark the nametag over their head uses.
    el.dlgName.textContent = npc.nameKnown ? npc.def.name : '?';
    el.dlgRole.textContent = npc.def.job;
    el.dlgAvatar.textContent = npc.def.emoji;
    el.dlgAvatar.style.background = npc.def.color;
    el.dlgLog.innerHTML = '';
    renderPhrases();
    renderItems();
    if (npc.history.length) {
      npc.history.slice(-4).forEach(h => {
        if (h.player && !h.silent) addLine('player', h.player);
        addLine('npc', h.say, h.translation, h.roman,
                rubyMatches(h.ruby, h.say) ? h.ruby : null, npc);
      });
    } else if (typeof why !== 'string') {
      status('Say hello — or click a phrase below.');
    }
    if (typeof why === 'string') {
      send('', null, '[You went looking for the traveller and have just found them.' +
        (why ? ' What brought you: ' + why + '.' : '') +
        ' Say your opening line.]');
    }
    setTimeout(() => el.dlgInput.focus(), 60);
  }

  function close() {
    LG.tts.stop();
    if (current) current.frozen = false;
    current = null;
    el.dlg.classList.remove('open');
    LG.game.canvas.focus();
  }

  function status(msg, kind) {
    el.dlgStatus.textContent = msg || '';
    el.dlgStatus.className = 'dlg-status ' + (kind || '');
  }

  function speakLine(npc, text) {
    if (!npc || !LG.game.settings.voices) return;
    LG.tts.speak(LG.game.ttsConfig(), npc.def.id, text);
  }

  function addLine(who, text, translation, roman, ruby, npc) {
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const row = document.createElement('div');
    row.className = 'line ' + who;
    const bub = document.createElement('div');
    bub.className = 'bub';
    const main = document.createElement('div');
    main.className = 'main';
    if (ruby && L.furigana) {
      main.innerHTML = rubyHTML(ruby);
      main.classList.add('has-ruby');
    } else {
      main.textContent = text;
    }
    /* Three lines in three languages sit in this bubble, so each is tagged
       rather than the bubble around them: the spoken line is the village's,
       the romanisation is the same language in Latin letters, and the gloss
       is English. Both sides of the conversation are in the village language
       — the player is typing it too — so the tag goes on either speaker,
       even though only the villager gets the font. */
    main.lang = L.tag;
    if (who === 'npc') main.style.fontFamily = L.fontStack;
    bub.appendChild(main);
    if (who === 'npc' && npc && s.voices && LG.tts.state === 'ready') {
      const say = document.createElement('button');
      say.className = 'replay';
      say.textContent = '🔊';
      say.title = 'Hear it again';
      say.onclick = () => speakLine(npc, text);
      bub.appendChild(say);
    }
    // both gloss lines exist from the start so a late repair can fill them in
    const r = document.createElement('div');
    r.className = 'roman';
    r.lang = L.romanTag;
    r.textContent = roman || '';
    r.style.display = roman ? '' : 'none';
    bub.appendChild(r);

    const tr = document.createElement('div');
    tr.className = 'trans' + (s.showTranslation ? '' : ' hidden-tr');
    tr.lang = 'en';
    tr.textContent = translation || '';
    tr.title = s.showTranslation ? '' : 'click to reveal';
    tr.onclick = () => tr.classList.remove('hidden-tr');
    tr.style.display = translation ? '' : 'none';
    bub.appendChild(tr);

    row._main = main; row._roman = r; row._trans = tr;
    row.appendChild(bub);
    el.dlgLog.appendChild(row);
    el.dlgLog.scrollTop = el.dlgLog.scrollHeight;
    return row;
  }

  function renderPhrases() {
    const s = LG.game.settings;
    el.dlgPhrases.innerHTML = '';
    LG.PHRASES.forEach(p => {
      const b = document.createElement('button');
      b.className = 'chip';
      if (s.lang === 'ja' && p.jaRuby) { b.innerHTML = rubyHTML(p.jaRuby); b.classList.add('has-ruby'); }
      else b.textContent = p[s.lang] || p.en;
      b.lang = LG.LANGUAGES[s.lang].tag;
      b.style.fontFamily = LG.LANGUAGES[s.lang].fontStack;
      b.title = p.en;
      b.onclick = () => { el.dlgInput.value = p[s.lang] || p.en; el.dlgInput.focus(); };
      el.dlgPhrases.appendChild(b);
    });
  }

  function renderItems() {
    const s = LG.game.settings;
    el.dlgItems.innerHTML = '';
    const inv = LG.game.state.inv;
    const keys = Object.keys(inv).filter(k => inv[k] > 0);
    if (!keys.length) {
      el.dlgItems.innerHTML = '<span class="muted">(you are carrying nothing)</span>';
      return;
    }
    keys.forEach(k => {
      const b = document.createElement('button');
      b.className = 'chip item';
      // the icon is an emoji and the tooltip is English; only the name is theirs
      b.innerHTML = LG.ITEMS[k].icon + ' <span lang="' + LG.LANGUAGES[s.lang].tag + '">' +
        itemName(k, s.lang) + (inv[k] > 1 ? ' ×' + inv[k] : '') + '</span>';
      b.title = 'Offer your ' + LG.ITEMS[k].en;
      b.onclick = () => send('', k);
      el.dlgItems.appendChild(b);
    });
  }

  /* -------------------------------------------------------- the exchange */
  /* `prompt` is a stage direction rather than something the player typed —
     used when a villager who came looking for the traveller (see
     LG.game.talkTo) speaks first. It stands in for `shown` as the turn's own
     line, so the history and the model both see it happened, but it never
     goes on screen as a line of the player's — see the `silent` flag below
     and its one reader in `open`. */
  async function send(text, offered, prompt) {
    if (!current || busy) return;
    text = (text || '').trim();
    if (!text && !offered && !prompt) return;
    const npc = current;
    busy = true;
    el.dlgSend.disabled = true;

    const shown = prompt || (offered
      ? (text ? text + '  ' : '') + '[holds out the ' + LG.ITEMS[offered].en + ']'
      : text);
    if (!prompt) { addLine('player', shown); el.dlgInput.value = ''; }
    status(LG.game.displayName(npc) + ' is thinking…', 'thinking');

    let reply;
    try {
      const cfg = LG.game.llmConfig();
      const msgs = historyMessages(npc);
      msgs.push({ role: 'user', content: shown || '[says nothing, just holds out the item]' });
      const built = buildReply(npc, offered);
      reply = await LG.llm.speak(cfg, built.text, msgs, built.schema);
    } catch (err) {
      status('⚠ ' + err.message, 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    if (!reply || !reply.say) {
      if (!prompt) status('⚠ ' + LG.game.displayName(npc) + ' said something the game could not read. Try again.', 'error');
      else status('Say hello — or click a phrase below.');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    // For a furigana language the villager annotates as it writes, so the spoken
    // line is whatever remains once the readings are peeled off.
    const L = LG.LANGUAGES[LG.game.settings.lang];
    let spoken = reply.say, ruby = null;
    if (L.furigana) {
      const written = normaliseFurigana(reply.say);
      const bare = stripRuby(written);
      if (bare !== written) { ruby = written; spoken = bare; }       // annotated in one pass
      else if (reply.ruby) ruby = usableRuby(reply.ruby, reply.say); // separate field, still honoured
    }

    const turn = { player: shown, silent: !!prompt, say: spoken, translation: reply.translation,
                   roman: reply.roman, ruby: ruby };
    npc.turns = (npc.turns || 0) + 1;       // history is trimmed; this only ever goes up
    npc.history.push(turn);
    if (npc.history.length > 20) npc.history.shift();
    const gotIt = String(reply.understood || 'full').toLowerCase() !== 'none';

    /* Their name is unknown until they actually say it — see LG.game.displayName.
       There is no schema field for this, deliberately: it would be one more
       thing to hedge and drop the way the rest of the reply object once did
       (see "Getting a whole object back"), for a fact that is easy to check
       for free against something the turn already gives us. The translation
       is guaranteed English or blanked below, so a villager stating their own
       name shows up there as their name, in Latin letters, whatever the
       village speaks — checked against `reply.translation` before that
       blanking happens, not against `turn.translation` afterward. */
    if (gotIt && !npc.nameKnown && looksEnglish(reply.translation) &&
        new RegExp('\\b' + npc.def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
          .test(reply.translation)) {
      npc.nameKnown = true;
      el.dlgName.textContent = npc.def.name;
      LG.game.log('You learn their name — ' + npc.def.name + '.');
    }

    if (gotIt && Array.isArray(reply.revealed) && reply.revealed.length) {
      pending.push(verifyRevealed(npc, reply, spoken, ruby));   // deliberately not awaited
    }
    if (gotIt && reply.remember && typeof reply.remember === 'string' && reply.remember.length > 3) {
      if (LG.game.remember(npc, reply.remember, 'the traveller')) {
        LG.game.log(LG.game.displayName(npc) + ' will remember: "' + reply.remember + '"');
        /* And it may have overtaken something. Only asked when something new has
           actually landed, so a turn that taught them nothing costs nothing. */
        pending.push(reviseHeld(npc, reply.remember));
      }
    }

    const row = addLine('npc', spoken, reply.translation, reply.roman, ruby, npc);
    speakLine(npc, spoken);
    if (L.furigana && !ruby && needsFurigana(spoken)) {
      pending.push(repairFurigana(npc, spoken, row));               // ask the small model for it
    }
    const missingTrans = !looksEnglish(reply.translation);
    const missingRoman = L.romanize && !looksEnglish(reply.roman);
    if (reply.translation && missingTrans) {
      // don't show the player a "translation" in the language they are learning
      reply.translation = '';
      turn.translation = '';
    }
    if (reply.roman && missingRoman) { reply.roman = ''; turn.roman = ''; }
    if (missingTrans || missingRoman) {
      pending.push(repairGloss(npc, spoken, row,
        { translation: !missingTrans, roman: !missingRoman }));
    }
    npc.bubble = spoken; npc.bubbleT = 6;   // the canvas bubble stays plain text

    const u = String(reply.understood || '').toLowerCase();
    if (u === 'none') status(LG.game.displayName(npc) + ' did not understand you at all.', 'miss');
    else if (u === 'partial') status(LG.game.displayName(npc) + ' only caught part of that.', 'miss');
    else status('');

    /* Shopkeeping: the villager decides a sale has happened; the game makes it
       real — or says why it did not. This used to be skipped entirely outside
       working hours, so a midnight sale was neither made nor refused: the
       villager described handing the tea over, and nothing anywhere disagreed. */
    const act = gotIt ? String(reply.action || '').toLowerCase() : '';
    if (act === 'sell' || act === 'buy') {
      if (LG.game.commerce(npc, act, reply.item, reply.price)) renderItems();
      else status('That sale could not be squared up.', 'miss');
    }

    /* A refund is a gesture too. Holding out something this villager sold you is
       the plainest way of asking for the money back, and what comes back is
       usually a villager agreeing to it in words and flagging nothing — the same
       failure confirmOffer exists for, on the other side of the counter. Tomas
       described taking a knife back and returning two coins with "action":
       "none", so the traveller kept both knives and got nothing, and the villager
       believed he had refunded one. */
    const held = (npc.sold || {})[offered];
    if (act !== 'buy' && offered && held && held.n > 0) {
      pending.push(confirmRefund(npc, offered, held.price, spoken, reply.translation));
    }

    // A trade happens because the villager agreed to it, never because an object
    // was waved at them. If they agreed in words but forgot the field, a second
    // reader catches that — see confirmOffer.
    const trade = npc.tradeDone ? null : (LG.game.plan.roles[npc.def.id] || {}).trade;
    if (trade) {
      const need = trade.wantsCount || 1;
      const haveEnough = LG.game.count(trade.wants) >= need;
      const modelSaysTrade = gotIt && String(reply.action || '').toLowerCase().indexOf('trade') !== -1;
      if (modelSaysTrade && haveEnough) {
        LG.game.doTrade(npc, trade);
        renderItems();
      } else if (offered === trade.wants && haveEnough) {
        pending.push(confirmOffer(npc, trade, spoken, reply.translation));
      } else if (offered) {
        status(LG.game.displayName(npc) + ' does not want your ' + LG.ITEMS[offered].en + '.');
      }
    } else if (offered) {
      status(LG.game.displayName(npc) + ' has no use for that.');
    }

    busy = false;
    el.dlgSend.disabled = false;
    el.dlgInput.focus();
  }

  /* The villager nominates facts it thinks it revealed; a second, cheaper model
     confirms them against what was actually said before anything is written in
     the notebook. Runs after the reply is on screen, so nobody waits for it. */
  const pending = [];

  /* A villager sometimes answers with no translation, or no romanisation. Ask
     the small model for the missing half rather than leaving a learner with a
     bare sentence. */
  async function repairGloss(npc, spoken, row, have) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    try {
      const got = await LG.llm.gloss(LG.game.llmConfig(), spoken,
        { langName: L.name, romanLabel: (L.romanize && !have.roman) ? L.romanLabel : null });
      if (!got) return;
      const turn = npc.history[npc.history.length - 1];
      if (!have.translation && got.translation) {
        if (turn && turn.say === spoken) turn.translation = got.translation;
        if (row && row._trans) { row._trans.textContent = got.translation; row._trans.style.display = ''; }
      }
      if (L.romanize && !have.roman && got.roman) {
        if (turn && turn.say === spoken) turn.roman = got.roman;
        if (row && row._roman) { row._roman.textContent = got.roman; row._roman.style.display = ''; }
      }
    } catch (e) { /* the line is still readable */ }
  }

  /* A villager who has just learned something looks at what they already held and
     may rewrite one line of it. Not a deletion: "Yuri is looking for shoes"
     becomes "Yuri was looking for shoes, and has them now", which is both true
     and still worth passing on — the village should be able to tell you the
     errand was run, not just fall silent about it.

     A chain fact keeps its id and gains their own wording; the notebook is built
     on those ids and none of them move. Anything untagged is theirs outright and
     is simply rewritten. Runs after the reply is on screen, and a failure leaves
     them believing what they believed. */
  async function reviseHeld(npc, fresh) {
    try {
      const v = LG.view.of(npc, 'player');
      const entries = LG.view.heldEntries(v);
      if (entries.length < 1) return;
      const got = await LG.llm.revise(LG.game.llmConfig(), {
        who: npc.def.name, held: LG.view.held(v), fresh: fresh
      });
      if (!got) return;
      const e = entries[got.n - 1];
      if (!e || e.text === got.line) return;
      if (e.id) { npc.factNote = npc.factNote || {}; npc.factNote[e.id] = got.line; }
      else e.text = got.line;                       // the view hands back the object itself
      if (LG.game.think) LG.game.think(npc, 'thinks again', e.text + ' \u2192 ' + got.line);
      LG.game.log(LG.game.displayName(npc) + ' now reckons: "' + got.line + '"');
    } catch (err) { /* they go on believing what they believed */ }
  }

  /* The same reader, pointed at the counter instead of the chain: did they take
     it back and hand the money over? Being sorry it was no good, offering to look
     at it, or promising to sort it out later all count as no. */
  async function confirmRefund(npc, id, price, spoken, translation) {
    try {
      const yes = await LG.llm.confirmTrade(LG.game.llmConfig(), spoken, translation, {
        npcName: npc.def.name,
        wants: LG.ITEMS[id].full,
        gives: 'the ' + price + (price === 1 ? ' coin' : ' coins') + ' they paid for it, back'
      });
      if (yes && LG.game.commerce(npc, 'buy', id, price)) renderItems();
    } catch (e) { /* no refund on a failed check */ }
  }

  /* The player held out exactly the right thing and the villager did not flag a
     trade. Either they declined, or they agreed and dropped the field — ask a
     reader which it was. */
  async function confirmOffer(npc, trade, spoken, translation) {
    try {
      const yes = await LG.llm.confirmTrade(LG.game.llmConfig(), spoken, translation, {
        npcName: npc.def.name,
        wants: trade.wantsCount > 1 ? trade.wantsCount + ' coins' : LG.ITEMS[trade.wants].full,
        gives: trade.givesCount > 1 ? trade.givesCount + ' coins' : LG.ITEMS[trade.gives].full
      });
      if (!yes || npc.tradeDone) return;
      if (LG.game.count(trade.wants) < (trade.wantsCount || 1)) return;
      LG.game.doTrade(npc, trade);
      renderItems();
    } catch (e) { /* no deal */ }
  }

  /* The villager forgot the furigana (or mangled it). Ask the small model for
     just that, check it strips back to the same sentence, and slot it into the
     line already on screen. */
  async function repairFurigana(npc, spoken, row) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got = null;
      try { got = await LG.llm.furigana(LG.game.llmConfig(), spoken, attempt); }
      catch (e) { got = null; }
      last = got;
      const ok = usableRuby(got, spoken);
      if (ok) {
        const turn = npc.history[npc.history.length - 1];
        if (turn && turn.say === spoken) turn.ruby = ok;
        if (row && row._main) {
          row._main.innerHTML = rubyHTML(ok);
          row._main.classList.add('has-ruby');
        }
        return true;
      }
    }
    // Nothing usable. Say so rather than leaving the player wondering.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[furigana] gave up on this line.\n  said:     ' + spoken +
                   '\n  returned: ' + last);
    }
    status('No furigana for that line — ' + (last ? 'the reading did not match.' : 'the request failed.'), 'miss');
    return false;
  }

  async function verifyRevealed(npc, reply, spoken, ruby) {
    const plan = LG.game.plan;
    const claimed = reply.revealed
      .map(id => String(id).replace(/[^\w]/g, ''))
      .filter(id => plan.facts[id] && npc.facts.indexOf(id) !== -1 && !LG.game.hasNote(id));
    if (!claimed.length) return;
    const candidates = claimed.map(id => ({ id, text: plan.facts[id].text }));
    const L = LG.LANGUAGES[LG.game.settings.lang];
    try {
      const confirmed = await LG.llm.judge(LG.game.llmConfig(), spoken, reply.translation, candidates,
                                           { langName: L.name, furigana: !!L.furigana, diacritics: !!L.diacritics });
      confirmed.forEach(c => {
        // fall back to the line as spoken, so a note is never in the wrong language
        const note = c.note || spoken;
        const nRuby = usableRuby(c.ruby, c.note) || (c.note ? null : ruby);
        LG.game.learn(c.id, npc, note, nRuby);
      });
    } catch (e) { /* an unwritten note is always better than a wrong one */ }
  }

  /* Villagers passing news to each other, out loud, wherever they are. This runs
     on the small model, so the village talks to itself freely; the queue below
     exists only to stop a dozen simultaneous meetings firing at once, not to
     ration the conversation. */
  const chatQueue = [];
  let chatGap = 0, chatBusy = 0;
  const CHAT_GAP = 1.2, CHAT_PARALLEL = 2, CHAT_STALE = 12;

  /* `ctx` is two LG.view snapshots, {a, b}, taken when they met. */
  function overheard(a, b, ctx) {
    if (chatQueue.length > 8) return;                  // a crowd, not a queue
    if (a.chatting || b.chatting) return;
    a.chatting = b.chatting = true;
    chatQueue.push({ a, b, ctx: ctx || {}, age: 0 });
  }

  function chatTick(dt) {
    chatGap -= dt;
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      chatQueue[i].age += dt;
      if (chatQueue[i].age > CHAT_STALE) {             // they have wandered off
        const q = chatQueue.splice(i, 1)[0];
        q.a.chatting = q.b.chatting = false;
      }
    }
    while (chatQueue.length && chatGap <= 0 && chatBusy < CHAT_PARALLEL) {
      chatGap = CHAT_GAP;
      startChat(chatQueue.shift());
    }
  }

  let turnHold = 2800;                 // how long a line sits before the reply
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* A meeting between two villagers, played out turn by turn. Each line is its
     own call to the small model, given that villager's persona and the
     transcript so far, so they are genuinely answering each other rather than
     performing an exchange one model wrote in advance. */
  async function startChat(job) {
    const a = job.a, b = job.b;
    chatBusy++;
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const turns = 4 + ((Math.random() * 3) | 0);        // 4–6 lines between them
    const transcript = [];
    const ctx = job.ctx || {};
    const view = {};
    if (ctx.a) view[ctx.a.id] = ctx.a;
    if (ctx.b) view[ctx.b.id] = ctx.b;

    try {
      for (let t = 0; t < turns; t++) {
        // the player pulling one of them into a conversation ends this one
        if (a.frozen || b.frozen) break;
        const me = (t % 2 === 0) ? a : b, them = (t % 2 === 0) ? b : a;
        const vMe = view[me.def.id] || {}, vThem = view[them.def.id] || {};
        const turn = await LG.llm.converse(LG.game.llmConfig(), {
          me: vMe,
          them: vThem,
          /* No assignment to deliver. They have what is on their mind and what
             they are like, and whether any of it comes up is the conversation's
             business. Nothing downstream depends on a particular thing being
             said, so nothing has to make them say it. */
          held: LG.view.held(vMe),
          here: vMe.here || '',
          errand: (vMe.errand && vMe.errand.why) || '',
          sought: !!vMe.sought,
          transcript: transcript,
          closing: t === turns - 1,
          when: t === 0 ? LG.time.describe() : '',
          langName: L.name,
          furigana: !!L.furigana,
          diacritics: !!L.diacritics,
          romanLabel: L.romanize ? L.romanLabel : null,
          register: (LG.LEVELS[s.level] || {}).register || ''
        });
        if (!turn) break;
        if (a.frozen || b.frozen) break;

        const plain = stripRuby(turn.say);
        transcript.push({ who: me.def.name, say: plain });
        me.bubble = plain; me.bubbleT = 5;
        // both of them stay put for as long as the conversation is running
        a.pauseT = Math.max(a.pauseT, 6); a.route = null;
        b.pauseT = Math.max(b.pauseT, 6); b.route = null;

        // Most of this happens where you cannot see it; the console is the only
        // window onto a village that carries on talking behind your back.
        if (LG.game.think) LG.game.think(me, 'says', plain +
          (turn.translation ? '  \u2014 ' + turn.translation : ''));
        if (LG.game.canOverhear(a, b)) {
          const ruby = (L.furigana && plain !== turn.say) ? turn.say : null;
          LG.game.logSpeech(LG.game.displayName(me), plain, ruby, turn.roman, turn.translation);
        }
        await sleep(turnHold);
      }
    } catch (e) { /* a dropped call just ends the conversation early */ }

    chatBusy--;
    a.chatting = b.chatting = false;

    /* What either of them keeps is read off the conversation that happened,
       rather than decided before it started. */
    if (transcript.length >= 2 && ctx.a && ctx.b) remember(a, b, transcript, ctx);
  }

  function remember(a, b, transcript, ctx) {
    /* The reader is a third party working out what these two said to each other,
       so it gets the facts as they are written down rather than in either
       villager's own voice — "Mira thinks Wren talks too much", not "You think". */
    const told = v => (v.knows || []).map(f => ({ id: f.id, text: f.plain }));
    LG.llm.recall(LG.game.llmConfig(), {
      transcript: transcript,
      a: { name: ctx.a.name, facts: told(ctx.a) },
      b: { name: ctx.b.name, facts: told(ctx.b) }
    }).then(res => {
      if (!res) return;
      keep(a, b, res.a, told(ctx.a));
      keep(b, a, res.b, told(ctx.b));
    }).catch(() => {});
  }

  /* `speaker` said things; `listener` is the one who now knows them. */
  function keep(speaker, listener, took, mine) {
    let landed = null;
    (took.remembers || []).slice(0, 4).forEach(m => {
      if (typeof m !== 'string' || m.length < 4) return;
      if (LG.game.remember(speaker, m, listener.def.name)) {
        landed = m;
        if (LG.game.think) LG.game.think(speaker, 'remembers', m);
      }
    });
    /* And the same second thought as after talking to the traveller. Revising
       only what the player tells them would make the player a special kind of
       informant, which they are not — a villager who hears from Olo that the
       shoes turned up has learned the same thing by the same means. */
    if (landed) reviseHeld(speaker, landed);
    // A chain fact travels only if it was genuinely said out loud.
    const ids = mine.map(f => f.id);
    (took.said || []).forEach(tag => {
      const id = String(tag).replace(/[^\w]/g, '');
      if (ids.indexOf(id) === -1) return;              // not theirs to tell
      if (listener.facts.indexOf(id) !== -1) return;   // already knew
      listener.facts.push(id);
      LG.game.noteFactSource(listener, id, speaker.def.name);
      if (LG.game.think) LG.game.think(listener, 'now knows', LG.game.factText(id) || id);
    });
  }

  function init() {
    bind();
    el.dlgSend.onclick = () => send(el.dlgInput.value);
    el.dlgClose.onclick = close;
    el.dlgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(el.dlgInput.value); }
      if (e.key === 'Escape') close();
    });
  }

  return { init, open, close, send, chatterLine, overheard, chatTick,
           set turnHold(ms) { turnHold = ms; },
           _chatReset() {
             while (chatQueue.length) { const q = chatQueue.pop(); q.a.chatting = q.b.chatting = false; }
             chatGap = 0;
           },
           get chatPending() { return chatQueue.length; },
           get chatRunning() { return chatBusy; },
           isOpen: () => !!current, renderItems, addLine, status,
           settled: () => { const all = pending.splice(0); return Promise.all(all); },
           _debugPrompt: systemPrompt, _debugReply: buildReply, _reviseHeld: reviseHeld,
           _rubyHTML: rubyHTML,
           _stripRuby: stripRuby, _rubyMatches: rubyMatches, _needsFurigana: needsFurigana,
           _looksEnglish: looksEnglish,
           rubyHTML: rubyHTML, _usableRuby: usableRuby };
})();
