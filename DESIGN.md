# Design notes

Why the game works the way it does: the decisions and invariants that aren't obvious from
the code, and the bug behind each one. The README covers what the game is and how to run
it. Read the relevant section before you change a prompt or a mechanic. Most of these
rules exist because the obvious version was tried first and broke.

Most bugs in this project have been in the gap between what the model returned and what
the game made of it, or in a prompt sentence that did something other than what it said.

## General rules

- **One source of truth.** Every duplicated thing has drifted: three copies of a
  villager's prompt, five furigana instructions, three answers to "is this lead spent".
  If two callers want different amounts of something, put the numbers side by side in
  one table.
- **Log the raw reply**, before parsing or repair. The tidied version hides the bug.
- **Fail loudly.** A refusal that nobody is told about is worse than the bad action it
  prevented. The villager and the player should both be able to see what the game did.
- **Records beat rules.** Give a villager the ledger or the dated fact, and let them
  reason from it. Don't add another instruction to weigh.
- **Don't name a failure mode in a prompt.** The model fixates on the salient word
  ("do not force it into every reply", "terse is fine"). State the positive behaviour
  instead. Exceptions exist where it was measured to help (the toki pona `grammarNote`
  in `js/data.js`), and they are documented at the call site.
- **The world may write on a villager only what they saw first-hand.** Anything they
  learn by report goes through their own reasoning.
- **Don't put answers in the villager's mouth.** No scripted lines, no mandated
  feelings, no conclusions they didn't reach themselves. The model will pass a supplied
  conclusion on as fact. `OLD-LI.md` has the rice-merchant incident, where one invented
  answer spread to three villagers.

## Movement: villagers decide where to go

- A model picks each villager's destination from a named list of places. It sees their
  goal, what they know, their recent memories, the hour and weather, where they are, and
  **who they've seen and where**, so "go find Sanna" is expressible. The decision goes to
  Jev on OpenRouter and to the helper model on Logfare (see below).
- It's asked only when something changes (arrival, hour, weather, new information), with
  a cooldown (`DECIDE_COOL` in `js/game.js`). If there's no key or the call fails, it
  falls back to the old probability table (`PHASE_TABLE` in `js/npc.js`), so the village
  never freezes.
- Recent memories are included on purpose. Without them, six villagers heard that rice
  was for sale nearby and none acted on it.
- **Open is not reachable.** Some of Ilya's woods patch is walled-in clearings, so a
  villager tries several random spots in the target patch before giving up. A test
  checks that every villager can reach every patch they can be sent to, and every
  generated village is flood-filled to check each door has a path to it.
- Mikhalych's rice hut exists because a villager once hallucinated it (`OLD-LI.md`).

## Jev: fixed-choice questions (OpenRouter only)

TypeSafe's Jev (`typesafe/jev-1.13`) takes `{state, questions}` and returns one named
option per question, with a probability. It's billed on input tokens only. It uses
OpenRouter's decisions endpoint (`decisionPost`/`askJev` in `js/llm.js`), not
`/chat/completions`, so it can't be offered as a main or helper model.

- It handles three jobs: where a villager goes (`intent` → `decideByJev`), whether a
  trade completed (`confirmTrade` → `confirmTradeByJev`), and which self-reported facts
  a line actually stated (`judge` → `judgeByJev`). All three are fixed questions with a
  fixed set of answers.
- It's used automatically whenever `provider === "openrouter"` and a key is present.
  There's deliberately no setting. Opt-in toggles meant almost nobody used it. Each
  function checks the provider itself, and Logfare gets the helper-model version.
- Tradeoffs accepted: Jev returns no text. Movement loses its "why" (the console prints
  only the destination), and confirmed facts get no player-language note.
  `verifyRevealed` already falls back to the line as spoken when a note is missing.
- `judge` sends one question per candidate fact in a single request.

## Villager-to-villager conversation

- **One call per line, and each villager writes only their own lines.** When one call
  wrote both halves, it read like a script. Each turn gets that villager's persona,
  their news, and the transcript so far.
