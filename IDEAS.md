# Ideas

Where Little Village could go next. Things that have since been built are at the
bottom, for the record.

## Text to speech

Probably the single biggest win for actually learning anything. Two notes on how to
pick a provider, because the obvious criterion is the wrong one:

**Accent matters more than latency.** A model that reads Russian with an American
accent is worse than silence in a game whose point is learning Russian. That rules
out several of the fastest options, which are English-first. ElevenLabs Flash v2.5
(~75ms, ~32 languages) and Azure Speech (slower, but the broadest locale coverage
with genuinely native voices per locale, and a browser SDK with short-lived tokens
rather than a raw key) are the strongest fits. Cartesia Sonic is faster than either —
check its Russian and Mandarin coverage before committing. Piper or Kokoro compiled
to WASM would run locally with no key at all, at a clear quality cost.

**Latency is mostly hideable, so optimise for cacheability instead.** The villager's
model call already costs 1–3s and the text renders the moment it arrives, so even
300ms of TTS is invisible. Villager lines repeat constantly, the phrasebook is fixed,
and the difficulty templates are a closed set — hash `(text, voice)` into IndexedDB
and most lines become instant and free after twenty minutes of play. The phrasebook
could be pre-generated as static audio and never hit an API at all.

Speech *input* is the natural pair (`SpeechRecognition`, Chrome only): say it aloud,
the recogniser transcribes, and what it heard becomes your message. Being misheard is
itself useful feedback.

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

## Smaller things

- **Save/load.** Nothing persists but settings. Serialising inventory, notebook,
  villager memory and positions would let a village span days.
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
- **Time of day.** A colour tint and villagers going home at dusk. Cheap, and it makes
  the village feel like it exists when you aren't looking at it.
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
- Six languages: Russian, English, Chinese, Japanese, French, Spanish.
