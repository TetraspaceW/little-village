# Little Village

A small browser game. Thirteen people live in a village, none of them speak your language,
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

## Watching what it actually does

```sh
node tools/logserver.js      # then open http://localhost:8787
```

```sh
cp .env.example .env         # then fill in your keys
```

One process that serves the village, keeps its log, keeps its save, and hands over your
keys. Serving it over http is
needed anyway — the providers reject `file://` origins — and doing both from the
same place means there is no CORS to arrange and nothing to switch on.

Everything lands in `logs/session-<when>.jsonl`, one JSON object per line:

- **every API call**, whole — the system prompt, the messages, the raw reply
  before any parsing, the model's own reasoning where it exposes any, the token
  usage, the latency, and whether it was cut off at `max_tokens`;
- **every villager decision** — who wondered where to be, where they went and
  why, when they arrived, what they learned and from whom, what they said.

The reasoning is the half worth having. A villager talking themselves into
something daft does it in the reasoning, and it was being dropped on the floor:
both providers return it in a field of its own, which nothing was reading.

The terminal shows a terse line per entry as a live view. If the log server is
not running the game notices on its first post, switches logging off and carries
on — so it is never a dependency, only a window.

**And it reads `.env`,** the ordinary way: at launch it merges the file into the
process environment without clobbering anything already set, so
`ANTHROPIC_API_KEY=… node tools/logserver.js` beats the file without editing it.
Loaded once — restart to pick up a change. `PORT` works from there too. The game asks for a key at the front door
because a web page cannot read a file off your disk. A server can, so when this
one is running the door is already open: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` and
`ELEVENLABS_API_KEY`, plus optional `LG_PROVIDER`, `LG_MODEL`, `LG_HELPER`,
`LG_LANG` and `LG_LEVEL`. The settings panel says where a key it did not ask you
for came from. Without the server, or without a `.env`, nothing changes and you
paste as before.

Two things this deliberately does not do. It does not make the keys any safer —
they still end up in the browser, which is where they lived anyway; this saves
the pasting, not the trust. And it does not proxy the API: the page still calls
the provider directly, so it keeps working as a plain static page. Routing the
calls through the server would keep the keys server-side and moot CORS entirely,
which is strictly better security and strictly worse for opening `index.html`.

The server binds `127.0.0.1` only, refuses `/env` to anything that is not a local
connection, and will not serve dotfiles or `logs/` as static files — otherwise
serving the directory that contains `.env` would hand it to anyone who guessed
the name.

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

**One spec, in one place.** The model was being asked for furigana in five separate
places — the villager's own prompt, a second rule further down that same prompt, the
villager-to-villager call, the notebook fact-checker, and the repair helper — each
worded differently, and four of the five illustrating it with the bare word 漢字. That
example never shows what to do about okurigana, which is exactly where it broke: 結ぶ
has no obvious single-tag form, and with nothing to copy the model fell back to writing
結ぶ[むすぶ]. All five now share `LG.FURIGANA`, whose worked example carries an okurigana
word on purpose and shows the reading split across the tag boundary
(`<ruby>結<rt>むす</rt></ruby>ぶ`).

**And the bracket convention is accepted anyway.** 糸[いと] is not a malfunction — it is
how furigana is written in plain text everywhere — so rather than keep insisting, it is
converted. A run of kanji followed by a bracket containing nothing but kana becomes ruby
markup; where the word has okurigana the reading is split back off it, so 結ぶ[むすぶ]
becomes `<ruby>結<rt>むす</rt></ruby>ぶ` rather than putting むすぶ over the whole word.
Anything that is not kanji-then-kana-in-brackets is left exactly as it was, so ordinary
brackets in a sentence survive.

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

A village day is six minutes by default (adjustable), and the calendar is rolled with
the village: every new village is a fresh arrival on a random day of the year, so you
may well turn up in a blizzard. The hour is not rolled — you always arrive mid-morning,
because arriving at three in the morning with nobody out of doors is no way to start.
Villagers know the date and the weather and will remark on it.

**Villagers decide where to go.** This was a probability table — morning meant a 60%
chance of work, a 30% chance of the green — which made everyone a dumb NPC in a game
whose whole premise is that they are not. A villager who wanted a saw more than anything
never went looking for one. A villager who had just been told the baker has bread did
not walk to the bakery. The fact graph and the movement system did not know each other
existed.

The decision goes to the helper model now, and it gets what a person would have: their
own goal, what they know, the hour and the weather, where they are, **who they have seen
about the village and where**, and the places they could go. That last one matters more
than it looks — knowing Sanna has the pack of cards is worth nothing if there is no way
to express going to find Sanna. They answer with somewhere to be and a few words of why.

**Every call is on the record.** All API traffic funnels through two functions, so that
is where it is audited: each call is kept whole — the system prompt, the messages, the
**raw reply before any parsing or repair**, the model, the latency and the token usage —
and printed as a collapsed console group you can open and read. Failures are records too,
with the error where the reply would be, rather than a gap in the log.

Raw is the point. Nearly every bug in this project has lived in the space between what
the model returned and what the game made of it — a missing quote, furigana in brackets,
a two-item sale rung up as one — and a log of the tidied-up version would have hidden all
of them.

```js
LG.llm.transcript   // the records, newest last
LG.llm.dump()       // the lot as plain text, for copying out
LG.llm.audit = false  // stop printing (recording continues)
```

**Open the console and you can watch them think.** Every decision comes back with a
reason, and for a while nothing did anything with it — which made the difference between a
villager reasoning and a villager rolling dice invisible from the outside. Each one prints
a line tagged in their own colour: what they wondered, where they decided to go and why,
when they arrived, what they learned from whom, and what they said to each other out of
your earshot. Most of the village happens where you are not, and this is the only window
onto it. `LG.game.thoughts = false` turns it off.

**What they hear reaches what they do.** A villager deciding where to go used to be
given the facts the errand generator dealt them and nothing else — not what they had
picked up by talking. So six villagers could learn that rice was for sale two minutes'
walk away and none of them could act on it, and the village spent an entire afternoon
discussing a bowl of rice that was on offer the whole time. Their recent memories go into
the decision now, alongside their own business.

They are asked only when something has changed — they arrived, the hour turned, the
weather broke, they learned something — so a settled villager costs nothing, and there is
a cooldown so a busy village cannot spin. With no key, or when a call fails, the old
table is still there as a fallback, so the village never stands still.

**Snow settles, and then it lies there.** The weather is what is falling; snow that
has fallen is a separate number that builds while it snows, holds through a hard frost,
and melts at a rate the season sets — a winter can stay white across three changes of
weather, and a thaw takes a couple of minutes rather than a frame. It is not a white
wash over the finished picture: the ground goes white in drifts that spread and join
up, trees carry it on the canopy and keep their green underneath, fences and benches
and gravestones take it along the top, the pond goes to ice and the fountain stops
running. What holds it least is the streets, which are walked all day — under the
deepest fall the lanes are still there as pale bands through the white, because a
village you cannot navigate is worse than a village that is not quite white enough.
Roofs take it first and hold it longest, but never all the way: eleven identical white
rectangles is not a village either. Villagers can see it too — the depth goes into
their prompt, so a clear morning over a white village does not have them talking as
though the snow had gone.

**They keep hours too.** The pull of the village green rises to midday and thins by
dusk; at night everyone is home, and nobody stands about on the green in a blizzard.
When two of them meet they stop, turn to face each other, and actually talk — a real
back-and-forth of four to six lines, not a canned exchange.

The prompt for these gives the villager their situation and gets out of the way. It
says who they are, who they have run into, what they have been meaning to mention, what
has been said so far, and that they are both on their way somewhere — and then stops.
It does not tell them to react to what the other one said rather than talk past them,
which is instructing a competent actor in how conversation works and reads exactly as
stiffly as it sounds.

The player-facing prompt got the same pass. Gone from it: *"do not force it into every
reply"* after an instruction to remark on the weather (naming a failure mode is a good
way to get it), *"you are not reading from a list"*, *"this is a conversation, not a
monologue"*, *"never sound like a telegram"*, and *"be patient with broken grammar"* —
replaced by simply stating that the traveller's grammar is rough, which lets a warm
villager be warm about it and a brisk one be brisk. Mandated feelings went too: a chain
role used to say *"accept it joyfully and press a compass on them"*, which fights the
persona of a shopkeeper written as never giving anything away.

One of those was a correctness fix rather than a stylistic one. The prompt used to end
*"If you do not know, say so and suggest who might"* — but a villager has no way of
knowing who else knows, so that is an invitation to invent a name. With facts now
concentrated by difficulty, an invented signpost sends you across the village to
somebody who genuinely cannot help.

The one that mattered most was the level. Each difficulty carries a `prompt` written as
*accommodation* — "speak the way a kind native speaker speaks to someone on their first
day" — which is right when a villager is talking to you and absurd between two
villagers, where it has Mira addressing Boris as though he were learning his own
language. Villager-to-villager talk uses a separate `register` line instead, which
describes how plainly they speak rather than who they are speaking down to. At advanced
it is empty: two natives with nobody to accommodate simply talk.

**But overhearing is a mechanic, not scenery.** The beginner `register` ended *"— the
way you talk when you are not thinking about it"*, which is an instruction to be
unguarded, and it beat the plain-words clause in front of it every time: a beginner
village gossiped in 蔫了, 白拿人家东西 and 回头再聊. What a register constrains is the
words and the sentences, so that is all it names now. Who they are speaking to stays
out of it, which is the whole reason it is not `prompt`.

**A third way to simplify.** The player-facing rule offered two — easier words, shorter
sentences — and then forbade the only other thing a model might try, breaking the
grammar. That is the right thing to forbid and the wrong place to stop: where the
natural phrasing of a thought needs a construction a beginner has no chance with, both
permitted moves fail, and a beginner village asked for a pig back with 把…带回来 and
offered a reward with 谁…就谁 — correct, short, and nowhere near a first day. What was
never said is that the villager may simply say something else. They are not translating
a fixed sentence; they are a person with something to get across, and choosing an easier
thing to say is what a kind speaker actually does.

Gone with it: *"use whatever tense the sentence actually needs"*. Tense is an
Indo-European frame — Chinese has aspect and complements and no tense at all — so the
clause constrained nothing and left *"simple grammar"* to be satisfied by a short
sentence. No level is named in any of this on purpose: naming A1 or HSK 1 would put a
syllabus in the villager's mouth, and they are not teachers.

**A rule about grammar, not about length.** Villager-to-villager lines had no equivalent
of the rule that keeps the player-facing ones from turning into telegrams, so a character
written as *deliberate* produced 黄昏冷？ — which is not a sentence anyone says. The rule
now reads *"say it the way a real Chinese (Mandarin) speaker would actually say it out
loud"*, and says nothing about length on purpose: the first attempt ended *"terse is fine,
ungrammatical is not"*, where "terse" is the most salient word in the sentence and a clause
meant to permit brevity reads as an instruction to be brief. How long a villager's
sentences are belongs to their character; whether they are sentences does not.

**They are where they chose to be.** The conversation prompt used to say "you have run
into X" and, further down, that they were both on their way somewhere — asserted of
everyone, always, including two people who had each walked somewhere on purpose and
arrived. Reading a real session's log, the cost was plain: seven of twenty-two lines were
people telling each other to go home. Now a villager is told where they are, what brought
them there, and whether they came looking for this particular person — so Boris, who
chose to go after Mira about the pie, opens like someone who did that.

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

**The hut at the east end was a hallucination first.** Mira the baker, asked where you
could buy rice and having no idea, invented a rice merchant at the east end of the
village on the spot — and within twenty seconds two other villagers believed in him and
one of them was setting off. Nobody could go: the place did not exist, and a villager
walks to a named place or nowhere. `OLD-LI.md` is the whole account. The village now has
a hut out past the farmhouse with Mikhalych in it, who sells rice, so the answer she gave
is the true one. He keeps the habit that produced him: he does not say "I don't know".

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

## Coming back to it

The village writes itself down every twenty seconds, and again the moment anything
happens that would be painful to lose — a link of the chain traded, the errand
finished, a new village rolled — and once more on the way out of the tab. Open the
page again and you are back in the same afternoon: the same seed, the same day and
hour, the same weather and the same snow lying, your pockets, your notebook, the
deeds behind you, and thirteen people standing where you left them and still
remembering what you told them.

**One format, and only one.** It is a plain JSON object with a version on it, built by
exactly one function and read back by exactly one function, both in `js/save.js`. There
are two places to put it — this browser's `localStorage`, and `saves/village.json` if the
log server is running — and both are handed *the same bytes*. Nothing is converted at
either end, so the file on disk is a save a browser can load and what is in
`localStorage` is a save you can drop into the directory. That was the whole design
constraint: two sinks with their own idea of what a village is would have drifted the
way three copies of a villager's prompt once did.

Both are written together and neither is a dependency: no server is ordinary, and a
private window with no storage is ordinary too. On startup the local copy is read and put
back instantly, and the server is asked in the same breath — its copy wins only if it is
genuinely newer, which is what happens when you played in another browser, or cleared
this one, and is exactly when you would want it to.

```sh
node tools/logserver.js
# ... play ...
cat saves/village.json | python3 -m json.tool | head
```

Without a server there is still one file, it just lives in `localStorage`. Because it is
the same object either way, a save someone hands you loads from the console —
`LG.save.restore(JSON.parse(text))` — and the village you are in comes out of it with
`LG.save.snapshot()`. There is no import format to get wrong, because there is no import
format.

**What is in it, and what is not.** No API keys — the save is a file that gets written to
disk and copied about, and the keys stay in `lg-settings` with the other settings, where
they were. The language and the difficulty *are* in it, because the village is generated
out of them.

**The village is not stored, only its seed.** The generator is deterministic: the same
seed and difficulty give the same chain, the same cast, and the same facts under the same
ids — which matters, because your notebook is a list of those ids. So the save carries the
seed and a short digest of what the generator made from it, and the digest is checked on
the way back in. Change the generator and the digest stops matching, and the save is
refused *out loud* — "that village was built by a different version of the generator" —
rather than loaded on top of a chain whose fact ids no longer mean what the notebook
thinks they mean. That is the trade: saves are small and self-checking, and they do not
survive a change to how villages are built.

**What is deliberately not kept** is everything a villager was in the middle of: a route
being walked, a speech bubble, a decision the model had not answered yet, a conversation
with someone who is now somewhere else. All of that is about a moment that is over. They
come back thinking again, which they would have done within the minute anyway.

⚙ → **Forget the saved village** clears both copies. **Start a new village** overwrites
them, immediately rather than at the next autosave, so closing the tab straight afterwards
does not bring the old one back.

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

**A round of drinks is one sale.** A villager will happily say "beer and wine, that's
six" — it is the natural way to sell two things — so `item` takes a list and `price` is
the total for the lot. It used to be a single tag, which rang the whole thing up as one
item at the two-item price: you paid for the round and got the beer. The price cap then
made it worse by quietly trimming six coins to five, because five is the most a beer can
cost. When the cap does bite it now says so, since being charged a number nobody in the
conversation said is worse than either the villager's price or a refusal.

**Open is not the same as reachable.** The woods hold small clearings walled in by trees,
and Ilya the woodcutter lives among them — a third of the tiles in his own home patch have
no way into them. A villager aimed one dart at a random spot in the patch they wanted, and
when it landed in a clearing the path failed and they stood in the trees until their next
think. They try a handful of spots now before giving up on the idea, and a test checks that
every villager can reach every patch they can be sent to.

**A finished exchange stays finished.** When a chain trade completed, every trace of it
left the villager's prompt at once — the deal block vanished and nothing was written to
the till, so from where they stood the exchange had simply never happened. They went on
trying to finish it, and since the reply schema wants an action for anything that sounds
like a transaction, each attempt became one: Nadia said *"here's the shell, take it"* and
encoded *buy the shell*, and the game took it off the traveller. Trades are written to the
till now, both sides of them, and a concluded deal says so in words rather than going
quiet. Silence is not closure.

**And a spent errand stops being what they want.** Finishing a trade turned over the
deal block and nothing else. The goal sat next to it in the same assembly and did not,
and the deal block only ever reaches the player-facing prompt — so the two calls that
decide where a villager walks and what they say to each other were the two that never
heard the errand had ended. Wren got his pig back, handed the teapot over, walked to
the green to advertise the reward again, and asked where his pig was. A finished
errand now leaves a villager the same plain-work line the generator already writes for
everyone who never had a part in one, because that is what they are.

Their facts go with it. Facts are dealt once at the start and nothing ever took one
back, so Wren went on holding *Wren has a teapot* after trading the teapot away, and
said so out loud. They retire on the same rule that already retires the player's note
for that link — and only for the villager who was there. Anyone else who was told it
believes it until somebody tells them otherwise, the same way nobody who never walks
to the graveyard finds out the axe has gone; the memory left behind is how it travels.

**You cannot sell the errand.** Villagers will not buy a link of the chain off you for
coins, and they say so themselves rather than the game silently declining. Selling the
pie the baker is waiting for to the innkeeper for three coins used to be one click away,
and short of buying it back at her price with the coins she had just handed over, the
errand was over with nothing anywhere to say so. Trading is untouched — that is how the
chain is meant to move, and a trade always hands you something back.

**The shop shuts in the small hours, and now somebody mentions it.** Trade goes with a
villager all day, and only the small hours close it. That rule was enforced by refusing
the sale and telling nobody: Mikhalych took two coins for a cup of tea at midnight,
twice, described handing it over both times, and the game turned both down without a
word to either party — the tea never existed and neither did the payment. A villager
who is shut now knows they are shut before they offer, and if a sale is claimed anyway
the refusal goes into their till where they can read it.

What it tells them is that their trade is shut until morning, and then it stops. The
first draft of that line told them not to offer, not to name a price and not to take the
money, and added that they would like the custom — three failure modes named out loud
and a feeling issued to a character who came with one. The same rule applies to the
refusal notes: they say what the till did, not what the villager should say about it. A
note reading *"the traveller is carrying that for somebody, tell them they will need it"*
is a line written for someone whose whole job is writing their own, and it asserts
something about the traveller's business that the villager has no way of knowing.

**One sale does not go through twice.** Tomas agreed a knife for two coins and
flagged the sale on the turn he agreed it — *"you give me two coins, the knife is
yours"*, which is a bargain being struck rather than goods crossing a counter. The
traveller then held out the coins, which is the obvious thing to do when you have
just been told to, and the rule about that was unconditional: *holding out coins is
them paying you, take the money and hand the goods over*. He did. Two knives, four
coins, and a blacksmith who could not work out where the second knife had come from.

The rule is conditional now — coins pay for something you have not handed over yet,
and something the record already shows you were paid for is not being bought again.
But that is a matter of the model reading its own last sentence, so it is not the
whole fix: the same goods, from the same villager, on the turn straight after they
were handed over and paid for, is refused outright and the refusal goes in the till.
A repeat later is left alone, because wanting another knife tomorrow is an ordinary
thing to want.

**And the record says how many.** The ledger listed both sales and the line beside it
said *"still in their hands, from you: knife"* — one object, no count. So when the
traveller held a knife out, Tomas reasoned from his trade (*"I don't buy knives, I
make them"*) rather than from the two he had just sold, and refused the return three
times.

**A refund is a gesture too.** Holding out something a villager sold you is the
plainest way of asking for the money back. When he finally did understand, he
described taking the knife and returning the coins — and flagged `"action": "none"`,
so the traveller kept both knives and got nothing while the villager believed he had
settled it. That is the same failure `confirmOffer` was written for, on the other side
of the counter, and it is the same reader that catches it: offer back something the
till says they sold you, and if the line agrees to take it, the money moves.

**And nothing is exchanged for nothing.** An explicit price of zero is not a haggle, it is
a villager narrating rather than dealing — and the haggle band would quietly round it up
to a coin, which is how goods changed hands in a sale nobody meant to make.

**What a villager buys, a villager has.** Goods used to evaporate on the way in: Petra
bought an apple, it left the traveller's pocket, a coin came back, and then she went on
saying she had no apples — truthfully, because nothing anywhere recorded that she was
holding one. Villagers keep stock now, are told what is in their hands, and can sell it on
even when it is not the sort of thing they usually deal in.

**They take back what they sold you.** A villager's `buys` list is what they deal in as
a trade — the innkeeper buys fish, meat and wheat — and does not include their own stock,
so returning a beer she poured you five minutes ago found no price and did nothing at all
while she cheerfully announced the refund. What each villager has sold you is now
remembered, and comes back at what you actually paid rather than at a trade-in rate. The
same one cannot be returned twice, and a beer she never sold you is not refundable at all.

**The till is its own record.** What a villager has sold you, bought from you, refunded,
and every refusal, presented as a ledger with times and prices rather than folded into
their conversational memory — where, briefly, it was filed under *"what the traveller has
told you"*, which it plainly is not.

This is meant to replace rules rather than sit alongside them. Given the record, a
shopkeeper can work out for herself that she was paid for two drinks and handed over one,
and ask for the difference — the way anyone behind a counter would. The instruction
telling villagers that a return counts as a "buy" is gone, because `buy` is already
defined as taking something and paying for it and a refund is plainly that. What stays is
the schema itself: that `item` accepts a list is an API fact, not something to be
reasoned out.

**And the villager is told what the till did.** They used to remember only "the traveller
bought beer" — no price, no mention of the wine — so the next turn they did arithmetic
from a half-memory and insisted you had three coins when you had five. What goes into
their memory is now what actually happened, in coins, including what you have left. So is
every refusal — not enough coins, nothing in your pockets to hand over, not a thing they
deal in. Left to narrate unaided they describe the refund as done and are then baffled
when you offer the beer again, which is exactly what happened: *"I already took the beer
back! I gave you 2 coins back, remember?"*

**Every village is a new errand.** A chain is generated per playthrough: someone wants
a thing, someone else has it and wants something else, and the last link is something
lying out in the world or an animal that has wandered off. The village's name (bottom of the
notebook) is its seed — the same name always regenerates the same errand.

## How it fits together

```
index.html
css/style.css
js/time.js       the calendar: hours, seasons, and what the weather is doing
js/data.js       languages, phrasebook, gossip lines, ~140 items, 17 places, 13 villagers
js/chain.js      generates a solvable errand chain + the facts that describe it
js/llm.js        provider abstraction, key validation, JSON extraction from replies
js/world.js      tile map, collision, pathfinding, interiors, all the canvas drawing
js/sky.js        the hour, the season's colour, and whatever is falling
js/view.js       one villager as they see themselves — the single assembly
js/npc.js        wandering, meeting each other, character/bubble rendering
js/dialogue.js   prompt building, the conversation UI, trades
js/game.js       state, main loop, input, notebook, settings
js/save.js       the one save format: snapshot, restore, and both places to put it
tools/logserver.js  serves the game, hands over .env, collects the log, keeps the save
tests/smoke.js      runs the whole game headlessly and checks it still works
```

Plain `<script>` tags and a global `LG` namespace — no modules, no bundler, so it
runs by double-clicking.

**One villager, assembled once.** Three separate things ask a model to be a villager:
talking to the player, talking to another villager, and deciding where to stand. Each of
them used to build "who this is and what they know" from scratch, and the three copies
drifted — different slices of the same memory, different amounts of the same knowledge,
and a fix that only ever landed in one of them, so Mira read her own opinion of Wren in
the third person whenever the player was in front of her. `view.js` is the one assembly;
each caller renders the parts it wants, and where they deliberately want different
amounts the numbers sit together in one table so the next divergence is a decision rather
than an accident.

What it is *not* is an inventory. A villager's stock is a prior, not a manifest: the
baker has whatever a baker would plausibly have, and if the traveller asks for a pain au
chocolat then of course she has one. That looseness is the point and is passed through
untouched — the only hard fact is what she is holding because she took it off you, which
is the thing she used to deny having.

**The tests run the real game.** `node tests/smoke.js` loads every script in the order
`index.html` loads it, into a fake browser, builds a village and ticks it for a hundred
seconds with no API key — so what is being checked is the code that ships, not a copy of
it. `node tests/smoke.js --prompts` prints every villager's system prompt for one fixed
village; diffing that between two checkouts is the only reliable way to know a refactor
left the model looking at the same words.

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

**And where the model will take a schema, it is not asked nicely.** Reading one
session's logs turned up a third of the player-facing replies coming back as a bare
`{"say": …}` — no English, no pinyin — every one of them a courtesy or a
vocabulary gloss, which is to say every one a turn where the rest of the object was
at its empty value. The prompt was the cause: every field but `say` carried a hedge
(*OPTIONAL*, *only with sell or buy*, *[] if none*, *when in doubt leave it out*) and
nothing said any field was mandatory, so the object read as mostly-optional and the
tail got dropped. The villager-to-villager call, three fields and no hedges, was
complete eighty-four times out of eighty-four in the same session.

The prompt says which fields are never omitted now, and gives *nothing happened* a
spelling of its own. But the stronger fix is to stop it being a matter of judgement:
both providers will take a JSON Schema — Anthropic as `output_config.format`,
OpenRouter as OpenAI's `response_format`, which the router translates to whatever
backend it picks, so this is two branches rather than one per model.

**It is asked once, and it fails closed.** Support is per endpoint, not per model,
and OpenRouter *rejects* a request whose model has no structured outputs rather than
ignoring the field — so sending one blindly would turn a reply that merely arrived
thin into no reply at all. When the key is accepted the game looks the pair up —
`capabilities.structured_outputs` on Anthropic, `supported_parameters` on OpenRouter
— and remembers the answer. Anything it could not look up, could not reach, or does
not recognise counts as no. `stealth/ox-alpha` is exactly that case today: it takes
`response_format` for plain JSON mode but is not on the structured-outputs list, so
it gets the prompt and the repair, the way everything did before.

**The prompt block and the schema are one list.** They are rendered from the same
array of fields, so a field cannot be described to the villager and missing from the
schema, or typed one way and explained another — which is the drift that put three
copies of a villager's prompt out of step once already. Every field is required and
the optional ones are nullable rather than absent, because that is the one shape both
providers accept and it is also the shape the prompt describes: nothing is omitted,
and a turn with nothing to report says so with `null`, `[]` and `"none"`. Each entry
in the log records whether it was shape-checked or only asked.

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
(OpenRouter offers MiMo-V2.5, Gemini Flash, GPT-4.1 mini, GLM-5.2, Ox Alpha), with an **Other**
box for any id the picker does not list yet. Cheap and literal-minded beats clever
here; it is answering yes/no questions about a transcript.

**A lead you have already followed arrives ticked off.** The one thing in an errand
that stops being true while you play is the thing lying out in the world, because you
pick it up. The note saying where it was is struck through when you do — and if you find
it before anyone tells you about it, the note arrives struck through, rather than sending
you back across the village to fetch what is already in your pocket. It stays in the
notebook either way: a line that vanishes reads as a bug, and you lose the record of who
told you.

**One list, and it does not lie to them.** A villager used to read two: `# What you
know`, holding the chain facts flat, undated, under an instruction to say them as they
came up — and `# What you have picked up lately` for everything else, as though that
were a lesser kind of knowing. Neither said when anything had arrived or who had said
so.