- It runs everywhere, not just on screen, on the helper model: two conversations at a
  time (`CHAT_PARALLEL`), about 2.8 s per line (`turnHold`), and a queue so a busy green
  doesn't burst. A meeting goes stale after `CHAT_STALE` if the pair walks apart, and is
  dropped (`js/dialogue.js`).
- Each villager is told where they are, why they came, and whether they came looking
  for this person. The old prompt told everyone they were "on their way somewhere", and
  seven of 22 lines in one session were people telling each other to go home.
- The prompt states the situation and stops. It has no instructions on how conversation
  works ("react to what they said"), which read as stiff.

## Prompt wording

- **Removed and not to be re-added:** "do not force it into every reply", "you are not
  reading from a list", "this is a conversation, not a monologue", "never sound like a
  telegram", "be patient with broken grammar" (now it just states that the traveller's
  grammar is rough), and mandated feelings ("accept it joyfully"). A persona supplies
  its own feelings.
- **Removed: "If you do not know, suggest who might."** Villagers can't know who else
  knows, so this invited made-up referrals.
- **`prompt` vs `register`** (per difficulty). `prompt` is *accommodation*, how a kind
  native talks to a learner, and it's only for talking to the player. `register` is for
  villager-to-villager talk. It names only vocabulary and sentence complexity, never who
  is being addressed, and it's empty at advanced. The beginner register once ended "the
  way you talk when you are not thinking about it", which beat the plain-words clause
  and produced idiom-heavy gossip.
- **Villagers may say something simpler.** The player-facing rule allowed easier words
  and shorter sentences, and forbade broken grammar. Without permission to change what
  they're saying, beginner villages produced constructions like 把…带回来. The rule
  now explicitly allows that.
- No "use whatever tense" (Chinese has no tense). No named levels like A1 or HSK 1, which
  would put a syllabus in the villager's mouth.
- Villager-to-villager lines must be "the way a real speaker would actually say it out
  loud". The rule says nothing about length. "terse is fine, ungrammatical is not" made
  them terse and produced 黄昏冷？.

## Villager prompt assembly

- `js/view.js` is the **single** assembly of "who this villager is and what they know".
  All three callers (player dialogue, villager chatter, movement) render parts of it.
  Deliberate differences in how much each caller includes sit together in one table.
  Separate copies drifted before, and a villager read their own opinion in the third
  person.
- The player-facing reply is JSON: `say`, translation, romanisation, `understood`,
  `revealed`, `remember`, and an optional trade `action`.
- **Stock is a prior, not a manifest.** A baker plausibly has a pain au chocolat. The
  only hard inventory is what the villager actually took from the player.

## Structured output and reply parsing

- **Use a JSON Schema where supported** (OpenRouter `response_format`). When hedges like
  *OPTIONAL* and *[] if none* were on every field except `say`, a third of replies came
  back as bare `{"say": …}`.
- Support is per endpoint. It's looked up once at connect time from
  `supported_parameters` (`js/llm.js`) and cached. **Fail closed:** OpenRouter rejects a
  schema sent to an unsupported model, so anything unknown is treated as unsupported
  and gets prompt-based JSON plus repair.
- The prompt's field list and the schema are rendered **from one array**. Every field is
  required. Optional ones are nullable, and "nothing happened" is spelled `null`, `[]`,
  or `"none"`. The log records whether each call was schema-checked.
- The parser strips fences, repairs common breakage, and falls back to pulling out
  fields by hand. It **never shows raw text**. An unreadable reply becomes a failed
  turn, never a brace in a speech bubble.
- If the translation contains non-Latin script (`looksEnglish`, `js/dialogue.js`), it's
  discarded and the helper model re-glosses the line.

## Furigana

- One spec, `LG.FURIGANA` (`js/data.js`), shared by every prompt that asks for it. Its
  example includes an okurigana word (`<ruby>結<rt>むす</rt></ruby>ぶ`). With only a
  bare 漢字 example, models wrote 結ぶ[むすぶ].
