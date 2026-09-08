# Ideas

Where Little Village could go next. Things that have since been built are at the
bottom, for the record.

## Speech input

Text-to-speech is in (see the README). The natural pair is speech *input* —
`SpeechRecognition`, Chrome only: say the line aloud, the recogniser transcribes, and
what it heard becomes your message. Being misheard is itself useful feedback, and it
closes the loop on pronunciation, which the game currently does nothing about.

Worth knowing when tuning voices: readings are the weak point, not the audio. A wrong
furigana reading feeds straight into a wrong pronunciation, so the two systems fail
together.

## Relationships, and the shape of the problem

The bit of the current design that people react to is the pure-flavour gossip —
"Nadia thinks Boris never washes". It lands because it's an **opinion**, not a fact,
and the code currently treats both as the same flat string.

Splitting them is where this opens up. Facts are transferable and checkable. Opinions
are transferable, *mutate* as they pass, and carry a number. Give each villager
`opinion[otherId]`; when A gossips to B about C, B's opinion of C moves toward A's,
scaled by how much B likes A. The player is just another subject in that graph, which
gets you reputation for free: be rude to Petra, she tells Yuri, and Yuri is cool to
you before you've met him.

Lies fall out of the same structure. Facts already carry a source. If one is
contradicted by something the believer can observe, their opinion of the source drops
— so telling Petra that Yuri has the rock propagates, sends someone to the wrong
person, and costs you standing downstream. Consequence with no bespoke machinery.

**The hard part is that the characters are model-backed, which cuts both ways.** A
number moving from 0.6 to 0.4 is easy; what's hard is that the character can *say
anything about it*, and the space of things a slightly-annoyed baker might do is not
enumerable. Some of the edges worth thinking through before building:

