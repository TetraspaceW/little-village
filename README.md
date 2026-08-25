# Little Village

A small browser game. Thirteen villagers live in a procedurally generated village
and none of them speak your language. To get anything done you have to talk your
way through a chain of favours and trades.

Villagers are played by a language model: they remember what you tell them and
pass it on to each other.

**Requires an API key** from [Anthropic](https://console.anthropic.com) or
[OpenRouter](https://openrouter.ai/keys).

<!-- TODO: screenshot or GIF here -->

## Quick start

```sh
cp .env.example .env         # add your API key(s)
node tools/logserver.js      # open http://localhost:8787
```

This one process serves the game, hands your `.env` keys to the page, keeps a
save file, and writes a log — no separate setup needed. It binds to
`127.0.0.1` and won't serve `.env` or `logs/` to non-local requests. `.env` is
read once at startup; restart after editing it. `PORT` is also read from
`.env`, and an exported `ANTHROPIC_API_KEY` overrides the file.

### Without Node

There's no build step and no dependencies, so any static file server works:

```sh
python3 -m http.server 8000  # open http://localhost:8000, paste a key in-game
```

Opening `index.html` directly (`file://`) works for browsing, **but not with
an API key** — browsers send `Origin: null` for local files, and the
providers' CORS rules reject that. The game detects this and tells you at
the settings screen rather than failing partway through a conversation.

## Controls

- **WASD / arrow keys** — walk. **E** / **Space** — talk to whoever you're next to.
  Bindings are physical-key based, so they work under any keyboard layout.
- Type in the villager's own language. The **Phrases** row suggests something
  to start from; **Offer an item** holds an item out of your pockets instead
  of typing.
- Translations can show immediately or stay blurred until clicked (⚙ →
  settings).

## Gameplay

- **Errands.** Each village generates a chain: someone wants an item, whoever
  has it wants something else, and so on back to something just lying in the
  world. The village name (bottom of the notebook) is the seed — the same
  name regenerates the same errand.
- **Language only.** Villagers don't understand English and can't be talked
  into anything in it. Holding an item out to them works regardless of
  language, but doesn't complete a trade by itself — they still have to
  agree.
- **Notebook.** Starts empty. A fact only appears once a villager actually
  tells you it, in the language they told it to you in, with an English
  gloss underneath. Leads you've already followed show struck through.
- **Money.** You start with ¤10. A villager at their own counter, in daytime,
  will buy and sell — the baker sells bread, the smith sells tools, and so
  on. Prices are fixed per item with a haggling band either side. Villagers
  won't trade at night, away from their counter, or for a link of the errand
  chain.
- **Interiors.** Walking through a door lifts the roof off that building, and
  villagers who went inside are visible to you but not to anyone outside.
- **Autonomy.** Villagers move and talk to each other on their own schedule —
  busiest around midday, home by dark — whether or not you're nearby. If
  you're close enough to overhear, the exchange (in their language, with a
  blurred gloss) shows up in your event log.

## Connecting a model (⚙ button)

| Provider | What you need |
|---|---|
| **Anthropic** | A key from [console.anthropic.com](https://console.anthropic.com). Calls `api.anthropic.com` directly from the browser. |
| **OpenRouter** | A key from [openrouter.ai/keys](https://openrouter.ai/keys). |

The key is validated with a small request at connect time, and stored in
`localStorage` — sent only to the provider you picked, readable by anything
else with access to your browser profile. Rotate it if that's a concern. The
`.env` route above only saves you pasting it; the key still ends up
client-side either way.

### Two models

- **Main model** — plays the villagers directly, one call per line said to
  you.
- **Helper model** — smaller/cheaper, runs everything else: confirming which
  facts a villager actually revealed, deciding what two villagers took away
  from a conversation, filling in missing furigana, confirming trades, and
  choosing where each villager goes. Defaults to Haiku 4.5 on either
  provider; also selectable on OpenRouter: MiMo-V2.5, MiMo-V2.5 Pro, Gemma 4
  31B, Gemini 2.5 Flash, GPT-4.1 mini, GLM-5.2, or any other model
  ID via the **Other** field.

Use a fast, non-reasoning model for the helper if you can — see below.

### Cost

Measured over 2.8 hours of logged play:

| | calls/hour | input tok/hour | output tok/hour |
|---|---|---|---|
| Main model (lines said to you) | ~60 | ~90k | ~30k |
| Helper model (everything else) | ~1,200 | ~520k | ~380k |

At reference pricing of $3/$15 per million tokens for a Sonnet-class main
model and $1/$5 for a Haiku-class helper, that's **~$0.70/h + ~$2.40/h ≈ $3/h
total** — the helper, not the dialogue, is most of the bill.

The single biggest lever is whether the helper reasons before answering: a
reasoning model wrote ~1,863 output tokens per call in these logs against
~59 for a non-reasoning one, on the same yes/no questions, on the calls that
make up 95% of traffic. Pick a quick, literal-minded helper. (Prompt caching
doesn't help here — helper prompts run a few hundred tokens, below the usual
minimum cacheable prefix, and differ per villager per call.)

Actual cost scales with how busy the village is (560–1,880 calls/hour across
logged sessions) and with the day-length setting. On OpenRouter, `usage.cost`
comes back on every call and is already in your session log, so:

```sh
jq -s 'map(.usage.cost // 0) | add' logs/session-*.jsonl
```

gives you the real figure for a real session. Anthropic's API returns token
counts only, not a cost figure.

### Structured output

Where a provider supports it, replies are constrained with a JSON Schema
(`output_config.format` on Anthropic, `response_format` on OpenRouter) rather
than just requested in the prompt. Support is checked per model when the key
connects; anything unrecognised falls back to prompt-based JSON with repair.

## Languages and difficulty

The village speaks Russian, English, Chinese (Mandarin), Japanese, French, or
Spanish, at three difficulty levels. Russian and Chinese lines carry a
romanisation; Japanese gets furigana over kanji in dialogue (via `<ruby>`
tags — not on item names, which stay plain kanji).

Chain length is randomised (4–7 links) at every difficulty. What changes with
difficulty is who knows what:

| | Beginner | Intermediate | Advanced |
|---|---|---|---|
| Villagers told each fact (beyond the owner) | 4 | 2 | 1 |
| The village gossip (Petra) knows | the whole errand | about half | only opinions |
| Villagers per fact, on average | ~5.0 | ~2.0 | ~1.5 |

Fact-holders also thin out further down the chain the harder the difficulty,
so a longer chain buries its tail instead of exposing it. At advanced you
generally have to walk the chain in order.

## Voices (optional)

Tick "let the villagers speak aloud" and add an ElevenLabs key to give each
villager a voice, cast at load time from whatever your account has,
matched for quality and distinctness. This is a third, independent key —
without it, the village is silent.

- Speech is slowed by default (0.75× beginner, 0.95× advanced) for
  intelligibility.
- Lines play as they arrive; a new line interrupts the previous one.
  Every line keeps a 🔊 replay button.
- **Test this key** lists the voice assigned to each villager with a preview
  button (no credits used), and reports the exact ElevenLabs error if the key
  is rejected — usually a missing `voices_read` permission.
- Only curated voices are cast by default; a setting opens casting to your
  whole account.

## Time and weather

Thirty days per season, four seasons per year, monsoon climate: cold/dry
winter with blizzards, mild spring with sandstorms, hot/wet summer with
monsoon rain and thunderstorms, cooling autumn with fog and drizzle. A day is
six minutes by default (adjustable). Each new village starts on a random day
of the year, so you may arrive in any season or weather.

Weather affects the world directly rather than as a screen overlay: rain
stops at building eaves, snow accumulates and melts over real time, and only
the weather types that actually reduce visibility (fog, monsoon,
thunderstorm, blizzard, sandstorm) darken the scene. Villagers know the date
and weather, comment on it, and prefer to be indoors when it's wet.

## Saving

The village autosaves every 20 seconds, on major events (a trade, an errand
completed, a new village), and on tab close. Reopening the page restores the
same afternoon — seed, time, weather, snow, inventory, notebook, and every
villager's memory.

Save data is one JSON object, written identically to `localStorage` and to
`saves/village.json` (if the log server is running) — a save from either
location loads in the other.

```sh
node tools/logserver.js
# ... play ...
cat saves/village.json | python3 -m json.tool | head
```

From the console: `LG.save.restore(JSON.parse(text))` to load a save someone
sent you, `LG.save.snapshot()` to export the current one. There's no
separate import/export format. Saves store the village's seed rather than
its full state, and are rejected (with an explanation) if the generator has
changed since the save was made.

⚙ → **Forget the saved village** clears both copies. **Start a new village**
overwrites them immediately.

## Logs and debugging

With the log server running, every session writes to
`logs/session-<timestamp>.jsonl`, one JSON object per line:

- every API call — system prompt, messages, raw reply, exposed reasoning,
  token usage, latency, `max_tokens` truncation;
- every villager decision — where they went and why, what they learned, what
  they said.

The terminal shows a live one-line summary per entry. If the log server
isn't running, the game detects this on first write, disables logging, and
continues normally.

The browser console mirrors this live: each API call prints as a collapsed
group, and each villager's decisions print in their own colour.

```js
LG.llm.transcript          // full call records, newest last
LG.llm.dump()               // all of it as plain text
LG.llm.audit = false         // stop console logging (recording continues)
LG.game.thoughts = false     // stop printing villager decisions
```

## Project structure

```
index.html
css/style.css
js/logbook.js       ships everything the village does to the log server
js/time.js           calendar: hours, seasons, weather
js/data.js           languages, phrasebook, gossip lines, ~140 items, 17 places, 13 villagers
js/chain.js          errand chain generator + associated facts
js/llm.js            provider abstraction, key validation, reply parsing
js/tts.js            ElevenLabs voice casting and playback
js/world.js          tile map, collision, pathfinding, interiors, canvas rendering
js/sky.js            hour/season colour, precipitation
js/view.js           per-villager prompt assembly (single source of truth)
js/npc.js            villager movement, meetings, rendering
js/dialogue.js       prompt building, conversation UI, trades
js/save.js           save format: snapshot/restore, both storage locations
js/game.js           game state, main loop, input, notebook, settings
tools/logserver.js   serves the game, exposes .env, collects logs, keeps the save
tests/smoke.js       headless test of the full game
```

Plain `<script>` tags, no bundler — `index.html` runs by double-clicking.
Facts are dealt out by `chain.js` with an id each; a fact only reaches your
notebook if a villager actually says it out loud.

## Tests

```sh
node tests/smoke.js            # build a village, run it for 100 simulated seconds
node tests/smoke.js --prompts  # print every villager's system prompt for a fixed seed
```

`smoke.js` loads the actual scripts in the order `index.html` does, so it's
testing shipped code, not a copy. `--prompts` output is useful to diff across
commits to confirm a refactor didn't change what the model sees. The errand
generator is separately fuzz-tested: 900 random chains across all three
difficulties, checked for solvability, no self-trades, no duplicate
villagers, a reachable terminal item, and no orphaned facts.

## Further reading

- [`DESIGN.md`](DESIGN.md) — design rationale: why prompts and mechanics ended
  up the way they did, and the bugs that shaped each decision.
- [`OLD-LI.md`](OLD-LI.md) — a specific incident, reconstructed from the log:
  three villagers came to believe in a rice merchant who didn't exist.
- [`IDEAS.md`](IDEAS.md) — possible future directions.