- The bracket convention (`糸[いと]`) is converted rather than fought: kanji followed by
  bracketed kana becomes ruby, and okurigana is split back out. Other brackets are left
  alone.
- Ruby markup is sanitised to bare `ruby/rb/rt/rtc/rp` tags, and everything else is
  dropped. When a line has kanji but no ruby, the helper model fills it in. The repair
  is validated by stripping the readings and checking the text is unchanged, with one
  retry, and a give-up is reported.
- Wrong readings (だいこう for 大工) are **not** caught, since a smaller model wouldn't
  judge readings better. The prompt asks for whole-word readings in a single pass.
- `say` carries the ruby inline, so the line and its readings can't disagree.
- Furigana goes in dialogue (spoken) only. Item names, signs, and notices are written
  labels, so they stay plain kanji.

## Logging and cost

- All API traffic goes through two functions in `js/llm.js`. Each call is logged in
  full: system prompt, messages, **raw reply**, reasoning (both providers return it in
  a separate field), model, latency, usage, and errors. It prints as a collapsed console
  group and goes to `logs/` via the log server.
- **Cost is tracked as villager vs helper.** Over 2.8 h of play, the main model made
  ~60 calls/h and the helper ~1,200/h, which put 3.5× more cost on the helper side.
  `tools/latency-report.js` uses the same split, by which model answered, so chatter
  counts as helper.
- The biggest cost lever is a non-reasoning helper: ~59 output tokens per call against
  ~1,863 for a reasoning model, on the same yes/no questions. Its tasks don't benefit
  from reasoning anyway.
- The console narrates each villager in their own colour: decisions (with the reason on
  Logfare), arrivals, what they learned and from whom, and off-screen conversations.

## Trade and the till

The till is each villager's ledger of sales, purchases, refunds, trades, and refusals,
with times and prices. It's shown as a ledger, not mixed into conversational memory.
Rules were removed in favour of it: a shopkeeper who can see she was paid for two
drinks and handed over one can work out the rest herself. Only schema facts stay as
rules, such as `item` accepting a list.

Each of these was a bug first:

- **Multi-item sales.** `item` is a list and `price` is the total. When the price cap
  trims a price, the villager is told.
- **No double sale.** The same goods from the same villager on the very next turn after
  a completed sale are refused and logged to the till (Tomas sold two knives for one
  agreement). A repeat later is allowed. The prompt rule is conditional too: coins pay
  for things not yet handed over.
- **The till shows counts** ("knife ×2"). Without them, Tomas wouldn't take back the
  second knife.
- **Refund by gesture.** Holding out an item the till says they sold you asks for a
  refund. If the reply agrees but flags `action: "none"`, `confirmOffer` →
  `confirmTrade` catches it.
- **Villagers take back what they sold**, at the price paid, once, and only items they
  actually sold you. Their `buys` list doesn't cover their own stock.
- **Bought goods become stock.** The villager is told what they're holding and can
  resell it.
- **An explicit price of 0 is not a sale.** It's narration, and the haggle band used to
  round it up to one coin.
- **Closed hours.** Trade is shut in the small hours. The villager is told they're shut
  before they offer, and a sale claimed anyway is refused into the till. Notes state
  what the till did, not what the villager should say. A silent refusal once let
  Mikhalych sell tea twice at midnight with no effect.
- **Tell the villager what the till did**, in coins, including the player's remaining
  balance and every refusal reason. Otherwise they do arithmetic from half-memories.
- **Errand items can't be sold for coins.** Villagers decline this themselves. Otherwise
  selling a chain item was a silent dead end. Trading is unaffected.
- **A gesture is not a bargain.** Offering an item completes a trade only if the villager
  agrees. If the reply agrees but doesn't flag it, the helper model or Jev confirms.
  Interest, questions, and "later" all count as no.

## Finished exchanges

