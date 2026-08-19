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

- **Villagers should remember talking.** Right now the fact ids transfer but the
  conversation itself evaporates, so Boris can tell Mira the same thing three times an
  hour and neither of them notices. A few lines of transcript kept per pair, fed back in
  next time, would fix the amnesia and cost nothing.
- **The player should be interruptible into one.** You can overhear two villagers but not
  join them. Walking up mid-conversation and being addressed by both — with the transcript
  as context — is the most natural three-way practice the game could offer, and the
  machinery is now nearly all there.
- **What they say should be able to be wrong.** They currently pass facts along
  faithfully. A villager who garbles a fact in the retelling is how rumours actually work
  and is the cheapest source of the misinformation the chain design keeps wanting.

## Smaller things

- **An economy that moves.** Buying and selling work, but prices are static and the
  village's stock is infinite. Stock that depletes, a baker who runs out by evening,
  and prices that drift with the season would make ¤10 mean something — and give the
  chain a second solution: buy the thing instead of fetching it.
- **Rooms worth being in.** Interiors exist but are only scenery. A villager who is
  *at* their anvil could be interruptible in a way they aren't on the street, and a
  bed you can sleep in would let you skip to morning rather than waiting out the night.
- **Save/load.** Nothing persists but settings. Serialising inventory, notebook,
  villager memory and positions would let a village span days.
- **注音版 Chinese.** Chinese children's books annotate *every* character, because
  there is no phonetic base script to fall back on — pinyin above the characters on the
  mainland, zhuyin down the right-hand side in Taiwan, the latter sitting in exactly the
  typographic slot `<ruby>` was designed for. The game currently gives Chinese one pinyin
  line under the whole sentence, which is the less authentic arrangement and harder to
  map word to sound. The ruby machinery already exists for Japanese; pointing it at
  Chinese would mean per-character readings and an option for zhuyin. Note the rule is
  genuinely different between the two languages: furigana goes only on kanji and only
  where the reading is not obvious, while an annotated Chinese edition annotates
  everything, without exception.
- **A word list.** Every noun a villager uses, logged with its translation and where
  you first heard it. Turns a session into something reviewable; spaced repetition on
  top if you want to go further.
- **Difficulty as scaffolding, not vocabulary.** Level already sets chain depth, how
  widely facts are spread, and how they speak. It could also take away the crutches:
  translations locked, phrasebook empty at advanced.
- **A gentle correction pass.** A cheap second call returning "you said X, a native
  would say Y" as a footnote under your own message. Keep it out of the villager's
  mouth — they shouldn't turn into teachers.
- **Prompt caching.** Each villager's identity block is stable across turns. A cache
  breakpoint there would cut per-turn cost once conversations get long.
- **Cost meter.** Tokens and estimated spend in the corner. Makes the model choice
  concrete for anyone paying per call.
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