That scaffold lies, and then the villager says the lie. Mira was told, as a plain
present-tense fact with no date on it, that *Yuri is looking for a pair of shoes* —
twelve minutes after the traveller had given Yuri the shoes and taken a compass for
them. She noticed, out loud: *"but that's odd, I heard Yuri is looking for shoes —
isn't he wearing shoes?"* She had understood the traveller, remembered it accurately,
and spotted the contradiction. Then she had nothing to resolve it with, because one of
the two claims was dressed as knowledge and the other as gossip and neither carried a
time.

Now there is one list, and every line says when they came by it and who from:

```
- (a while now) [f0] Yuri is looking for a pair of shoes.
- (10:27, from Olo) [f1] Mikhalych has a pair of shoes.
- (14:31, from the traveller) Yuri took my shoes and never paid for them
```

Nothing tells them that newer beats older or that a witness beats hearsay. They are a
language model playing a person, and a person holding a date on each of two claims does
not need to be told what to do with them.

**And they can change their mind.** A villager is not a table of rows to expire. When
something arrives that overtakes something they held, a reader offers them that one line
written the way it is true now — *Yuri is looking for shoes* becomes *Yuri was looking
for shoes, and has them now*, which is still worth passing on. The village should be
able to tell you the errand was run, not merely fall silent about it. A chain fact keeps
its id through this and gains their own wording; the notebook is built on those ids and
none of them move. It is asked only when something new has actually landed — from the
traveller or from another villager, on the same terms, because the player is not a
special kind of informant — and nothing overtaken is the ordinary answer.