- A completed chain trade is written to both villagers' tills and stated as concluded.
  When it used to vanish from the prompt, villagers kept trying to finish it, and each
  attempt became a real transaction.
- A finished errand replaces the villager's goal with the generator's plain-work line,
  in all three callers. Otherwise Wren got his pig back and went on advertising a
  reward for it.
- That villager's chain facts about it retire too, only for the villager who was there.
  Anyone who was merely told keeps believing it until they learn otherwise.

## Villager beliefs

- **One knowledge list, and every line is dated and sourced:**
  ```
  - (a while now) [f0] Yuri is looking for a pair of shoes.
  - (10:27, from Olo) [f1] Mikhalych has a pair of shoes.
  - (14:31, from the traveller) Yuri took my shoes and never paid for them
  ```
  There's no rule that newer beats older. With dates, the model resolves conflicts
  itself. The old split into undated "what you know" and "what you picked up" left
  Mira unable to resolve a contradiction she had noticed.
- **Revision:** when new information arrives, from the player or another villager on
  equal terms, a reader may rewrite an overtaken line in its current form ("Yuri was
  looking for shoes, and has them now"). Chain facts keep their ids, because the
  notebook depends on them. It runs only when something new has arrived.
- **First-hand observation writes directly.** Handing an item over, or walking to a spot
  and finding it empty, updates belief. The memory records only what they saw ("you went
  in the graveyard yourself and there was no axe there"), never a conclusion such as
  "somebody took it".
- **`remember` asks for anything worth remembering**, with an explicit "nothing" value
  and a greeting as the worked example. When it was framed as "a new fact, if you
  understood them", a villager invented the player's name from こんにちは.
- **The notebook and villagers answer different questions.** The notebook shows whether
  something is true in the world, since the game keeps the player's side consistent. A
  villager believes what they've witnessed or been told. Don't let one answer the other.

## The notebook

- **Nominate, then verify.** A villager's reply nominates fact tags in `revealed`. The
  helper model or Jev checks them against the spoken line (`verifyRevealed`), after the
  reply is on screen, and fails closed. Self-reports alone flag facts the villager
  merely used a word from.
- **Whether a lead is spent is derived, never stored.** One predicate reads two one-way
  world facts (item collected, trade completed), and the notebook has no `done` field
  or saved flag. There used to be three separate answers, which disagreed. Spent leads
  are struck through, not deleted.
- **One note per fact.** `learn` guards with `hasNote` (`js/game.js`), and `restore`
  applies the same rule when loading a save, keeping the first occurrence.

## Names

- `LG.game.displayName` returns the villager's job until `nameKnown` is set. It's set
  only when **that villager** states their own name. Hearsay doesn't count.
- Detection is a regex over `reply.translation` (guaranteed English), run before any
  non-English blanking. There's no schema field or extra call, because a wrong answer
  is low-stakes.
- The dialogue header shows `?` rather than the job, because the job is already on the
  line below.
- **Villagers know each other.** Each one gets a roster of everyone's name, trade, and
  persona, but not their whereabouts (that's `folk`, from sight). An unknown neighbour
  was the same kind of gap that produced the rice merchant. Current news still has to
  travel. A name in someone else's speech doesn't set `nameKnown`.

## Gossip is just conversation

- Nothing is chosen to be passed on. Afterwards, the helper model reads the transcript
  and records what each villager took away. Chain facts move only if they were actually
  said, and only from a villager who held them. Both of these are tested. The old
  mechanic copied facts first and generated talk as a caption.
- As a result, gossip is lossy, and a pair can part having learned nothing. That's
  intended.
- **Overheard talk** reaches the event log only when the player is nearby. It's shown in
  the village language, and the gloss stays blurred **even with translations on**,
  because overhearing is a comprehension test.

## Noticeboard

- It's not scripted. A villager who chooses to visit the board is asked whether they
  want to post anything, and "nothing" is fine. A notice can be anything: a complaint,
  gossip, the errand.
- Chain facts in a notice are nominated and verified, the same way as `revealed`.
- Notices sit in `state.board` (max `BOARD_MAX`). A fact reaches the notebook only when
  the player reads the notice (E).
- No furigana, because notices are written text.

## Difficulty

Chain length is 4–7 at every level. It was the wrong knob, since longer chains spread
more facts around. Difficulty controls who knows what: spread per fact, a taper that
hides the tail of the chain, and how much Petra (the gossip) knows. Petra used to know
everything at every level. The README has the table.

## Map

- **Forest (north ~2/5).** Six of `LG.PLACES` are glades, so about a quarter of errands
  end in the woods, which makes the one fact you can act on alone take effort. Density
  is value noise at two scales multiplied into a base rate, thinning over the last 8
  rows toward the village. A test pins tree cover at 40–75%.
- **Reachability, in order of trust:** glades are cleared outright, tracks are carved
  after trees are placed, and `openTheWay` (`js/world.js`) flood-fills from the start
  tile and cuts a path to anything stranded. It has never had to act. Keep it anyway.
  Track fraying only adds walkable tiles, so it can't break connectivity.
- **Railway halt (east edge)** is where the player starts, at the far end of the high
  street. The line is solid.
- The 40-row southward shift was verified by a harness diffing every deliberately placed
  tile and rectangle. It found a latent bug: the woodcutter's trees could paint over
  pond water, depending on the hash. That's guarded now.

## Old-save migration

- Saves from before the map shift are migrated, not refused. The shift was uniform (+40
  tiles in y), so every point and rectangle gets the same offset (`js/save-migrate.js`).
- **Seeds depend on list order.** `pick(LG.PLACES, rnd)` reads only the index, so growing
  `LG.PLACES` from 17 to 24 entries changed the terminal item for unchanged seeds. Old
  villages are regenerated against `PLACES_V1_IDS` via `withPlaces`, which swaps the
  global for one synchronous call and restores it in `finally`.
- "Needs the old list" is a property of the **seed**, not the file version. It's stored
  as `_placesV1` on the plan and written into `village.placesV1` by **every**
  `snapshot`. Keying it on file version broke the second load of a migrated save.

## Weather and rendering

- **No overlay most of the time.** The hour tints the world. Season doesn't, and neither
  does most weather. Only fog, monsoon, thunderstorm, blizzard, and sandstorm darken the
  screen, which leaves it clean about 83% of the time (asserted in tests).
  Villager sheltering is a separate switch from darkness, because drizzle is worth
  sheltering from but barely shows.
- Rain and snow are clipped out of building footprints (even-odd clip). Fog and haze are
  not.
- **Snow depth is its own state.** It builds while snowing, holds in a hard frost, and
  melts at a seasonal rate. It's drawn on ground, canopies, fence tops, and roofs; the
  pond freezes and the fountain stops. Streets hold the least snow so paths stay
  readable, and roofs never go fully white. The depth is included in villager prompts.
- **Ground snow is one field, never per-tile shapes.** Depth sets a level on a map-wide
  noise field; the snowline is traced at 4 px (marching squares) and joined into closed
  loops through the grid edges the pieces share (`traceLoops` in `js/world.js`). Per-tile
  blobs printed the grid onto every thaw as polka dots. Props read the same field; ponds
  ice over as one sheet; floors are forced bare so no drift shows when a roof lifts.
- **Snow is cheap to trace and fill.** Only tiles the line crosses are traced, into
  typed arrays; a piece per cell was tens of thousands of shapes, ~10 ms a fill in
  Firefox. The drift lip is the path filled again 2 px lower, not a canvas shadow
  (Firefox draws shadows through an offscreen pass, ~20 ms a repaint). Don't
  `closePath()`: in Chrome it costs ~100× a `lineTo`.
- **Snow isn't a clean cut-out.** Drifts cover their own tiles and spill 0–9 px over a
  street's edge, roughened by noise; stopping on the tile edge read as paper. More spill
  (or blurring which tiles hold snow) swallows the one-tile forest paths. A faint relief
  shading (half resolution) breaks up deep snow.
- **The snow field is precomputed.** Its samples depend only on the map, so they're built
  once, visible tiles first and the rest in 4 ms background slices. Computed as tiles
  came into view, the first step into new ground stuttered.
- Each new village starts on a random day of the year, always mid-morning.
- In rain, snow, or sand, villagers prefer their workplace or home.
- Villagers indoors are hidden unless the player is in the same room. The player's room
  is read from their feet, not their tile, because the tile disagrees for the top
  pixels of a room.
- **Batch canvas paths.** Firefox for Android stopped honouring `beginPath` at around
  13k paths/s, and tree canopies joined into horizontal bands. Now each colour is one
  path, with an explicit `moveTo` onto each circle's rim before its `arc`, so a dropped
  `beginPath` still can't join circles. Ground-pass fills went from 166 to 26. Passes
  keep the old in-tile order (trunk, canopy, highlight, snow), which is safe because
  tiles don't overlap. Snow crowns are stamped from one sprite per tenth of depth.
- **Sprites blit one texel per device pixel, at whole device pixels.** Stretched by a
  fraction, which edge column survived depended on float noise in the layer's position,
  so two paints of the same tree disagreed.
- **The ground layer scrolls.** When the camera leaves it, the painted layer is slid onto
  a spare canvas and only the newly exposed strip is painted, clipped, from two tiles
  further out (`scrollGroundLayer` in `js/game.js`). Full repaints every 96 px were the
  walking stutter, worst in the forest. A snow-depth change (every ~0.6 s while it
  snows) repaints one band a frame over six frames. Anything the layer draws must depend
  only on `refreshGroundLayer`'s keys, or a strip will disagree with what's beside it.
- **Profile in Firefox, not just Chrome.** The user plays in Floorp, whose software canvas
  rasterises on the call. Chrome hid a 45–70 ms snowy repaint that Firefox felt. The
  vignette is a CSS gradient over the canvas: filled into it every frame it cost Firefox
  ~5 ms at 1900×1350.

## Touch and mobile layout

Desktop is unchanged: the joystick draws only while a finger is down, the HUD folding is
inside the narrow-screen media query, and gestures bind only to non-mouse pointers.

- **Drag to walk, tap to act** (`js/touch.js`). A touch stays undecided until it moves
  `DEAD` (12 px, a walk) or lifts within `TAP_MS` (320 ms, a tap). A stationary long
  press does nothing. Only the first finger can become the stick. If it lifts, a second
  finger takes over.
- **The stick origin is pinned**, and the knob clamps at `RANGE`. A trailing origin
  crept across the screen. The ring stays drawn at zero deflection.
- Keys and stick add into one vector, normalised only above 1, so keyboard diagonals
  are unchanged and a half-pushed stick walks at half speed.
- A tap has the same reach as E. An out-of-reach tap says "walk over to the baker"
  rather than doing nothing.
- The hint text follows the last input type, starting from `(pointer: coarse)`, and is
  published as a `<body>` class.
- **Don't autofocus the dialogue input on touch.** The keyboard would cover the card.
- **Overlay sizing uses `visualViewport`** (`trackViewport`, `js/game.js`), because
  keyboards overlay the page rather than resizing it. It sets `cramped`/`tight` classes
  on `<body>` by visible height (`CRAMPED` 460, `TIGHT` 320). Size is decided by height,
  not focus: tapping **Say it** blurs the input while the keyboard stays up. The canvas
  isn't resized.
- **When cramped, the composer never shrinks.** The chrome and conversation give up
  space first, then the phrase trays drop to one scrolling row, then they're hidden.
- Focusing the input on touch **only collapses** the trays, never expands them, so it
  can't fight the height rules. Tapping the conversation dismisses the keyboard and
  restores the trays.
- Trays fold with a grid row going `1fr` → `0fr` (`.tray-in` is the row child), not
  `display:none` or `max-height`. They're set to not flex-shrink, because
  `overflow:hidden` let flexbox crush them.
- **Stick to the newest line.** A `ResizeObserver` keeps the conversation scrolled to the
  bottom through any resize, if the reader was already within `ANCHOR` px of it.
- **Keyboard height hysteresis.** Suggestion strips resize the viewport on every word.
  While typing, an increase smaller than `KB_ROW` (96) is ignored. A larger increase that
  doesn't reach full height waits `GROW_MS` (220 ms), to ride out the keyboard's opening
  animation overshoot. A return to full height is believed immediately. "Keyboard up"
  means more than a row below the tallest height seen at this width. Rotation resets
  that. This applies to touch only. Blur falls back to the real measurement.
- Firefox Android can delay `visualViewport` events, so focusing a text box schedules
  rechecks (`FOCUS_RECHECK_MS`).
- **Inputs use 16px longhand font properties.** `font: 16px/1.4 inherit` is invalid
  CSS, so it was silently dropped and inputs fell back to 13.3px monospace. 16px is the
  size below which mobile browsers zoom in on focus, and it also sets the `textarea`'s
  intrinsic width. The composer is a grid with a `minmax(0,1fr)` column, so the button
  never gets clipped.
- **The page never pans under a finger.** `touch-action` can't express this, because
  `none` on an ancestor disables scrolling for all its descendants. Instead, on
  `touchstart`, walk up from the target looking for something that can genuinely
  scroll. If nothing can, block the move. Two-finger pinch is always allowed.
- **Frame the camera to the visible band.** The HUD uses `--vv-top`/`--vv-h`, like the
  dialogue card. The camera centres the player in `seen()`, which is the visual
  viewport minus safe-area insets, read from `#safe`'s padding because `env()` can't be
  queried from JS. The canvas still paints edge to edge. The band is frozen while a
  keyboard is up or the page is pinch-zoomed.

## Saving

- **One format** (`js/save.js`: `snapshot`/`restore`), written as the same bytes to
  `localStorage` and `saves/village.json`. Either works without the other. On load, the
  local copy restores instantly, and the server copy wins only if it's newer.
- **Only the seed is stored**, plus a digest of the generated village. If the digest
  doesn't match, the save is refused with an explicit message, because notebook fact
  ids would no longer mean the same facts. Changing the generator therefore invalidates
  saves, unless you add a migration (see above).
- In-progress state isn't saved: routes, bubbles, pending decisions, conversations.
  Villagers re-think on load.
- **Exception: who is chasing the player** (and why) *is* saved and always restored.
  `newVillage` treats every load as an arrival, so Petra kept running to meet a train
  from days ago. The chase route itself is recomputed.
- No API keys go in the save. They live in `lg-settings`. Language and difficulty are
  saved, because the village is generated from them.

## Log server

`tools/logserver.js` serves the page (providers reject `file://`), collects logs, hands
over `.env` keys, and stores the save.

- It does not make keys safer, because they still end up in the browser. It does not
  proxy API calls, so the game still works as a plain static page.
- It binds to `127.0.0.1` only, refuses `/env` to non-local connections, and won't serve
  dotfiles or `logs/`.

## Voices

- ElevenLabs Flash v2.5 (`js/tts.js`): lowest latency among the multilingual models, and
  it matters because lines never repeat, so nothing can be cached. Voices are
  cross-lingual, so a villager keeps their voice when the language changes.
- Voices are cast at load from the account's voice list. The curated categories
  (`premade`, `professional`) are preferred, with a fallback so nobody is left mute.
  Scoring puts **quality first** (category, `high_quality_base_model_ids`, a
  `verified_languages` match for the village language, share count), then
  distinctness, then the written gender and age. Every field is read defensively.
- Speed is 0.75× at beginner and 0.95× at advanced. A new line cancels the previous one,
  including an in-flight request.
- **Test this key** shows ElevenLabs' own 401 detail. The usual cause is a missing
  `voices_read` permission.
