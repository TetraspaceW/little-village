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

  /* Furigana arrives as HTML from the model: everything is escaped but the
     ruby tags (ruby/rb/rt/rtc/rp), let back through without attributes. */
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const KANJI_G = new RegExp(KANJI.source, 'g');  // same ranges, for counting rather than testing
  const RUBY_TAG = /^(?:ruby|rb|rt|rtc|rp)$/;

  // Ruby markup back to plain text, permissively; only for rubyMatches, never rendered.
  function stripRuby(html) {
    return String(html)
      .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<rtc\b[^>]*>[\s\S]*?<\/rtc>/gi, '')
      .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
      .replace(/<\/?(?:ruby|rb|rt|rtc|rp)\b[^>]*>/gi, '');
  }
  /* For comparison: loose about width and spacing, strict enough that the
     player is never shown words the villager didn't say. */
  function normText(str) {
    let t = String(str);
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.replace(/\s/g, '');
  }
  function rubyMatches(ruby, say) {
    if (!ruby) return false;
    return normText(stripRuby(ruby)) === normText(say);
  }

  /* A reply may come fenced or quoted: the first unwrapping that strips
     back to the line as said, or null. Nothing unchecked is accepted. */
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
  /* Bracket-style furigana (糸[いと]), a common plain-text convention, is
     converted to ruby rather than fought. Only a run of kanji followed by a
     bracket of pure kana; other brackets are left alone. */
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
      /* The brackets read the whole word, okurigana included (結ぶ[むすぶ]);
         ruby goes on the kanji alone (結 as むす, ぶ bare). If the reading
         doesn't end with the okurigana, the whole word is wrapped instead. */
      if (okuri && reading.length > okuri.length &&
          reading.slice(-okuri.length) === okuri) {
        return '<ruby>' + kanji + '<rt>' + reading.slice(0, -okuri.length) + '</rt></ruby>' + okuri;
      }
      return '<ruby>' + kanji + okuri + '<rt>' + reading + '</rt></ruby>';
    });
  }

  function needsFurigana(say) { return KANJI.test(String(say)); }

  /* Whether a "translation" is English. One in hanzi, kana or Cyrillic is
     treated as missing and fetched separately. */
  const NOT_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/;
  function looksEnglish(str) {
    const t = String(str || '').trim();
    if (!t) return false;
    if (NOT_LATIN.test(t)) return false;
    return /[a-z]{2}/i.test(t);
  }

  /* Pinyin with the wrong number of syllables for its hanzi: a dropped or
     run-together syllable, which looksEnglish can't see. Syllables are runs
     of vowels once tone marks are gone, so joined words (xièxie) count
     right; erhua (一点儿, yìdiǎnr) is allowed for. Off by more than one
     gets a repair call; the odd needless one costs less than a wrong line
     on screen. Mirrors tools/format-stats.js. Chinese only (L.romanize). */
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
    return String(str)
      // Ruby-family tags survive, bare; anything else that looks like a tag goes.
      .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash, name) => {
        const n = name.toLowerCase();
        return RUBY_TAG.test(n) ? '<' + slash + n + '>' : '';
      })
      .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/&lt;(\/?)(ruby|rb|rt|rtc|rp)&gt;/g, '<$1$2>')
      .replace(/<ruby>([\s\S]*?)<\/ruby>/g, dropKanaRuby);
  }

  // Readings over kana are dropped: kana already shows how it's said.
  function dropKanaRuby(match, inner) {
    const base = String(inner)
      .replace(/<rt>[\s\S]*?<\/rt>/g, '')
      .replace(/<rp>[\s\S]*?<\/rp>/g, '')
      .replace(/<rtc>[\s\S]*?<\/rtc>/g, '')
      .replace(/<\/?(?:rb|rt|rtc|rp)>/g, '');
    return KANJI.test(base) ? match : base;
  }

  function itemName(id, lang) { return LG.itemName(id, lang); }

  /* -------------------------------------------------------- prompt build */
  /* The villager's system prompt and its reply schema, built together from
     one field list (`fields`) so they can't drift apart. */
  function buildReply(npc, offered) {
    const s = LG.game.settings;
    const L = LG.LANGUAGES[s.lang];
    const lvl = LG.LEVELS[s.level];
    // The same view of them as the movement and chatter prompts (view.js).
    const v = LG.view.of(npc, 'player');
    const inv = LG.game.inventoryList(v.companion && v.companion.item);
    const trade = v.trade.deal;
    // Needed by both halves: the trade section changes turn to turn, the reply format's fields don't.
    const working = v.trade.open && v.trade.sells.length;

    /* `stable` is what stays byte-identical through a conversation
       (character, roster, language rules, reply format), `volatile` what
       live state changes turn to turn (clock, what they know, inventory,
       trade, till). Caching matches a prefix, so the stable part goes first
       and a breakpoint goes at the seam (see systemParts in llm.js). */
    const stable = [], volatile = [];
    // A blank line between sections, never two in a row.
    const sep = arr => { if (arr.length && arr[arr.length - 1] !== '') arr.push(''); };
    const coins = n => n + (n === 1 ? ' coin' : ' coins');

    stable.push('You are ' + v.name + ', who lives in this village and speaks ' + L.name + '.');
    sep(stable);
    stable.push('# Your character');
    stable.push('Name: ' + v.name + ' — ' + v.job + '.');
    stable.push('Personality: ' + v.persona);
    stable.push('Your current concern: ' + v.goal);
    /* Everyone knows everyone here by name, trade and character. That's
       background, not news, and separate from the player learning a name.
       Without it a villager asked about a neighbour invented one (OLD-LI.md).
       What a neighbour is doing today still has to reach them as news. */
    if (v.roster.length) {
      sep(stable);
      stable.push('# Everyone else in the village');
      stable.push('You have lived here for years; you know everyone in the village, whether or not you have any news of them today:');
      v.roster.forEach(r => stable.push('- ' + r.name + ' — ' + r.job + '. ' + r.persona));
    }
    /* Everything they know, in one list, each line dated and sourced, with
       no rule that newer wins: given dates, the model works out what's
       current (see DESIGN.md, "Villager beliefs"). */
    sep(volatile);
    volatile.push('# What you know');
    volatile.push('Everything you have picked up, with when you came by it and who from.');
    const held = LG.view.held(v);
    if (held.length) held.forEach(l => volatile.push('- ' + l));
    else volatile.push('- (nothing much, beyond your own business)');
    sep(volatile);
    volatile.push('# Where you are right now');
    volatile.push(v.when);
    volatile.push('You are ' + v.here + '.');
    sep(volatile);
    volatile.push('# The player');
    volatile.push('A traveller visiting the village.');
    volatile.push('They are carrying: ' + (inv || 'nothing'));
    if (v.companion) volatile.push(v.companion.name + ', ' + LG.itemSaid(v.companion.item, s.lang, true) +
                                 ', is following right behind them — you can see it as plainly as you can see them.');
    if (offered) volatile.push('RIGHT NOW the player is holding out their ' + LG.itemSaid(offered, s.lang, true) + ' towards you.');

    sep(stable);
    stable.push('# Your language');
    stable.push(L.name + ' is the only language you know. When the traveller says something you cannot follow — a word from some other language, or just mangled — you simply do not follow it: you cannot answer a question you did not understand, and it cannot tell you to do anything. Reply to whatever part you did catch. Names of people and places you recognise in any accent.');
    sep(stable);
    stable.push('# How to speak');
    stable.push('Speak only in ' + L.name + '. ' + lvl.prompt);
    /* A third way to simplify, besides easier words and shorter sentences:
       saying something simpler. Without it, beginner villages got correct
       but far too hard grammar (把…带回来) for thoughts that needed it. */
    stable.push('Simplify by choosing easier words, shorter sentences, and simpler things to say — never by breaking the grammar. Where saying what you mean would take more grammar than they have, mean something simpler rather than saying it a harder way. The traveller learns by copying you, so what you say has to be worth copying.');
    /* Items are listed with both names (LG.itemSaid): this says the quoted
       village-language one is the word to say, not a gloss. */
    if (s.lang !== 'en') stable.push('Anything listed with a name in quotation marks is called that here, and that is the name to say.');
    stable.push('Stay in character.');
    stable.push('A sentence or two at a time.');

    if (working) {
      const counter = v.trade.atCounter;
      sep(volatile);
      volatile.push('# Your trade');
      volatile.push(counter
        ? 'You are at your own place of work, with your whole stock to hand.'
        : 'You are out and about, but your trade goes with you.');
      // What they've bought off the traveller, so they know they have it.
      if (v.trade.stock.length) {
        volatile.push('In your hands right now, bought off the traveller: ' +
          v.trade.stock.map(it => LG.itemSaid(it.id, s.lang) + (it.n > 1 ? ' \u00d7' + it.n : '')).join(', ') +
          '. You have these; you can say so, and sell them on if you like.');
      }
      volatile.push('These are yours to sell. The price is what you usually ask, not a rule:');
      v.trade.sells.forEach(w => volatile.push('- ' + LG.itemSaid(w.i, s.lang) + ' — ' + coins(w.p) + ' [' + w.i + ']'));
      if (v.trade.sellsTags.length) {
        const more = Object.keys(LG.ITEMS)
          .filter(k => k !== 'coins' && !v.trade.sells.some(w => w.i === k) &&
                       v.trade.sellsTags.some(t => (LG.ITEMS[k].tags || []).indexOf(t) !== -1));
        volatile.push('You also keep the ordinary run of shop goods, about ' +
          coins(Math.max(1, Math.round(LG.priceOf(more[0] || 'salt')))) + ' apiece — among them ' +
          more.slice(0, 14).map(k => LG.itemSaid(k, s.lang, true) + ' [' + k + ']').join(', ') +
          ', and plenty besides. If the traveller asks for something a village shop would stock, you have it.');
      }
      if (v.trade.buys.length) {
        volatile.push('You would also buy, if the traveller happens to have one:');
        v.trade.buys.forEach(w => volatile.push('- ' + LG.itemSaid(w.i, s.lang) + ' — you would pay about ' +
          coins(w.p) + ' [' + w.i + ']'));
      }
      volatile.push('The traveller has ' + coins(LG.game.count('coins')) + ' on them.');

      volatile.push('Offer your goods the way you would to any customer, and haggle if it suits you.');
      // Coins pay for what hasn't been handed over yet; the till says what has.
      volatile.push('If the traveller holds out their coins, that is them paying you for something you have not handed over yet — take the money and hand the goods over in the same breath. Something the record already shows you were paid for is not being bought a second time.');
      volatile.push('Two things at once is still one sale: put both tags in "item" and the total in "price". Only list what you are actually handing over this turn.');
    } else if (v.trade.sells.length) {
      /* Shut at night, and told so, or they agree to sales the till then
         refuses. Just the fact: how they feel about it is theirs. */
      sep(volatile);
      volatile.push('# Your trade');
      volatile.push('It is the middle of the night. Your trade is shut until morning.');
    }

    {
      /* The till: what actually changed hands, apart from memory, so a
         villager can work out for themselves that they were paid for two
         and handed over one. Shown whether or not the shop is open, since a
         refused sale belongs in it too. */
      const till = v.trade.till;
      if (till.length) {
        sep(volatile);
        volatile.push('# The till');
        volatile.push('What has actually changed hands between you and this traveller:');
        till.forEach(t => {
          if (t.failed) { volatile.push('- (nothing happened: ' + t.note + ')'); return; }
          const line = t.act === 'sell'
            ? 'you handed over ' + t.names + ' and took ' + coins(t.coins)
            : t.refund ? 'they gave back ' + t.names + ' and you refunded ' + coins(t.coins)
                       : 'you took ' + t.names + ' off them for ' + coins(t.coins);
          volatile.push('- ' + t.at + ' \u2014 ' + line +
            (t.asked !== t.coins ? ' (you said ' + t.asked + ', the till took ' + t.coins + ')' : ''));
        });
        // With counts: without them, two sold read as one.
        if (v.trade.sold.length) volatile.push('Still in their hands, from you: ' +
          v.trade.sold.map(it => { const nm = LG.itemSaid(it.id, s.lang, true);
                                   return it.n > 1 ? it.n + ' \u00d7 ' + nm : nm; }).join(', ') + '.');
        volatile.push('This is the record. If it does not match what you thought, the record is right.');
      }
    }

    if (trade) {
      sep(volatile);
      volatile.push('# Your deal');
      volatile.push('You want: ' + (trade.wants === 'coins'
        ? coins(trade.wantsCount)
        : LG.itemSaid(trade.wants, s.lang)) + '.');
      volatile.push('You will give in return: ' + (trade.gives === 'coins'
        ? coins(trade.givesCount)
        : LG.itemSaid(trade.gives, s.lang)) + '.');
      volatile.push(trade.hint);
    }
    /* A finished deal is stated as finished; left out, the villager tried
       to complete it again, and each attempt became a real trade. */
    if (v.trade.done) {
      const r = v.trade.done;
      sep(volatile);
      volatile.push('# Your deal');
      volatile.push('Done, earlier today: the traveller gave you ' +
        (r.wants === 'coins' ? coins(r.wantsCount) : LG.itemSaid(r.wants, s.lang)) +
        ' and you handed over ' +
        (r.gives === 'coins' ? coins(r.givesCount) : LG.itemSaid(r.gives, s.lang)) +
        '. That exchange is finished and does not want doing again.');
    }
    // Furigana gets its own section and a worked example (LG.FURIGANA), not a line in a field description.
    if (L.furigana) {
      sep(stable);
      stable.push('# Furigana');
      stable.push('What you say goes in "say" with the readings already in it.');
      stable.push(LG.FURIGANA);
    }
    if (L.diacritics) {
      sep(stable);
      stable.push('# Diacritics');
      stable.push('What you say goes in "say" fully vocalised, tashkeel and all.');
      stable.push(LG.TASHKEEL);
    }
    const acts = ['none'];
    if (trade) acts.push('trade');
    if (working) acts.push('sell', 'buy');

    /* The reply's fields, rendered three ways: the list the villager reads,
       the "always present" sentence, and the JSON Schema where the model
       takes one. Which fields exist is decided here, once. */
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
    /* Anything worth remembering, with null as its own answer. Asked for "a
       new fact, if you understood them", a villager invented the player's
       name from a hello. */
    fields.push({ k: 'remember', type: { type: ['string', 'null'] },
      desc: 'anything the traveller has said that is worth remembering, as one short English sentence — null if nothing was' });
    if (working) {
      // Always a list here; commerce() takes a single tag too.
      fields.push({ k: 'item', type: { type: ['array', 'null'], items: { type: 'string' } },
        desc: 'the [tag] of the goods, or a list of tags if it is more than one thing — only with sell or buy' });
      fields.push({ k: 'price', type: { type: ['number', 'null'] },
        desc: 'the coins agreed for all of it together, as a number — only with sell or buy' });
    }
    fields.push({ k: 'action', type: { type: 'string', enum: acts },
      desc: acts.join(' | ') });

    /* Up to here `stable` doesn't depend on the shop or the deal; the reply
       format below does. A second breakpoint here means a shop opening
       rewrites only the reply format. */
    const coreText = stable.join('\n');
    sep(stable);
    stable.push('# Reply format');
    stable.push('Reply with a single JSON object and nothing else:');
    stable.push('{');
    fields.forEach((f, i) => {
      const val = f.arr ? '["' + f.desc + '"]' : '"' + f.desc + '"';
      stable.push('  "' + f.k + '": ' + val + (i < fields.length - 1 ? ',' : ''));
    });
    stable.push('}');
    /* Which fields are never left out, and "nothing happened" spelled as a
       value. With every field but "say" hedged as optional, a third of
       replies came back as a bare {"say": …}. */
    const always = fields.filter(f => f.always).map(f => '"' + f.k + '"');
    stable.push('Every reply carries ' + always.slice(0, -1).join(', ') + ' and ' +
               always[always.length - 1] + '. A one-word answer, a greeting, or ' +
               'explaining what a word means carries them just the same as a long ' +
               'reply — there is no short form of this object.');
    stable.push('Where nothing happened, say so in the field rather than dropping it: ' +
               '"revealed" is [], "remember" is null, "action" is "none".' +
               (working ? ' Only "item" and "price" are ever absent.'
                        : ' No field is ever absent.'));
    // A worked example of a turn with nothing to report, still carrying every field.
    const shown = { say: '"<your line, in ' + L.name + '>"',
                    translation: '"<the same line, in English>"',
                    roman: '"<the ' + L.romanLabel + '>"',
                    understood: '"full"' };
    const ex = fields.filter(f => f.always).map(f => '"' + f.k + '": ' + shown[f.k]);
    ex.push('"revealed": []', '"remember": null, "action": "none"');
    stable.push('A turn where nothing at all happened — a greeting, a thank-you, ' +
               'telling them what a word means — still looks like this:');
    stable.push('{' + ex.join(', ') + '}');
    stable.push('"translation" and "remember" are notes for the game, not speech — writing English there does not mean you understand any.');
    stable.push('"revealed" is about what you asserted, not what you talked about: using the word, explaining what it means, or asking after it does not count. When in doubt, leave the tag out of the list.');
    stable.push('"remember" is about what they told you — what they want, who they are, what they are carrying, what they are like. Not everything said is worth remembering: a greeting, a thank-you, or a word they were asking after tells you nothing, and that is null. Write down what they said, never what you assumed.');
    if (working) {
      stable.push('Use "sell" at the moment you actually hand goods over and take the money, and "buy" when you take something off the traveller and pay for it — not while the two of you are still discussing it.');
    }
    if (trade) {
      stable.push('Set "action" to "trade" at the moment you actually hand over ' + (trade.gives === 'coins' ? 'the coins' : LG.itemSaid(trade.gives, s.lang)) + ', and not before.');
      stable.push('Someone holding an object out to you is a gesture you understand without words — but a gesture is not yet a bargain. If it is not clear what the two of you are exchanging, ask them before you take it. Once the exchange is plain to you both, take it and hand yours over in the same breath.');
    }
    // Every field required, the optional ones nullable: what the prompt says, and what strict mode wants.
    const props = {}, required = [];
    fields.forEach(f => { props[f.k] = f.type; required.push(f.k); });

    // `core` and `stable` go to llm.js as the cache breakpoints.
    const stableText = stable.join('\n');
    const volatileText = volatile.join('\n');
    return { text: stableText + '\n\n' + volatileText,
             core: coreText, stable: stableText, keys: required,
             schema: { type: 'object', properties: props, required: required,
                       additionalProperties: false } };
  }

  function systemPrompt(npc, offered) { return buildReply(npc, offered).text; }

  /* A past turn as the villager's reply, in this turn's reply format
     (`keys`, from buildReply): every field present, "nothing happened"
     spelled out, and for a furigana language the readings inline in "say".
     Replayed as a bare {"say"}, the history showed the model its own
     replies in exactly the shape the prompt rules out. */
  function pastReply(h, keys) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    const was = {
      say: L.furigana && rubyMatches(h.ruby, h.say) ? h.ruby : h.say,
      translation: h.translation || '',
      roman: h.roman || '',
      understood: h.understood || 'full',
      revealed: h.revealed || [],
      remember: h.remember || null,
      item: h.item || null,
      price: typeof h.price === 'number' ? h.price : null,
      action: h.action || 'none'
    };
    const out = {};
    keys.forEach(k => { out[k] = k in was ? was[k] : null; });
    return out;
  }

  function historyMessages(npc, keys) {
    const msgs = [];
    npc.history.slice(-8).forEach(h => {
      msgs.push({ role: 'user', content: h.player });
      msgs.push({ role: 'assistant', content: JSON.stringify(pastReply(h, keys)) });
    });
    return msgs;
  }

  /* ---------------------------------------------------------------- UI */
  /* `why` is a string (possibly empty) when the villager came looking for
     the player, and then they speak first; undefined otherwise. */
  function open(npc, why) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    current = npc;
    npc.frozen = true;
    npc.metPlayer = true;
    el.dlg.classList.add('open');
    // The input is tagged with the village's language: it picks the IME's mode and quiets the English spellchecker.
    el.dlgInput.lang = L.tag;
    // '?' for an unknown name, as on the nametag: the job is already on the line below.
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
      status(LG.touch.on ? 'Say hello — or tap a phrase below.'
                         : 'Say hello — or click a phrase below.');
    }
    if (typeof why === 'string') {
      send('', null, '[You went looking for the traveller and have just found them.' +
        (why ? ' What brought you: ' + why + '.' : '') +
        ' Say your opening line.]');
    }
    // Not focused on touch: the keyboard would cover the card before anything's read.
    if (!LG.touch.on) setTimeout(() => el.dlgInput.focus(), 60);
  }

  function close() {
    LG.tts.stop();
    try { document.body.classList.remove('typing'); } catch (e) {}   // clear typing state since the input is now hidden
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
    /* Each line is tagged with its own language: the village's, its
       romanisation, and English. Only a villager's line gets the
       language's font. */
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
    // Both gloss lines exist even when empty, for repairGloss to fill in later.
    const r = document.createElement('div');
    r.className = 'roman';
    r.lang = L.romanTag;
    r.textContent = roman || '';
    r.style.display = roman ? '' : 'none';
    bub.appendChild(r);

    const tr = document.createElement('div');
    tr.className = 'trans hidden-tr';
    tr.lang = 'en';
    tr.textContent = translation || '';
    tr.title = 'click to reveal';
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
      /* On touch, focusing would raise the keyboard over the card when
         the player most likely just wants to send the phrase as is. */
      b.onclick = () => { el.dlgInput.value = p[s.lang] || p.en; if (!LG.touch.on) el.dlgInput.focus(); };
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
  /* `prompt` is a stage direction instead of the player's words, for a
     villager who came looking for them and speaks first. It's recorded as
     the turn's line but never shown (`silent`). */
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

    /* By the time the reply lands the player may have walked off, or be
       talking to someone else; the turn is recorded either way. */
    const here = () => current === npc;
    const say = (msg, kind) => { if (here()) status(msg, kind); };

    let reply;
    try {
      const cfg = LG.game.llmConfig();
      const built = buildReply(npc, offered);
      const msgs = historyMessages(npc, built.keys);
      msgs.push({ role: 'user', content: shown || '[says nothing, just holds out the item]' });
      // A session per villager, since each has their own cached prefix.
      reply = await LG.llm.speak(cfg, built.text, msgs, built.schema,
                                 { who: npc.def.name, cachePrefixes: [built.core, built.stable], session: 'npc-' + npc.id });
    } catch (err) {
      say('⚠ ' + err.message, 'error');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    if (!reply || !reply.say) {
      if (!prompt) say('⚠ ' + LG.game.displayName(npc) + ' said something the game could not read. Try again.', 'error');
      else say(LG.touch.on ? 'Say hello — or tap a phrase below.' : 'Say hello — or click a phrase below.');
      busy = false; el.dlgSend.disabled = false;
      return;
    }

    // Readings come inline in "say"; what was spoken is what's left without them.
    const L = LG.LANGUAGES[LG.game.settings.lang];
    let spoken = reply.say, ruby = null;
    if (L.furigana) {
      const written = normaliseFurigana(reply.say);
      const bare = stripRuby(written);
      if (bare !== written) { ruby = written; spoken = bare; }       // annotated in one pass
      else if (reply.ruby) ruby = usableRuby(reply.ruby, reply.say); // separate field, still honoured
    }

    // What the reply said besides the line itself, so history can replay it whole (see pastReply).
    const price = reply.price != null && reply.price !== '' ? Number(reply.price) : null;
    const turn = { player: shown, silent: !!prompt, say: spoken, translation: reply.translation,
                   roman: reply.roman, ruby: ruby,
                   understood: String(reply.understood || 'full').toLowerCase(),
                   revealed: Array.isArray(reply.revealed) ? reply.revealed.map(String) : [],
                   remember: typeof reply.remember === 'string' && reply.remember.trim() ? reply.remember : null,
                   action: String(reply.action || 'none').toLowerCase(),
                   item: Array.isArray(reply.item) ? reply.item.map(String) : reply.item ? [String(reply.item)] : null,
                   price: isFinite(price) ? price : null };
    npc.turns = (npc.turns || 0) + 1;       // history is trimmed; this only ever goes up
    npc.history.push(turn);
    if (npc.history.length > 20) npc.history.shift();
    const gotIt = String(reply.understood || 'full').toLowerCase() !== 'none';

    /* Whether they just told the player their name (LG.game.displayName):
       checked against the English translation, before it's blanked below,
       rather than asked for in a field a model could leave out. */
    if (gotIt && !npc.nameKnown && looksEnglish(reply.translation) &&
        new RegExp('\\b' + npc.def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
          .test(reply.translation)) {
      npc.nameKnown = true;
      if (here()) el.dlgName.textContent = npc.def.name;
      LG.game.log('You learn their name — ' + npc.def.name + '.');
    }

    if (gotIt && Array.isArray(reply.revealed) && reply.revealed.length) {
      pending.push(verifyRevealed(npc, reply, spoken, ruby));   // deliberately not awaited
    }
    if (gotIt && reply.remember && typeof reply.remember === 'string' && reply.remember.length > 3) {
      if (LG.game.remember(npc, reply.remember, 'the traveller')) {
        LG.game.log(LG.game.displayName(npc) + ' will remember: "' + reply.remember + '"');
        // Something new may overtake something they held; only checked when something was recorded.
        pending.push(reviseHeld(npc, reply.remember));
      }
    }

    const row = here() ? addLine('npc', spoken, reply.translation, reply.roman, ruby, npc) : null;
    if (here()) speakLine(npc, spoken);
    if (L.furigana && !ruby && needsFurigana(spoken)) {
      pending.push(repairFurigana(npc, spoken, row));               // ask the small model for it
    }
    const missingTrans = !looksEnglish(reply.translation);
    const missingRoman = L.romanize &&
      (!looksEnglish(reply.roman) || pinyinWrongLength(spoken, reply.roman));
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
    if (u === 'none') say(LG.game.displayName(npc) + ' did not understand you at all.', 'miss');
    else if (u === 'partial') say(LG.game.displayName(npc) + ' only caught part of that.', 'miss');
    else say('');

    // A sale the reply claims is carried out or refused by the till, out of hours too.
    const act = gotIt ? String(reply.action || '').toLowerCase() : '';
    if (act === 'sell' || act === 'buy') {
      if (LG.game.commerce(npc, act, reply.item, reply.price)) renderItems();
      else say('That sale could not be squared up.', 'miss');
    }

    /* Holding out something they sold you asks for a refund. The reply
       tends to agree in words and leave "action" at "none", so it's
       checked, as an offered trade is (confirmOffer). */
    const held = (npc.sold || {})[offered];
    if (act !== 'buy' && offered && held && held.n > 0) {
      pending.push(confirmRefund(npc, offered, held.price, spoken, reply.translation));
    }

    // A trade completes only when the reply agrees to it, never on the gesture
    // alone; agreement in words without the field set is checked (confirmOffer).
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
        say(LG.game.displayName(npc) + ' does not want your ' + LG.ITEMS[offered].en + '.');
      }
    } else if (offered) {
      say(LG.game.displayName(npc) + ' has no use for that.');
    }

    busy = false;
    el.dlgSend.disabled = false;
    // A reply should not take focus back after a touch user dismissed the input.
    if (!LG.touch.on && here()) el.dlgInput.focus();
  }

  /* The checks each reply sets off after it's on screen (facts, glosses,
     furigana, trades), so the player isn't kept waiting. `settled()` waits
     for them. */
  const pending = [];

  // Fills in a missing translation or romanisation.
  async function repairGloss(npc, spoken, row, have) {
    const L = LG.LANGUAGES[LG.game.settings.lang];
    try {
      const got = await LG.llm.gloss(LG.game.llmConfig(), spoken,
        { who: npc.def.name, langName: L.name, romanLabel: (L.romanize && !have.roman) ? L.romanLabel : null });
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

  /* When something new overtakes a belief, that one line is rewritten, not
     deleted ("was looking for shoes, and has them now"). A chain fact keeps
     its id and gets the villager's wording (factNote); a memory is
     rewritten in place. On failure they keep what they believed. */
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

  /* Whether they actually took it back and paid out. Apologising, offering
     to look at it, or promising to sort it out later are all no. */
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

  // The right item was held out but the reply didn't flag the trade: did they agree?
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

  /* Missing furigana from the helper model, accepted only if it strips back
     to the line as spoken; the line on screen is updated in place. */
  async function repairFurigana(npc, spoken, row) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got = null;
      try { got = await LG.llm.furigana(LG.game.llmConfig(), spoken, attempt, npc.def.name); }
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
    if (current === npc) status('No furigana for that line — ' + (last ? 'the reading did not match.' : 'the request failed.'), 'miss');
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
                                           { who: npc.def.name, langName: L.name, furigana: !!L.furigana, diacritics: !!L.diacritics });
      confirmed.forEach(c => {
        // fall back to the line as spoken, so a note is never in the wrong language
        const note = c.note || spoken;
        const nRuby = usableRuby(c.ruby, c.note) || (c.note ? null : ruby);
        LG.game.learn(c.id, npc, note, nRuby);
      });
    } catch (e) { /* an unwritten note is always better than a wrong one */ }
  }

  /* Villager-to-villager conversations, wherever two meet, on the helper
     model. The queue caps how many run at once, not how much is said. */
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

  /* A meeting between two villagers, one call per line, each villager
     writing only their own (see DESIGN.md). */
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
          // No topic: whatever's on their mind comes up, or doesn't.
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
          stageInLang: !!L.stageInLang,
          romanLabel: L.romanize ? L.romanLabel : null,
          grammarNote: L.grammarNote || '',
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

        // Mostly off screen; the console is where it can be followed.
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

    // What each takes away is worked out from what was actually said.
    if (transcript.length >= 2 && ctx.a && ctx.b) remember(a, b, transcript, ctx);
  }

  function remember(a, b, transcript, ctx) {
    // Facts in their written, third-person form: "you think" is ambiguous from outside.
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
    // Revised the same as news from the player, who is no more reliable a source.
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

  /* Keeps the conversation on its newest line through any resize (keyboard,
     trays folding, rotation) while the reader is at the bottom; scrolled
     up, they're left alone. */
  const ANCHOR = 24;                  // px from the bottom that still counts as "at the end"
  function keepTheEnd() {
    const log = el.dlgLog;
    if (!log || !log.addEventListener) return;
    const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight <= ANCHOR;
    let stuck = true;
    log.addEventListener('scroll', () => { stuck = atEnd(); }, { passive: true });
    if (typeof ResizeObserver === 'function')
      new ResizeObserver(() => { if (stuck) log.scrollTop = log.scrollHeight; }).observe(log);
  }

  function init() {
    bind();
    el.dlgSend.onclick = () => send(el.dlgInput.value);
    /* Pressing the button would move focus off the input, so the next
       line needs another tap on the box first. Cancelling mousedown keeps
       focus where it is; the click still fires. On touch this is the
       compatibility mousedown that follows the tap. */
    el.dlgSend.addEventListener('mousedown', e => { if (document.activeElement === el.dlgInput) e.preventDefault(); });
    el.dlgClose.onclick = close;
    /* Focusing the input folds the phrase trays away (touch only). It only
       ever hides them, so it can't fight the height-based layout in
       game.js. */
    const mode = on => { try { document.body.classList.toggle('typing', on); } catch (e) {} };
    el.dlgInput.addEventListener('focus', () => mode(true));
    el.dlgInput.addEventListener('blur', () => mode(false));
    // Tapping the conversation puts the keyboard down.
    el.dlgLog.addEventListener('click', () => { if (LG.touch.on) el.dlgInput.blur(); });
    keepTheEnd();
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
           _looksEnglish: looksEnglish, _pinyinWrongLength: pinyinWrongLength,
           rubyHTML: rubyHTML, _usableRuby: usableRuby };
})();
