/* dialogue.js — player/villager conversations: prompt construction, LLM
   calls, trade handling, memory updates, and the conversation UI. */
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

  /* Furigana arrives as HTML markup from the model, so all HTML is
     escaped except the ruby tag family (ruby/rb/rt/rtc/rp), which is let
     back through with attributes stripped. */
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
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
  function rubyHTML(str) {
    return String(str)
      // Keeps only ruby-family tags, stripped down to their bare form
      // (removing attributes but preserving structure); strips everything
      // else that looks like a tag.
      .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash, name) => {
        const n = name.toLowerCase();
        return RUBY_TAG.test(n) ? '<' + slash + n + '>' : '';
      })
      .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
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

  function itemName(id, lang) {
    const it = LG.ITEMS[id];
    return (it && (it[lang] || it.en)) || id;
  }

  /* -------------------------------------------------------- prompt build */
  /* Builds both the prompt text and its JSON schema together, from one
     shared field list (see `fields` below), so they can't drift apart.
     `systemPrompt` below is a string-only wrapper around this, used by
     tests and the prompt dump. */
  function buildReply(npc, offered) {
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const lvl = LG.LEVELS[s.level];
    /* Uses the same villager-assembly function that also drives where
       they walk and what they say to other villagers — see view.js for
       why this used to be three separate, drifting implementations. */
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
    /* In a village this size, everyone knows everyone else by name and
       trade — that's background knowledge, not something anyone had to
       be told, and it's separate from the *player* learning a name (see
       `nameKnown` below): a villager mentioning "Tomas" doesn't put
       Tomas's name on screen until Tomas says it himself. Without this
       roster, a villager asked about a neighbor they had no fact-based
       history with had nothing to answer from — see OLD-LI.md for the
       resulting bug (an unreachable NPC nobody could interact with). */
    if (v.roster.length) {
      lines.push('# Everyone else in the village');
      lines.push('You have lived here for years; you know everyone in the village by name and trade, whether or not you have any news of them today:');
      v.roster.forEach(r => lines.push('- ' + r.name + ' — ' + r.job));
      lines.push('');
    }
    /* One combined, dated list of everything the villager knows.

       This used to be two separate sections: "# What you know" held
       chain facts as flat, undated statements to state as they came up;
       "# What you have picked up lately" held everything else, implicitly
       as lesser knowledge. Neither included a date or source.

       That undated structure produced actively wrong behavior: a
       villager could be told, as a bare present-tense fact, that someone
       "is looking for shoes" — even after that errand had already been
       completed — with no way to notice the contradiction against a
       newer memory of the shoes being delivered, because the two claims
       weren't comparable (no dates, and one read as "knowledge" while
       the other read as "gossip").

       So instead: one list, each entry dated and sourced. Older and newer
       entries are both shown as what they are, with no explicit rule
       saying newer overrides older — a model playing a person with a
       dated pair of claims can reason about which is current on its own,
       the same way a person would. */
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
    /* This instruction previously offered only two simplification levers
       (easier words, shorter sentences) while forbidding a third
       (breaking grammar) — correct to forbid, but incomplete: when a
       thought's only natural phrasing needs grammar the beginner
       traveller has no chance of following, both permitted levers fail.
       E.g. a beginner-level Mandarin villager asking for a pet back used
       correct but far-too-advanced constructions (把…带回来, 谁…就谁) because
       nothing told it there was a third option: rephrasing the thought
       itself into something simpler to say, rather than translating a
       fixed idea into harder grammar. */
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
      /* Items just bought from the traveller need to be listed explicitly
         as current stock — without this, a villager who'd just bought an
         apple had no way to know they now had one, and would (truthfully,
         from their own state) keep saying they had none. */
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
      /* Previously this instruction unconditionally said "that is them
         paying you," with no check for whether a sale was actually
         outstanding. That let a villager who'd already been paid (and
         whose own till record showed it) hand over a second item when
         the player held out coins again for an unrelated reason — the
         rule as written told them to treat any offered coins as payment
         for something. */
      lines.push('If the traveller holds out their coins, that is them paying you for something you have not handed over yet — take the money and hand the goods over in the same breath. Something the record already shows you were paid for is not being bought a second time.');
      lines.push('Two things at once is still one sale: put both tags in "item" and the total in "price". Only list what you are actually handing over this turn.');
    } else if (v.trade.sells.length) {
      /* Villagers need to be told explicitly when their trade is
         closed (nighttime only) — without it, a villager would agree to
         sell at midnight, but the game would silently refuse to process
         the sale, with no explanation given to either party.

         States only the fact of being closed, nothing more. An earlier
         version spelled out three separate prohibitions (don't offer,
         don't name a price, don't take money) plus an assigned feeling
         about it ("you'd like the custom") — over-specifying what should
         just follow from the villager's own character and the one fact
         that matters: they're shut. */
      lines.push('');
      lines.push('# Your trade');
      lines.push('It is the middle of the night. Your trade is shut until morning.');
    }

    {
      /* The till: a ground-truth record of what actually changed hands,
         separate from conversational memory. A villager reading this can
         work out on their own that they were paid for two drinks but only
         handed over one, the way a real shopkeeper would notice, without
         needing an explicit rule for it. Placed outside the trade-open
         block above deliberately — a villager needs to see a failed sale
         in the till whether or not their shop happens to be open. */
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
        /* Must include the count. When this line named the item without
           a count, a villager who'd sold the same traveller two of an
           item (with the till above correctly showing two sales) would
           reason from a summary that implied only one, missing that they
           held that quantity and reasoning incorrectly about what they
           had access to. */
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
    /* A completed deal must be stated explicitly. It used to simply
       disappear from the prompt the instant it completed, leaving no
       sign it had ever happened — so the villager kept trying to
       complete it again, and the schema turned each retry into another
       transaction. Omission doesn't communicate "this is done." */
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
    /* Furigana gets its own section with a fully worked example
       sentence, rather than living inside the "say" field's description
       in the JSON schema (its previous location) — nested inside a JSON
       string inside a schema, that example was easy to skim past and
       easy for a model to reproduce incorrectly. A worked example outside
       the schema specifies the format far more reliably than a rule. */
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

    /* Single source of truth for the reply's fields, used to render
       three things: the field list the villager reads, the "always
       present" sentence below, and (where the provider supports it) the
       JSON Schema that enforces this instead of leaving it to model
       judgment. Deriving all three from one array means a field can't be
       described in the prompt but missing from the schema, or typed one
       way and documented another. Which fields exist is decided once,
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
    /* Previously worded as "OPTIONAL: ... a NEW fact you just learned
       from the traveller. Omit this unless you understood them" — which
       made "did I understand them" the only gate, so a villager who
       perfectly understood a plain greeting was implicitly told a new
       fact must exist to report. This produced fabricated facts: one
       villager, given only "こんにちは！" ("hello"), invented and recorded a
       name the traveller never stated. Reworded to ask what's actually
       worth keeping (matching the villager-to-villager call), with
       "nothing worth keeping" as its own explicit, valid answer (null)
       rather than something achieved by omission. */
    fields.push({ k: 'remember', type: { type: ['string', 'null'] },
      desc: 'anything the traveller has said that is worth remembering, as one short English sentence — null if nothing was' });
    if (working) {
      /* commerce() accepts either a single tag or a list, but the
         schema only asks for the list form — one shape to validate
         rather than two to allow. */
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
    /* States explicitly which fields are never omitted. Every field but
       "say" used to carry a hedge (OPTIONAL, only with sell or buy, [] if
       none, when in doubt leave it out) with nothing stating any field
       was actually mandatory, so the whole object read as mostly
       optional. On a turn with nothing extra to report, models predictably
       dropped everything but "say": in one logged session, roughly a
       third of player-facing replies came back as a bare {"say": …} — all
       of them turns where "revealed" should have been [] and "action"
       "none", i.e. cases the fields already had a correct empty value
       for, if only they'd been included. The villager-to-villager prompt,
       whose fields carry no hedges, had no such failures in the same
       session — pointing at this schema's phrasing as the cause. Fix:
       name which fields are always present, and give "nothing happened"
       its own explicit value rather than expressing it via absence. */
    const always = fields.filter(f => f.always).map(f => '"' + f.k + '"');
    lines.push('Every reply carries ' + always.slice(0, -1).join(', ') + ' and ' +
               always[always.length - 1] + '. A one-word answer, a greeting, or ' +
               'explaining what a word means carries them just the same as a long ' +
               'reply — there is no short form of this object.');
    lines.push('Where nothing happened, say so in the field rather than dropping it: ' +
               '"revealed" is [], "remember" is null, "action" is "none".' +
               (working ? ' Only "item" and "price" are ever absent.'
                        : ' No field is ever absent.'));
    /* A worked example reinforces the rule above (fields are never
       dropped) more reliably than the rule stated alone — the furigana
       spec was moved out of the schema for the same reason. This example
       is specifically a turn with nothing to report, still carrying
       every field — the exact case that used to come back bare. */
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
    /* Every field is marked JSON-Schema `required`, with the truly
       optional ones typed nullable instead of just omitted from
       `required` — the one shape both providers accept, and it matches
       what the prompt itself says: nothing is ever omitted, and "nothing
       to report" is spelled out as null, [], or "none". */
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
  function open(npc) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    current = npc;
    npc.frozen = true;
    npc.metPlayer = true;
    el.dlg.classList.add('open');
    /* Tags the input box's lang as the village's language — this is
       what an IME uses to pick its input mode, and it's what stops the
       browser's English spellchecker from underlining every correctly-
       spelled non-English word. */
    el.dlgInput.lang = L.tag;
    // Shows '?' rather than a role-repeating placeholder for an unknown
    // name — the job title is already shown right below, so repeating it
    // ("the village baker" over "the village baker") would read as a
    // display glitch rather than as "name unknown". Matches the '?'
    // convention used by the nametag above the villager's head.
    el.dlgName.textContent = npc.nameKnown ? npc.def.name : '?';
    el.dlgRole.textContent = npc.def.job;
    el.dlgAvatar.textContent = npc.def.emoji;
    el.dlgAvatar.style.background = npc.def.color;
    el.dlgLog.innerHTML = '';
    renderPhrases();
    renderItems();
    if (npc.history.length) {
      npc.history.slice(-4).forEach(h => {
        if (h.player) addLine('player', h.player);
        addLine('npc', h.say, h.translation, h.roman,
                rubyMatches(h.ruby, h.say) ? h.ruby : null, npc);
      });
    } else {
      status('Say hello — or click a phrase below.');
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
    /* Each of the three lines in this bubble is tagged individually
       (not the bubble as a whole), since they're in three different
       registers: the spoken line is the village's language, the
       romanization is that language in Latin letters, the gloss is
       English. Applies to both speakers (the player also types in the
       village's language), though only the villager's line gets the
       language's own font. */
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
    // Both gloss lines are created upfront (even if empty) so a
    // later async repair (see repairGloss) has an element to fill in.
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
      // The icon is an emoji and the tooltip is English — only the item name is tagged as the village's language.
      b.innerHTML = LG.ITEMS[k].icon + ' <span lang="' + LG.LANGUAGES[s.lang].tag + '">' +
        itemName(k, s.lang) + (inv[k] > 1 ? ' ×' + inv[k] : '') + '</span>';
      b.title = 'Offer your ' + LG.ITEMS[k].en;
      b.onclick = () => send('', k);
      el.dlgItems.appendChild(b);
    });
  }

  /* -------------------------------------------------------- the exchange */
  async function send(text, offered) {
    if (!current || busy) return;
    text = (text || '').trim();
    if (!text && !offered) return;
    const npc = current;
    busy = true;
    el.dlgSend.disabled = true;

    const shown = offered
      ? (text ? text + '  ' : '') + '[holds out the ' + LG.ITEMS[offered].en + ']'
      : text;
    addLine('player', shown);
    el.dlgInput.value = '';
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
      status('⚠ ' + LG.game.displayName(npc) + ' said something the game could not read. Try again.', 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    // For a furigana language, the villager annotates readings inline
    // as part of "say" — the spoken text itself is whatever remains once
    // the readings are stripped back out.
    const L = LG.LANGUAGES[LG.game.settings.lang];
    let spoken = reply.say, ruby = null;
    if (L.furigana) {
      const written = normaliseFurigana(reply.say);
      const bare = stripRuby(written);
      if (bare !== written) { ruby = written; spoken = bare; }       // annotated in one pass
      else if (reply.ruby) ruby = usableRuby(reply.ruby, reply.say); // separate field, still honoured
    }

    const turn = { player: shown, say: spoken, translation: reply.translation,
                   roman: reply.roman, ruby: ruby };
    npc.turns = (npc.turns || 0) + 1;       // history is trimmed; this only ever goes up
    npc.history.push(turn);
    if (npc.history.length > 20) npc.history.shift();
    const gotIt = String(reply.understood || 'full').toLowerCase() !== 'none';

    /* Name-known detection — see LG.game.displayName. Deliberately not
       a schema field: it would be one more field a model could hedge on
       and drop (the same failure mode the "always-fields" fix above
       addressed), for something that can be checked for free against a
       field that already exists. `reply.translation` is guaranteed to be
       English or blanked further down, so a villager stating their own
       name will appear here in Latin letters regardless of what language
       the village speaks. Checked against `reply.translation` before
       that blanking happens, not `turn.translation` (blanked) afterward. */
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
        /* The new memory may supersede something already held — only
           checked (reviseHeld) when something new was actually recorded,
           so a turn that taught the villager nothing costs nothing. */
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
      // Don't show the player a "translation" that's actually still in the language they're learning.
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

    /* Shopkeeping: the villager's reply claims a sale happened; the
       game verifies and applies it, or reports why not. This check used
       to be skipped entirely outside working hours, so a midnight sale
       was neither completed nor refused — the villager narrated handing
       over tea, and nothing in the game state ever contradicted it. */
    const act = gotIt ? String(reply.action || '').toLowerCase() : '';
    if (act === 'sell' || act === 'buy') {
      if (LG.game.commerce(npc, act, reply.item, reply.price)) renderItems();
      else status('That sale could not be squared up.', 'miss');
    }

    /* A refund request is also communicated as a gesture: holding out
       an item the villager previously sold to the player. The model
       typically narrates agreeing to it in words but leaves "action" as
       "none" — the same failure mode confirmOffer exists for on the
       selling side. Without this check, a villager could narrate taking
       an item back and refunding coins while "action":"none" left the
       actual game state unchanged — the player kept the item and got
       nothing, while the villager believed the refund had happened. */
    const held = (npc.sold || {})[offered];
    if (act !== 'buy' && offered && held && held.n > 0) {
      pending.push(confirmRefund(npc, offered, held.price, spoken, reply.translation));
    }

    // A trade completes only because the villager's reply agreed to
    // it, never just because an item was held out at them. If they agree
    // in words but the model forgets to set the field, a second check
    // catches that — see confirmOffer.
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

  /* The in-character model self-reports which facts it thinks it
     revealed; a second, cheaper model call verifies those against what
     was actually said before anything gets written to the notebook.
     Kicked off after the reply is already displayed, so the player isn't
     blocked waiting on it. */
  const pending = [];

  /* Fills in a missing translation or romanization via the helper model,
     rather than leaving the player with a bare, ungloseed sentence. */
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

  /* After learning something new, checks whether it supersedes an
     existing belief and rewrites that one line if so. Not a deletion:
     e.g. "X is looking for shoes" becomes "X was looking for shoes, and
     has them now" — still true, and still worth being able to say, so
     the village can confirm an errand happened rather than just going
     silent about it.

     A chain fact keeps its id and gets an added villager-specific
     wording (factNote); the notebook is built on those ids, which never
     change. An untagged memory entry is simply rewritten directly. Runs
     after the reply is already displayed; on failure the villager just
     keeps their prior belief. */
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

  /* Same verification approach as verifyRevealed, applied to a refund:
     did the villager actually take the item back and hand the money
     over? Apologizing, offering to look at it, or promising to sort it
     out later all count as "no". */
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

  /* Called when the player held out exactly the right item but the
     villager's reply didn't flag a completed trade — checks whether they
     actually declined, or agreed but the model just omitted the field. */
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

  /* Repairs missing or malformed furigana: asks the helper model for
     just the annotation, verifies it strips back to the same sentence
     already spoken, and updates the line already on screen. */
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

  /* Villager-to-villager conversations, triggered wherever two meet.
     Runs on the cheap helper model, so the village can talk to itself
     freely; the queue below exists only to cap concurrent conversations,
     not to ration how much talking happens overall. */
  const chatQueue = [];
  let chatGap = 0, chatBusy = 0;
  const CHAT_GAP = 1.2, CHAT_PARALLEL = 2, CHAT_STALE = 12;

  /* `ctx` is two LG.view snapshots, {a, b}, taken at the moment they met. */
  function overheard(a, b, ctx) {
    if (chatQueue.length > 8) return;                  // queue full — drop the request
    if (a.chatting || b.chatting) return;
    a.chatting = b.chatting = true;
    chatQueue.push({ a, b, ctx: ctx || {}, age: 0 });
  }

  function chatTick(dt) {
    chatGap -= dt;
    for (let i = chatQueue.length - 1; i >= 0; i--) {
      chatQueue[i].age += dt;
      if (chatQueue[i].age > CHAT_STALE) {             // one of them has since wandered off — drop it
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

  /* Runs a meeting between two villagers, turn by turn. Each line is a
     separate helper-model call given that villager's persona and the
     transcript so far, so the two are genuinely responding to each other
     rather than one model authoring a pre-planned exchange for both. */
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
        // If the player pulls either villager into a conversation, end this one.
        if (a.frozen || b.frozen) break;
        const me = (t % 2 === 0) ? a : b, them = (t % 2 === 0) ? b : a;
        const vMe = view[me.def.id] || {}, vThem = view[them.def.id] || {};
        const turn = await LG.llm.converse(LG.game.llmConfig(), {
          me: vMe,
          them: vThem,
          /* No topic is assigned — the villager just has what's on
             their mind and their own personality, and whether either
             comes up is left to the conversation itself. Nothing
             downstream depends on any particular thing being said. */
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
        // Both villagers stay put for the duration of the conversation.
        a.pauseT = Math.max(a.pauseT, 6); a.route = null;
        b.pauseT = Math.max(b.pauseT, 6); b.route = null;

        // Most of this happens off-screen; the console is the only way
        // to observe villager-to-villager conversation the player didn't witness.
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

    /* What each villager takes away is determined from the
       conversation that actually happened, not decided in advance. */
    if (transcript.length >= 2 && ctx.a && ctx.b) remember(a, b, transcript, ctx);
  }

  function remember(a, b, transcript, ctx) {
    /* This call reasons about the conversation from a third-party
       perspective, so it's given facts in their written (third-person)
       form rather than either villager's own voice — "X thinks Y talks
       too much," never "You think...". */
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

  /* `speaker` is the one who said things; `listener` is who now knows them. */
  function keep(speaker, listener, took, mine) {
    let landed = null;
    (took.remembers || []).slice(0, 4).forEach(m => {
      if (typeof m !== 'string' || m.length < 4) return;
      if (LG.game.remember(speaker, m, listener.def.name)) {
        landed = m;
        if (LG.game.think) LG.game.think(speaker, 'remembers', m);
      }
    });
    /* Applies the same reviseHeld() check used for player conversations
       — restricting revision to only player-sourced info would make the
       player a privileged source, which they aren't; hearing something
       from another villager is exactly as valid a way to learn it. */
    if (landed) reviseHeld(speaker, landed);
    // A chain fact only spreads to the listener if it was actually said out loud.
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