**Where the world may write on them directly** is what they saw with their own eyes: a
villager who has just handed a teapot over knows they no longer have it, and one who
walked to the graveyard knows what was not there. That is the world being accurate about
itself, not the game doing their thinking. Everything that reaches them by report goes
through them.

**And the village finds out the same way you would.** Facts are dealt once, at the start,
so a villager told there was an axe in the graveyard would go on saying so all session.
Now, if they walk to the spot themselves and it is plainly not there, they stop believing
it and remember why — which they can then pass on. Nobody who never goes there ever finds
out, which is right: it is the difference between knowing and having looked.

What goes into their memory is what they saw: *"you went in the graveyard yourself and
there was no axe there"*. It first said *"somebody has had it away"*, which hands them a
theft they did not witness — and, this being the village where a baker's turn of phrase
became a rice merchant, a supplied conclusion is exactly the kind of thing that gets
passed on as a fact. They looked, and it was not there. What they make of that is theirs.

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

**There is no gossip mechanic.** There was one: two villagers in range each copied a
random fact id to the other, and *then* a conversation was generated to describe the
transfer that had already happened. The talk was a caption. If the pair spent the whole
exchange on the weather the fact moved anyway; if the call failed it moved anyway; a
villager could tell you something they had never been depicted as being told.

Now they just talk. Nothing is chosen to be passed and nothing changes hands during the
conversation. Afterwards the helper model reads what was actually said and notes what each
of them came away with. Ilya knows he has a dog; if the dog comes up, whoever he was
talking to now knows about the dog. If instead he talks about his back, that is what they
remember — and they do remember it, because what someone is like is worth keeping too. A
conversation that turns out to be nothing but weather leaves nothing behind, which is
right.

The errand chain still needs to know when one of its facts has genuinely travelled, since
the notebook is built on those ids. So the same call reports which of the speaker's own
facts were said out loud, and only those move. It is a record of what was said, not a
licence: a fact nobody mentioned does not travel, and a villager cannot pass on something
that was never theirs to know. Both are tested.

The consequence worth knowing about is that **gossip is now lossy**. Two villagers can
meet and part with nothing learned. That is how rumours work, and it is what makes the
free-text memories interesting rather than decorative — but it does mean a fact spreads
more slowly than it used to.

`IDEAS.md` has notes on where this could go next.
