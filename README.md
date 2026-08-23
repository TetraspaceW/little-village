# Little Village

A small browser game. Thirteen people live in a village, none of them speak your
language, and you have to talk your way through a chain of favours to get anything
done.

The villagers are played by a language model. They remember what you tell them, and
they repeat it to each other. You will need an API key from Anthropic or OpenRouter.

<!-- TODO: screenshot or GIF here -->

## Running it

```sh
cp .env.example .env         # fill in your keys
node tools/logserver.js      # then open http://localhost:8787
```

One process serves the village, keeps its log, keeps its save, and hands the page your
keys, so there is nothing to paste at the door and no CORS to arrange. It binds
`127.0.0.1` only and will not serve `.env` or `logs/` to anything that is not a local
connection. `PORT` works from the `.env` too, and `ANTHROPIC_API_KEY=… node
tools/logserver.js` beats the file without editing it. The file is read once — restart
to pick up a change.

There is no build step and no dependencies, so any static server will do instead:

```sh
python3 -m http.server 8000  # then open http://localhost:8000, and paste a key
```

Opening `index.html` from the filesystem also works, but **not with an API key**:
browsers send `Origin: null` for `file://` pages and the providers' CORS rules reject
it. The game says so at the front door rather than failing mysteriously later.

## Playing

- **WASD / arrow keys** to walk, **E** or **Space** to talk to whoever you're next to.
  Input reads *physical* keys, so it works on any keyboard layout — on a Cyrillic
  layout the same keys still walk and talk even though they type цфыв and у.
- Type in *their* language. The **Phrases** row gives you something to start from;
  **Offer an item** holds something out of your pockets.
- Translations can be shown immediately or blurred until you click them (⚙ → settings).

**Every village is a new errand.** Someone wants a thing, someone else has it and wants
something else, and the last link is something lying out in the world or an animal that
has wandered off. The village's name, at the bottom of the notebook, is its seed — the
same name always regenerates the same errand.

**The villagers only speak their own language.** Slipping in an English word does not
work — they don't understand it, they can't answer a question they didn't catch, and it
can't talk them into a trade. Holding an item out to them, on the other hand, needs no
words at all. A gesture is not a bargain, though: they still have to agree.

**Your notebook only knows what you've been told.** It starts empty. When a villager
actually tells you something — who wants what, who has it, where a thing was last seen —
that line appears in the notebook, in the words you were told it —
`ミラさんはのこぎりをさがしています。`, not "Mira is looking for a saw" — with the English
gloss under it, blurred on the same terms as dialogue translations. Leads you have
already followed arrive struck through.

**You start with ¤10, and money works.** A villager standing at their own counter during
the day is open for business: the baker sells bread, the smith sells tools, the shopkeeper
sells most of what the village has. Ask for a thing, agree a price, and the coins and the
goods actually move — the baker offering you bread means something, because the actor
playing the baker was always going to offer it. They buy too, if it is the sort of thing
they deal in, and they will take back what they sold you at what you paid. Prices come
from what the item is and haggling is clamped either side of that, so a villager can be
talked down but not robbed. Nobody trades at night, nobody trades away from their counter,
and nobody will buy a link of the errand chain off you.

**Every building opens, and doors are opaque.** Walk through one and the roof lifts off
— you are standing in a furnished room, and so are the villagers who went in. The shop
has a counter and shelves, the bakery an oven, the smithy an anvil, the inn its tables.
A villager under somebody else's roof is genuinely out of sight until you go in after
them.

**They have their own business.** Villagers decide where to go from what they want, what
they have heard and what the weather is doing. They keep hours — the pull of the village
green rises to midday and thins by dusk, at night everyone is home, and nobody stands
about on the green in a blizzard — and when two of them meet they stop, turn to face each
other and actually talk, a real back-and-forth of four to six lines. That happens wherever
they are, not only where you can see it. Stand near a pair and what they say reaches your
event log, in their language, with the gloss blurred even if you have translations
switched on: eavesdropping is a test rather than a lesson.

## Connecting a brain (⚙ button)

The game checks your key with one tiny request, so a bad key or a blocked origin is
caught at the door rather than halfway through a conversation.