- Does an opinion constrain the model, or just colour it? One line of prompt ("you
  find this traveller charming") is cheap and safe. A hard gate ("refuse to trade
  below 0.3") is legible but makes characters feel like state machines.
- What counts as an update? If the model decides each turn how the traveller made it
  feel, the numbers drift on vibes and are hard to debug. If the code decides from
  events, it misses everything interesting that happened in the conversation.
- Who is the authority on what was said? A villager can misreport gossip — which is
  *good*, that's how rumours work — but then the fact graph and the transcript
  disagree, and it isn't obvious which one the game should believe.
- Recovery: if a character can be turned against you, there has to be a way back, or
  a bad first conversation quietly ruins a playthrough.

The cheap version that avoids all of it: keep opinions as pure flavour facts (as now),
and add a single player-reputation number per villager that only nudges tone. Most of
the felt benefit, almost none of the surface area.

## Chains

The generator handles TRADE, SELL (for coins), FETCH and FIND. The node type it does
*not* have yet is the linguistically interesting one:

**DELIVER.** A tells you something; you carry it to B; B judges whether you actually
conveyed it and only then hands over the item. It's the one node type that can't be
solved by walking around and clicking, and it's a genuine comprehension-and-production
test that emerges from the fiction rather than being bolted on as a quiz. It needs a
flag set by B's model (`action: "received"`) gating A's trade, and it should probably
only appear at intermediate and above — producing a whole sentence is too much at A1.

Others worth having: a node that requires *two* items at once (forces a harder
sentence), and a node where the holder will only deal with you after you've done
something for someone else entirely.

## Difficulty, now that length isn't carrying it

Difficulty is currently three things: how the villagers speak, how widely chain facts
are spread, and whether the village gossip is a skeleton key. Chain length was retired
as a lever because it ran the wrong way — a longer chain has more facts, so more
villagers hold one, so there are more places to break in.

What's left to try, roughly in order of how much they'd add:

- **DELIVER nodes** (below) are the one lever that scales with *comprehension* rather
  than legwork, which is the thing the game is actually about.
- **Take away the crutches at the top end**: translations locked, phrasebook empty.
  Cheap to build, and it moves difficulty into the interface where the player can feel
  it, rather than into the fact graph where they can't.
- **Villagers who need a reason.** Right now anyone will tell you anything if you ask
  in their language. A villager who wants small talk first, or who only talks to
  someone another villager vouched for, makes the spread number bite harder without
  changing it.
- **Wrong answers.** A villager who half-remembers — right item, wrong person — costs
  you a walk and is recoverable by asking a second source. This is also the cheapest
  thing that makes the spread number *good* rather than merely restrictive: at low
  spread there is no second source to check against.

## Where the villager conversations could go

They hold real conversations now, but the conversation is a closed loop: it is generated,
displayed, and thrown away. Two things fall out of keeping it.

- **Villagers should remember talking, further.** They now know *that* they talked —
  see Built, below — which is the plain fact a repeat conversation was missing, but
  the conversation's own transcript still evaporates the moment it ends. Keeping a
  line or two of what was actually said, verbatim, and handing it back next time
  ("last time you asked me about the rope, and I said I hadn't seen it") is the
  fuller version of this and was judged the bigger, riskier change for one sitting —
  a second player-facing prompt field, wired to a second per-pair store, and content
  worth getting right rather than a fact worth just having.
- **The player should be interruptible into one.** You can overhear two villagers but not
  join them. Walking up mid-conversation and being addressed by both — with the transcript
  as context — is the most natural three-way practice the game could offer, and the
  machinery is now nearly all there.
- **What they say should be able to be wrong.** They currently pass facts along
  faithfully. A villager who garbles a fact in the retelling is how rumours actually work
  and is the cheapest source of the misinformation the chain design keeps wanting.

## Now that villagers decide things

Movement went from a dice table to a decision made by the helper model. The same argument
applies to nearly everything else still hardcoded, and it is worth being suspicious of any
remaining rule that a person with the same information would not need:

- **Gossip pairing** is still proximity plus a cooldown. Who a villager *wants* to talk to
  — someone who might know where the saw is, someone they like — is a decision they could
  make.
- **What they do when they get there.** A villager who walks to the Inn to find Sanna
  currently just stands in the Inn. Arriving with an intention, and acting on it when the
  person is there, is the other half of the movement change.
- **The trade rules.** `action: "trade"` still has a hint spelling out when to fire it.
  With the till visible, that may be derivable too.

The counter-argument, worth keeping in view: every decision handed to the model is another
call, another failure mode, and another thing that cannot be unit-tested to a fixed answer.
The dice table is still there underneath for exactly that reason.

## Smaller things

- **An economy that moves.** Buying and selling work, but prices are static and the
  village's stock is infinite. Stock that depletes, a baker who runs out by evening,
  and prices that drift with the season would make ¤10 mean something — and give the
  chain a second solution: buy the thing instead of fetching it.
- **Rooms worth being in.** Interiors exist but are only scenery. A villager who is
  *at* their anvil could be interruptible in a way they aren't on the street, and a
  bed you can sleep in would let you skip to morning rather than waiting out the night.
- **Spaced repetition on the word list.** The word list (Built, below) is every item
  the village has actually named for you, in order; a review mode on top of it —
  due-today, self-graded — is the natural next step for a list that already exists.
- **Prompt caching.** Each villager's identity block is stable across turns. A cache
  breakpoint there would cut per-turn cost once conversations get long.
- **More languages.** One `LG.LANGUAGES` entry, item translations, twelve phrasebook
  strings, four gossip mutterings — all of it in `data.js`, and the smoke test fails if
  any of the four is incomplete. Korean would follow Japanese exactly (romanisation
  field plus a script-appropriate font stack).

## Built

- Procedural errand chains, seeded and fuzz-tested, with depth by difficulty.
- The notebook: villagers report which facts they revealed, and only those appear.
- Monolingual villagers — English words genuinely don't land.
- A key gate that validates before the game starts.
- Free gossip: villagers swap fact ids on contact, no model call.
- Six languages: Russian, English, Chinese, Japanese, French, Spanish — with
  furigana rather than rōmaji for Japanese.
- ~140 items across five pools, so chains rarely repeat themselves.
- Voices per villager, cast at load time from the ElevenLabs voice list.
- A village of twelve across 80×56 tiles, with a flood-fill test that fails the build
  if any villager or place is walled off — or if a door can't be reached.
- Building interiors: walk in, the roof lifts, the room is furnished.
- A calendar — six-minute days, thirty-day seasons, a monsoon climate — with weather
  the villagers remark on and shelter from.
- Villager-to-villager conversations on the small model, running everywhere at once
  rather than only within earshot — turn by turn, each villager writing only their own
  lines and answering what was actually said.
- Overheard talk logged in the language it was spoken in, with the English blurred
  behind a click so eavesdropping stays a comprehension test.
- Difficulty rebuilt around knowledge concentration rather than chain length, with a
  test that fails if the two ever re-correlate.
- Roofs that hide the people under them and keep the rain off.
- A screen that is untinted most of the time — no season wash, and grey reserved for
  the weather that genuinely takes the light.
- Money: a ¤10 purse, villagers who buy and sell from behind their own counters, and
  haggling clamped either side of what a thing is worth.
- A cost meter: calls, tokens and a running dollar total in the settings panel, exact
  where a provider hands back its own price and marked with a `~` the moment any of it
  is priced off a reference table instead.
- 注音版 Chinese: pinyin or zhuyin, one reading per character, ruby-style like
  furigana — rebuilt in the browser from the sentence and the whole-line pinyin
  the model already sends rather than asked of the model as a second, ruby-shaped
  reply, so a line that does not line up just falls back to the plain sentence
  with pinyin underneath instead of showing something wrong.
- A word list (🔤 button): every item the village has actually named for you —
  bought, traded, picked up, or told about before you ever held it — logged once
  each in the order you met it, gloss shown straight away rather than blurred.
- Villagers know when they last talked to each other: a plain, dated line in the
  next conversation between the same two ("you have talked with Mira before,
  earlier today at 09:14"), read off a per-pair record each of them keeps rather
  than parsed from anything — see "further" under villager conversations, above,
  for the fuller version this is a first step toward.
- The reason a villager went somewhere reaches the player, not just the console:
  a nearby arrival gets a line in the event log naming why, the same `why` that
  has always come back with the decision — legible from outside now, and only
  for the one arrival it was actually the reason for, never a stale one carried
  over from a decision the dice table has since walked past.
- A gentle correction pass (⚙ → corrections, off by default): a cheap second
  call footnotes what you typed with how a native speaker would actually say
  it, when it would say it differently — never in the villager's own mouth,
  who answers what they understood, in character, whether or not it was well
  put.
- Difficulty as scaffolding, not just chain shape: at Advanced, translations
  are locked rather than a click away (the notebook, the event log, signs,
  the dialogue box, all of it — even a tooltip stopped being a second way to
  read the answer without clicking through it) and the Phrases tray goes
  empty, so nothing is there to lean on. `spread`/`taper`/`gossip` already
  made the chain itself harder to trace; this is the level that makes the
  interface stop helping too.
