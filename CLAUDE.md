# Notes for working on Little Village

## Pull requests

**Include screenshots in every PR that changes anything you can see** — the
HUD, a panel, the map, a log line, a new language string. Show the change in
the game, not just the code: before and after if something changed, and the
village's language rather than English where it matters (a string that is
fine in English can be wrong in Russian or Arabic). A PR with no visible
change can say so instead.

There's a template in `.github/pull_request_template.md` with a place for them.

**Once a PR is open, keep it current.** When you push a change to its
branch that's worth new screenshots — anything a player would see or hear
differently — add a comment to the PR with them, saying what changed. The
description shows the PR as it was opened; the comments are how a reviewer
follows it since. Sounds can't play inline on GitHub, so link the audio
file.

### Hosting the images

GitHub has no API for attaching an image to a PR or comment. Commit them to
the branch under `.github/pr-screenshots/`, link them by that commit's hash
(`https://github.com/<owner>/<repo>/blob/<sha>/.github/pr-screenshots/x.png?raw=true`),
and remove them again in the next commit, so they never reach the tree.

### Taking one

There's no build step, so a static server and headless Chromium are enough:

```sh
python3 -m http.server 8765    # from the repo root
```

The game stays behind the API-key screen (and hides the HUD) until a key is
set. For a screenshot, a placeholder key in the saved settings skips it — no
request needs to succeed:

```js
await page.goto('http://localhost:8765/');
await page.evaluate(() => localStorage.setItem('lg-settings',
  JSON.stringify({ apiKey: 'sk-placeholder', provider: 'openrouter', lang: 'ru' })));
await page.reload();
```

From there `LG` is on `window`: `LG.ledger.give('hat', 1)` fills your pockets,
`LG.game._debugPlayerAt(x, y)` moves you (pixels; tiles are 32px), and
`page.locator('#invBox').screenshot(...)` crops to one part of the screen.

## Tests

`node tests/smoke.js` runs headless with no API key and is what CI runs.
Villages are random per run, so run it a few times before trusting a pass.