| Provider | What you need |
|---|---|
| **Anthropic** | A key from [console.anthropic.com](https://console.anthropic.com). The page calls `api.anthropic.com` directly using Anthropic's `anthropic-dangerous-direct-browser-access` opt-in header. |
| **OpenRouter** | A key from [openrouter.ai/keys](https://openrouter.ai/keys). |

There is no way to skip the key — a web page can't borrow credentials from anything else
on your machine. Whichever you pick, the key is kept in this browser's `localStorage` and
sent only to that provider; anyone with access to your browser profile (or any script you
let onto the page) can read it, so use a key you're happy to rotate. The `.env` route
above saves the pasting, not the trust: the keys still end up in the browser.

**Two models, on purpose.** The one you pick plays the villagers; a second, smaller one
does the bookkeeping they are bad at — checking what they actually told you before it
reaches your notebook, deciding what a pair of villagers came away from a conversation
with, filling in missing furigana, confirming a trade was agreed, and choosing where
everyone walks. It defaults to Haiku 4.5 on either provider and is pickable in settings
(OpenRouter also offers MiMo-V2.5 and MiMo-V2.5 Pro, Gemma 4 31B, Gemini 2.5 Flash,
GPT-4.1 mini, GLM-5.2 and Ox Alpha), with an **Other** box for any id the picker does
not list yet. Cheap and literal-minded beats clever here; it is answering yes/no
questions about a transcript.

**What it costs.** Measured over 2.8 hours of logged play: the model you picked runs about
60 calls an hour — only the lines a villager says to you — for roughly 90k input and 30k
output tokens. The helper runs about 1,200 calls an hour, 520k in and 380k out, because it
moves thirteen people about and writes every conversation in the village whether you are
watching or not. Priced at a reference $3/$15 per million tokens for a smart model and
$1/$5 for a quick one, that is **$0.70 and $2.40 — call it $3 an hour**, and note which of
those two is the big one. The helper is not a rounding error next to the dialogue; it is
most of the bill.

The figure moves most on a single choice: whether the helper reasons before it answers. In
these logs a reasoning helper wrote 1,863 output tokens per call against 59 for one that
does not — the same yes/no questions about a transcript, thirty times the output, on the
leg that makes 95% of the calls. Picking a quick, literal helper roughly halves the hourly
cost, which is where the quality argument lands too. Requests are sent with thinking
disabled and `effort: low` where the model supports it for that reason. Prompt caching does
not help: helper prompts run a few hundred tokens, under the usual minimum cacheable
prefix, and change per villager per call.

Both figures scale with how busy the village is — logged sessions ran anywhere from 560 to
1,880 calls an hour — and with the day length, since a shorter day turns the hour over
more often and every villager rethinks when it does. On OpenRouter you need not trust any
of this: `usage.cost` comes back on every call and is already in your session log, so
`jq -s 'map(.usage.cost // 0) | add' logs/session-*.jsonl` is the real answer for a real
evening. Anthropic returns token counts only, so there the same sum needs a price table.

Where a provider will take a JSON Schema the reply shape is enforced rather than asked
for — Anthropic as `output_config.format`, OpenRouter as `response_format` — and the game
looks up whether the model you picked supports it when the key is accepted. Anything it
could not look up counts as no, and falls back to asking in the prompt and repairing what
comes back.

## Languages and difficulty

The village speaks Russian, English, Chinese (Mandarin), Japanese, French or Spanish, at
three difficulties. Russian and Chinese lines come back with a romanisation under them;
Japanese gets furigana over the kanji instead, via `<ruby>` tags — in dialogue, but not
on item names, because a villager is *speaking* and a label on an object is written text.

Difficulty is how hard the village is to read, not how far you walk. Chain length is
rolled from the same 2–4 range at every level, purely for variety; what changes is who
knows what.

- **Spread** — how many villagers beyond the owner are told a chain fact: four at
  beginner, two at intermediate, one at advanced.
- **Taper** — holders drop off the further down the chain a fact sits, so length
  *buries* the tail instead of exposing it. The owner always knows their own business,
  so the chain stays walkable in order however far the taper runs.
- **The gossip** — Petra knows the whole errand at beginner, about half of it at
  intermediate, and at advanced nothing but who thinks what about whom.

In practice that runs 5.4 → 2.1 → 1.2 villagers per chain fact while the average chain
length stays flat at about three links. At advanced you have to walk the chain in order,
because nobody can tell you about a link you haven't reached.

## Voices (optional)

Tick "let the villagers speak aloud" and paste an ElevenLabs key and each villager gets a
voice, cast at load time from whatever your account has and scored for quality and
distinctness. It is a third key on top of the model one; without it the village is simply
silent.

Speech is slowed down by default — 0.75× at beginner, 0.95× at advanced — because the
point is to be understood rather than to sound naturalistic. Lines are spoken as they
arrive, a new line cuts off the one before it, leaving a conversation stops the audio,
and every villager line keeps a 🔊 to hear it again. **Test this key** lists who got which
voice with a ▶ to audition each one from its preview clip, which costs no credits, and
reports exactly what ElevenLabs said if the key is refused (usually: it is missing
`voices_read`).

By default only curated voices are cast; there is a setting to open it up to the whole
account.

## The village keeps its own time

Thirty days to a season, four seasons to a year, on a monsoon climate: winter is cold and
dry with blizzards, spring is mild and throws sandstorms off the flats, summer is hot and
wet with monsoon rain and thunderstorms, autumn cools steadily through fog and drizzle. A
village day is six minutes by default (adjustable), and every new village is a fresh
arrival on a random day of the year, so you may well turn up in a blizzard.

Weather is something the village does rather than something laid over the screen: rain
falls on roofs and not through them, snow settles and lies for days and melts at a rate
the season sets, and only the five kinds that genuinely take the light away — fog,
monsoon, thunderstorm, blizzard, sandstorm — grey anything out. Villagers know the date,
the weather and how deep the snow is, will remark on it, and would rather be under a roof
when it is wet.

## Coming back to it

The village writes itself down every twenty seconds, and again the moment anything
happens that would be painful to lose — a link of the chain traded, the errand finished, a
new village rolled — and once more on the way out of the tab. Open the page again and you
are back in the same afternoon: the same seed, the same day and hour, the same weather and
the same snow lying, your pockets, your notebook, the deeds behind you, and thirteen
people standing where you left them and still remembering what you told them.

It is one plain JSON object, written to this browser's `localStorage` and to
`saves/village.json` if the log server is running — the same bytes in both places, so a
save from one loads in the other.

```sh
node tools/logserver.js
# ... play ...
cat saves/village.json | python3 -m json.tool | head
```

A save someone hands you loads from the console with
`LG.save.restore(JSON.parse(text))`, and the village you are in comes out with
`LG.save.snapshot()`. There is no import format to get wrong, because there is no import
format. Saves carry the village's seed rather than the village, and are refused out loud
if the generator has changed underneath them.

⚙ → **Forget the saved village** clears both copies. **Start a new village** overwrites
them immediately, so closing the tab straight afterwards does not bring the old one back.

## Watching what it actually does

With the log server running, everything lands in `logs/session-<when>.jsonl`, one JSON
object per line:

- **every API call**, whole — the system prompt, the messages, the raw reply before any
  parsing, the model's own reasoning where it exposes any, the token usage, the latency,
  and whether it was cut off at `max_tokens`;
- **every villager decision** — who wondered where to be, where they went and why, when
  they arrived, what they learned and from whom, what they said.

The terminal shows a terse line per entry as a live view. If the log server is not running
the game notices on its first post, switches logging off and carries on — so it is never a
dependency, only a window.

The browser console has the same thing live: each call prints as a collapsed group you can
open, and each villager prints their decisions in their own colour — most of the village
happens where you are not, and this is the window onto it.

```js
LG.llm.transcript     // the records, newest last
LG.llm.dump()         // the lot as plain text, for copying out
LG.llm.audit = false  // stop printing (recording continues)
LG.game.thoughts = false   // stop printing villager decisions
```

## How it fits together

```
index.html
css/style.css
js/logbook.js    ships everything the village does to the log server
js/time.js       the calendar: hours, seasons, and what the weather is doing
js/data.js       languages, phrasebook, gossip lines, ~140 items, 17 places, 13 villagers
js/chain.js      generates a solvable errand chain + the facts that describe it
js/llm.js        provider abstraction, key validation, JSON extraction from replies
js/tts.js        casting voices and speaking lines (ElevenLabs)
js/world.js      tile map, collision, pathfinding, interiors, all the canvas drawing
js/sky.js        the hour, the season's colour, and whatever is falling
js/view.js       one villager as they see themselves — the single assembly
js/npc.js        wandering, meeting each other, character/bubble rendering
js/dialogue.js   prompt building, the conversation UI, trades
js/save.js       the one save format: snapshot, restore, and both places to put it
js/game.js       state, main loop, input, notebook, settings
tools/logserver.js  serves the game, hands over .env, collects the log, keeps the save
tests/smoke.js      runs the whole game headlessly and checks it still works
```

Plain `<script>` tags and a global `LG` namespace — no modules, no bundler, so it runs by
double-clicking. Everything learnable is a fact with an id, dealt out by `chain.js` — the
holder of a fact always knows it, plus a few others, and the spread scales with the
population, so doubling the village does not make every rumour twice as hard to find.
Nothing reaches the notebook except by being said out loud.

## Tests

```sh
node tests/smoke.js            # build a village and tick it for 100 seconds
node tests/smoke.js --prompts  # print every villager's prompt for one fixed village
```

The tests run the real game: `smoke.js` loads every script in the order `index.html`
loads it, into a fake browser, and drives it with no API key — so what is being checked
is the code that ships, not a copy of it. Diffing `--prompts` between two checkouts is
the only reliable way to know a refactor left the model looking at the same words. The
chain generator is fuzz-tested on top of that: 900 random chains across all three
difficulties, checked for solvability, no self-trades, no duplicate villagers, a
reachable terminal item, and no orphaned facts.

## Reading further

- **`DESIGN.md`** — why the village works the way it does: the prompt wording that turned
  out to matter, the bugs that produced each rule, and what is deliberately left loose.
- **`OLD-LI.md`** — the afternoon three villagers believed in a rice merchant who did not
  exist, reconstructed from the log.
- **`IDEAS.md`** — where this could go next.
