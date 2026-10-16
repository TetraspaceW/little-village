# Notes for working on Little Village

## Pull requests

**Include screenshots in every PR that changes anything you can see** — the
HUD, a panel, the map, a log line, a new language string. Show the change in
the game, not just the code: before and after if something changed, and the
village's language rather than English where it matters (a string that is
fine in English can be wrong in Russian or Arabic). A PR with no visible
change can say so instead.

There's a template in `.github/pull_request_template.md` with a place for them.

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
