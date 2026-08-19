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
drizzle. Each season colours the world, and the weather falls on it — snow, rain, sand,
fog — over a wash for the hour, so dusk and midnight look like dusk and midnight.

A village day is six minutes by default (adjustable), the calendar keeps running
between visits, and a new village starts on a random day, so you may well arrive in a
blizzard. Villagers know the date and the weather and will remark on it.

**They keep hours too.** The pull of the village green rises to midday and thins by
dusk; at night everyone is home, and nobody stands about on the green in a blizzard.
When two of them meet they stop, turn to face each other, and actually talk: the
exchange is written by the helper model from the fact being passed, seeded with both
personas and the current weather, so the innkeeper passes news like an innkeeper and
the woodcutter answers in one word.

This happens **wherever they are**, not only where you can see it — running it on the
small model is what makes that affordable, and a village that only talks when watched
is not a village. What your proximity decides is only whether the exchange reaches your
event log. A queue smooths bursts (a dozen villagers meeting on the green at midday
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

**Your notebook only knows what you've been told.** It starts empty. When a villager
actually tells you something — who wants what, who has it, where a thing was last
seen — that line appears in the notebook and not before. Notes retire once they're
spent.

**Every village is a new errand.** A chain is generated per playthrough: someone wants
a thing, someone else has it and wants something else, and the last link is something
lying out in the world or an animal that has wandered off. Depth scales with
difficulty (2 links at beginner, 4 at advanced). The village's name (bottom of the
notebook) is its seed — the same name always regenerates the same errand.

## How it fits together

```
index.html
css/style.css
js/time.js       the calendar: hours, seasons, and what the weather is doing
js/data.js       languages, phrasebook, gossip lines, ~140 items, 16 places, 12 villagers
js/chain.js      generates a solvable errand chain + the facts that describe it
js/llm.js        provider abstraction, key validation, JSON extraction from replies
js/world.js      tile map, collision, pathfinding, all the canvas drawing
js/sky.js        the hour, the season's colour, and whatever is falling
js/npc.js        wandering, the gossip exchange, character/bubble rendering
js/dialogue.js   prompt building, the conversation UI, trades
js/game.js       state, main loop, input, notebook, settings
```

Plain `<script>` tags and a global `LG` namespace — no modules, no bundler, so it
runs by double-clicking.

**Everything learnable is a fact with an id.** `chain.js` deals facts out to villagers
— the holder of a fact always knows it, plus a few others (the spread scales with the
population, so doubling the village does not make every rumour twice as hard to find),
and one villager is the designated gossip who knows everything. Nothing reaches the notebook except by
being said out loud.

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
