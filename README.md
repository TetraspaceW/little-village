# Little Village

A small browser game. Six people live in a village, none of them speak your language,
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

Two models are used per session: the one you pick plays the villagers, and Haiku 4.5
fact-checks notebook entries. The fact-check only fires when a villager nominates a
fact, and its prompt is a few hundred tokens, so it is a rounding error next to the
dialogue itself.

The village speaks Russian, English, Chinese (Mandarin), Japanese, French or Spanish,
at three difficulties. Chinese, Japanese and Russian lines come back with a
romanisation under them.

## Playing

- **WASD / arrow keys** to walk, **E** or **Space** to talk to whoever you're next to.
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
js/data.js       languages, phrasebook, the item pool, places, the six villagers
js/chain.js      generates a solvable errand chain + the facts that describe it
js/llm.js        provider abstraction, key validation, JSON extraction from replies
js/world.js      tile map, collision, all the canvas drawing
js/npc.js        wandering, the gossip exchange, character/bubble rendering
js/dialogue.js   prompt building, the conversation UI, trades
js/game.js       state, main loop, input, notebook, settings
```

Plain `<script>` tags and a global `LG` namespace — no modules, no bundler, so it
runs by double-clicking.

**Everything learnable is a fact with an id.** `chain.js` deals facts out to villagers
— the holder of a fact always knows it, plus a couple of others, and one villager is
the designated gossip who knows everything. Nothing reaches the notebook except by
being said out loud.

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

**Trades can't deadlock.** If you physically hold out the right item the trade
completes whether or not the model emits the action, so a confused reply can't strand
the quest chain.

**Gossip costs nothing.** When two idle villagers pass each other they swap one fact
id each, no model call involved. A rumour that starts with one villager really does
reach the others, and you can hear it from whoever it reached.

`IDEAS.md` has notes on where this could go next.
