# Little Village

A small browser game. Twelve people live in a village, none of them speak your language,
and you have to talk your way through a chain of favours to get anything done.

The villagers are played by a language model. They remember what you tell them,
and they repeat it to each other.

## Running it

The quickest way is to open `index.html` in a browser — it works with no build step
and no dependencies.

**But if you're using an API key, serve it over http instead:**

```sh
cd language-game
python3 -m http.server 8000
# then open http://localhost:8000
```

Browsers send `Origin: null` for `file://` pages, which the API providers' CORS
rules reject. The game will tell you this at the front door rather than failing
mysteriously later.

## Connecting a brain (⚙ button)

The game asks for a key before it will start, and checks it with one tiny request —
so a bad key or a blocked origin is caught at the door rather than halfway through a
conversation.

| Provider | What you need |
|---|---|
| **Anthropic** | An API key from [console.anthropic.com](https://console.anthropic.com). The page calls `api.anthropic.com` directly from your browser using Anthropic's `anthropic-dangerous-direct-browser-access` opt-in header. |
| **OpenRouter** | A key from [openrouter.ai/keys](https://openrouter.ai/keys). |

There is no way to skip the key — a web page can't borrow credentials from anything
else on your machine. Whichever you pick, the key is kept in this browser's
`localStorage` and is sent only to that provider. Note that anyone with access to
your browser profile (or any script you let onto the page) can read it, so use a key
you're happy to rotate.

Requests are sent with thinking disabled and `effort: low` where the model supports
it — snappy replies matter more than deep reasoning for small talk.

The generator is fuzz-tested: 900 random chains across all three difficulties, checked
for solvability (every link's want is supplied by the next), no self-trades, no
duplicate villagers, a reachable terminal item, and no orphaned facts.

The helper model's calls only fire when they are needed — a fact nominated, a kanji
line with no readings, an offer the villager did not flag — and their prompts are a few
hundred tokens, so they are a rounding error next to the dialogue itself.

The village speaks Russian, English, Chinese (Mandarin), Japanese, French or Spanish,
at three difficulties. Russian and Chinese lines come back with a romanisation under
them; Japanese gets furigana over the kanji instead, via `<ruby>` tags.

Furigana appears in dialogue but not on item names, and that is deliberate: a villager
is *speaking*, so you need to know how the word sounds. An item name is written text —
a label on an object — so plain kanji is what you would actually see.

For Japanese the villager annotates as it writes — `say` itself carries the ruby
markup, and the spoken line is whatever remains once the readings are peeled off. One
field instead of two, so the line and its readings cannot disagree. Readings over
katakana and hiragana are stripped automatically; only kanji keep them.

Furigana is markup arriving from a model, so it is **sanitised**: the ruby tag family
survives (`ruby`, `rb`, `rt`, `rtc`, `rp`), normalised to bare tags so no attribute
ever reaches the page, and everything else tag-shaped is dropped. If a line has kanji
and no furigana came back, Haiku 4.5 is asked for the reading on its own — and *that*
is validated by peeling the readings off and checking what is left is exactly the line
the villager said, with one retry before giving up. A repair that alters the sentence
is discarded, and a give-up says so rather than failing silently.

What none of this catches is a **wrong reading** — 大工 as だいこう rather than だいく.
Validation only proves the text is intact, and a second opinion from a smaller model
would be less reliable, not more. The mitigations are prompt-side: annotate in one
pass rather than re-transcribing, and name the failure (word readings, not character
readings stitched together) without letting that instruction bleed into vocabulary
choice.

## Voices (optional)

Tick "let the villagers speak aloud" and paste an ElevenLabs key and each villager
gets a voice. It uses **Flash v2.5** — the fastest model that is properly multilingual,
which matters because generated dialogue almost never repeats, so there is nothing
worth caching and time-to-first-sound is the whole story.

Voices are **cast at load time** from whatever your account has: the villager list
carries a wanted gender and age, `GET /v1/voices` supplies the candidates, and each
villager is scored and given a distinct voice. **Quality leads**: the written gender is
a gentle nudge worth less than the quality range, so a villager whose voice does not
match how they are written is fine while a villager who is unpleasant to listen to is
not. Distinctness also wins over age, so nobody sounds like anybody else.

Quality varies a lot across an account, so the score uses what the voice list actually
tells us: `category` (professional and premade rank above generated, and well above the
instant clones that account for most of the poor ones), `high_quality_base_model_ids`,
`verified_languages` matching the village's current language, and share counts as a
tie-break. Every field is read defensively — one that is absent costs a voice nothing.
By default only curated voices are cast at all; there is a setting to open it up to the
whole account, and casting falls back automatically rather than leaving anyone mute on
a thin account. **Test this key** lists who got which voice with a ▶ to audition each
one from the preview clip, which costs no credits. Flash voices are cross-lingual, so Boris keeps his
voice when you switch the village from Russian to Japanese — a locale-keyed provider
would have made him a different person in each language.

Speech is **slowed down by default**, because the point is to be understood rather
than to sound naturalistic: beginner runs at 0.75× and advanced at 0.95×, and there is
an explicit control if you want to override that.

Lines are spoken as they arrive, a new line cuts off the one before it (including any
request still in flight, so a slow line can never talk over the one that replaced it),
leaving a conversation stops the audio, and every villager line keeps a 🔊 to hear it
again. It
is a third key on top of the model one; without it the village is simply silent.

If the key is refused there is a **Test this key** button next to the field that
reports exactly what ElevenLabs said — a 401 from them names which of "invalid key",
"missing permission" (it will name the permission) or "wrong kind of key" it was, and
that detail is shown rather than swallowed. The most common cause is a key without
`voices_read`.

## The village keeps its own time

Thirty days to a season, four seasons to a year, on a monsoon climate: winter is cold
and dry with blizzards, spring is mild and throws sandstorms off the flats, summer is
hot and wet with monsoon rain and thunderstorms, autumn cools steadily through fog and
drizzle.

**Most of the time nothing is laid over the screen at all.** The hour still colours the
world, because the hour changes and dusk ought to look like dusk. The season does not —
a wash that is always on is a wash you stop seeing, and it costs you the village's
actual colours all day for information a glance at the notebook gives you anyway. Nor
does most weather: you can see perfectly well that it is snowing from the snow, so only
the five kinds that genuinely take the light away — fog, monsoon, thunderstorm,
blizzard, sandstorm — grey anything out. Across the four climate tables that leaves the
screen clean about 83% of the time, which the test suite asserts.

Whether villagers shelter is a separate switch from how dark it looks, because the two
had been the same number and disagreed: drizzle is worth stepping inside for and barely
shows.

**Rain falls on roofs, not through them.** Precipitation is punched out of the building
footprints with an even-odd clip, so it stops at the eaves. Fog and haze are exempt —
they sit around a building rather than landing on it, and cutting hard rectangles out of
a soft cloud looked worse than the thing it fixed.

A village day is six minutes by default (adjustable), the calendar keeps running
between visits, and a new village starts on a random day, so you may well arrive in a
blizzard. Villagers know the date and the weather and will remark on it.

**They keep hours too.** The pull of the village green rises to midday and thins by
dusk; at night everyone is home, and nobody stands about on the green in a blizzard.
When two of them meet they stop, turn to face each other, and actually talk — a real
back-and-forth of four to six lines, not a canned exchange.

**Each line is its own call, and each villager only writes their own.** The alternative
is one call that writes both halves, which is what this used to do, and it reads like a
script: the halves agree too neatly, nobody misunderstands anybody, and the second
speaker never says anything the first did not set up. Now each turn goes to the small
model with that villager's persona, whatever news they are carrying, and the transcript
so far, and they answer what was actually just said. Both of them bring their own news,
so it is a conversation with two people's business in it rather than one delivery and an
acknowledgement.

That costs four to six small-model calls per meeting instead of one, which is the whole
reason it runs on the helper model — two conversations at a time, paced at a line every
2.8 seconds, so a busy green is a handful of cheap calls a minute rather than a flood.

**Every building opens.** Walk through a door and the roof lifts off — you are
standing in a furnished room, and so are the villagers who went in. The shop has a
counter and shelves, the bakery an oven, the smithy an anvil, the inn its tables.
Doors are cut so that every one of them has a path to it, which is checked by a
flood-fill on every generated village rather than trusted.

**Weather drives them indoors.** When it is raining, snowing or blowing sand, a
villager would rather be under a roof — at their workplace if they have business
there, at home otherwise — so a monsoon afternoon empties the green and fills the
buildings. On a clear day they are mostly outside, which is what makes the wet days
read as wet.

This happens **wherever they are**, not only where you can see it — running it on the
small model is what makes that affordable, and a village that only talks when watched
is not a village. What your proximity decides is only whether the exchange reaches your
event log — and what lands there is **what they said, in their language**. They are
talking to each other; there is no English anywhere in that exchange, so there is none
in the log either. Furigana and romanisation come through the same as everywhere else.

The English is there to check yourself against, blurred until you click it, and it stays
blurred **even with translations switched on**. A villager explaining something to you is
a lesson and the setting applies; eavesdropping is a test, and printing the answer turns
overhearing into a way to skip the language entirely. A queue smooths bursts (a dozen villagers meeting on the green at midday
start their conversations a beat apart rather than all at once), and a meeting that
goes stale because the pair wandered off is dropped rather than generated late.

## Playing

- **WASD / arrow keys** to walk, **E** or **Space** to talk to whoever you're next to.
  Input reads *physical* keys, so it works on any keyboard layout — on a Cyrillic
  layout the same keys still walk and talk even though they type цфыв and у.
- Type in *their* language. The **Phrases** row gives you something to start from;
  **Offer an item** holds something out of your pockets.
- Translations can be shown immediately or blurred until you click them (⚙ → settings).

**The villagers only speak their own language.** Slipping in an English word does not
work — they don't understand it, they can't answer a question they didn't catch, and
it can't talk them into a trade. Holding an item out to them, on the other hand, needs
no words at all.

**Doors are opaque.** A villager under a roof is out of sight. You can see into the room
you are standing in — that is what lifting the roof is for — but not through somebody
else's walls, so the baker at her oven is genuinely away until you go in after her.
Which room you are in is read from your feet rather than your tile, because the two
disagree for the topmost few pixels of every room and the roof used to slam shut while
you were plainly standing indoors.

**Your notebook only knows what you've been told.** It starts empty. When a villager
actually tells you something — who wants what, who has it, where a thing was last
seen — that line appears in the notebook and not before. Notes retire once they're
spent.

**You start with ¤10, and money works.** A villager standing at their own counter
during the day is open for business: the baker sells bread, the smith sells tools,
the shopkeeper sells most of what the village has. Ask for a thing and agree a price
and the coins and the goods actually move — the baker offering you bread now means
something, because the actor playing the baker was always going to offer it. They buy
too, if it is the sort of thing they deal in. Prices come from what the item is, and
haggling is clamped either side of that, so a villager can be talked down but not
robbed. Nobody trades at night, and nobody trades away from their counter.

**Every village is a new errand.** A chain is generated per playthrough: someone wants
a thing, someone else has it and wants something else, and the last link is something
lying out in the world or an animal that has wandered off. The village's name (bottom of the
notebook) is its seed — the same name always regenerates the same errand.

## How it fits together

```
index.html
css/style.css
js/time.js       the calendar: hours, seasons, and what the weather is doing
js/data.js       languages, phrasebook, gossip lines, ~140 items, 16 places, 12 villagers
js/chain.js      generates a solvable errand chain + the facts that describe it
js/llm.js        provider abstraction, key validation, JSON extraction from replies
js/world.js      tile map, collision, pathfinding, interiors, all the canvas drawing
js/sky.js        the hour, the season's colour, and whatever is falling
js/npc.js        wandering, the gossip exchange, character/bubble rendering
js/dialogue.js   prompt building, the conversation UI, trades
js/game.js       state, main loop, input, notebook, settings
```

Plain `<script>` tags and a global `LG` namespace — no modules, no bundler, so it
runs by double-clicking.

**Everything learnable is a fact with an id.** `chain.js` deals facts out to villagers —
the holder of a fact always knows it, plus a few others (the spread scales with the
population, so doubling the village does not make every rumour twice as hard to find).
Nothing reaches the notebook except by being said out loud.

**Difficulty is how hard the village is to read, not how far you walk.** Chain length
used to scale with difficulty, and it was the wrong knob — a longer chain deals out
*more* facts to *more* villagers, so it gives you more places to break in. A five-link
errand could comfortably be easier than a two-link one. Length is now rolled per village
from the same 2–4 range at every level, purely for variety, and difficulty is carried by
who knows what:

- **Spread** — how many villagers beyond the owner are told a chain fact: four at
  beginner, two at intermediate, one at advanced.
- **Taper** — holders drop off the further down the chain a fact sits, so length now
  *buries* the tail instead of exposing it. The owner always knows their own business,
  so the chain stays walkable in order however far the taper runs.
- **The gossip** — Petra was omniscient at every level, which is a skeleton key that
  makes every other knob moot: one conversation and you had the whole errand. She still
  is at beginner, has caught about half of it at intermediate, and at advanced knows
  nothing but who thinks what about whom.

In practice that runs 5.4 → 2.1 → 1.2 villagers per chain fact while the average chain
length stays flat at about three links. At advanced you have to walk the chain in order,
because nobody can tell you about a link you haven't reached.

**Your notebook is in their language.** A note records what you were told, in the
words you were told it — `ミラさんはのこぎりをさがしています。`, not "Mira is looking
for a saw". The English gloss sits underneath, blurred until you click it, on the same
terms as dialogue translations. The fact-checker below writes the note as part of the
call it was already making.

**Replies are read forgivingly, but never shown raw.** Villagers answer in JSON, and
models occasionally drop a quote or leave a trailing comma. The parser strips fences,
repairs the common breakages, and — failing that — lifts the fields out by hand. What
it will not do is fall back to showing the raw text: a player should never see a brace
in a speech bubble, so an unreadable reply is reported as a failed turn instead.

**A translation has to be a translation.** The `en` field occasionally comes back in
the villager's own language — a Chinese line "translated" into Chinese, which tells you
nothing. Anything carrying Han, kana or Cyrillic where English was asked for is
rejected and re-glossed by the helper model, so the blurred line under a villager's
speech is always in a language you can read.

**Two models, on purpose.** The one you pick plays the villagers; a second, smaller
one does the bookkeeping they are bad at — checking what they actually told you before
it reaches your notebook, filling in missing furigana, and confirming a trade was
agreed. It defaults to Haiku 4.5 on either provider and is pickable in settings
(OpenRouter offers MiMo-V2.5, Gemini Flash, GPT-4.1 mini, GLM-5.2), with an **Other**
box for any id the picker does not list yet. Cheap and literal-minded beats clever
here; it is answering yes/no questions about a transcript.

**Notes are nominated, then fact-checked.** A villager's prompt lists their facts with
tags, and their reply nominates the tags it thinks it just revealed. That report alone
is not trusted — a villager will flag a fact because it *used* the word or explained
what the word means, which writes things in your notebook that nobody told you. So
when a villager nominates anything, a second, cheaper model (Haiku 4.5) reads the line
that was actually said and confirms which statements were genuinely asserted. It runs
after the reply is on screen, so nothing waits for it, and it fails closed: an
unconfirmed note simply isn't written. The nomination is only a trigger, which keeps
the check off the ~90% of turns where no fact is in play.

**Each character's prompt** is assembled per turn from: who they are, what the
generator gave them to want, the facts they hold, what you've told them, what you're
carrying, and the difficulty level. They reply with a small JSON object — what they
say, a translation, a romanisation, how much of you they understood, which facts they
revealed, optionally something to remember, and optionally a trade.

**A gesture is not a bargain.** Holding an item out is something a villager
understands without words, but it does not complete a trade on its own — they have to
agree to the exchange. If they agree and their reply forgets to flag it, the offer is
put to the same small model that does the fact-checking ("did they just accept it and
hand theirs over?"), and only a yes completes the deal. Being interested, asking about
it, or promising to trade later all count as no. That keeps a confused reply from
stranding the chain without letting you barter by waving objects at people.

**Gossip costs nothing.** When two idle villagers pass each other they swap one fact
id each, no model call involved. A rumour that starts with one villager really does
reach the others, and you can hear it from whoever it reached.

`IDEAS.md` has notes on where this could go next.
