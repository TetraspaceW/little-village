# Notes for working on Little Village

## Looking at the game

There's no build step, so a static server and headless Chromium are enough:

```sh
python3 -m http.server 8765    # from the repo root
```

The game stays behind the API-key screen (and hides the HUD) until a key is
set. A placeholder key in the saved settings gets past it — no request
needs to succeed:

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
