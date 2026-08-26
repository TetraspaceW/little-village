# Flag rendering: matching the local flag-emoji style

`LG.LANGUAGES.ar` needs a flag for the Arab League, which — unlike every
other language here — isn't a country, so it has no Unicode regional
flag sequence and no glyph in any emoji font. This directory renders one
by hand, in the same waving-cloth style the rest of the flags already
get from the system's Noto Color Emoji font, and packages it as a tiny
custom font glyph so it can drop into `#setLang`'s plain `<option>` text
exactly like a real flag emoji does.

## Why this isn't a guess

Noto Color Emoji's wavy flag look isn't a filter to reverse-engineer —
Google's `noto-emoji` project ships the actual program that generates
every flag glyph: `waveflag.c`. It rasterizes a flat flag, warps it
through a fixed 8-point Cairo mesh (the same wave shape for every flag,
aspect-ratio adjusted), stamps a soft-light shading gradient through the
same mesh, and downsamples. It's deterministic — not learned, not
approximated.

`waveflag.py` is a line-for-line Python port of
[`waveflag.c`](https://github.com/googlefonts/noto-emoji/blob/main/waveflag.c)
from Google's `noto-emoji` project (pycairo instead of libcairo+a C
compiler, so it runs without installing `libcairo2-dev`/build tools).
It carries the original Apache 2.0 header plus a note on what changed,
per the license's terms — see the file itself. If Google ever changes
the algorithm, that URL is what to diff against.

### Validation

Before trusting the port on a flag with no ground truth (the Arab
League), it was checked against two flags that do: the real glyph
bitmaps were extracted directly out of the CBDT color-bitmap table of
an installed `NotoColorEmoji.ttf` (system font, e.g.
`/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf` on Ubuntu) —
that's literally the same PNG data the font displays, not a
screenshot. `validation/GB_real.png` and `validation/YT_real.png` are
those extracts (UK, and Mayotte — which has its own local-arms design
rather than France's flag, a useful edge case). `validation/GB_src.png`
and `validation/YT_src.png` are the flat source flags, pulled from the
exact same `third_party/region-flags` directory noto-emoji's own build
uses, so the comparison is apples to apples.

Run `python3 validate.py` to re-check: it renders the two `_src.png`
flags through `waveflag.py` and diffs against the two `_real.png`
extracts. Mean per-channel difference comes out to ~0.2–0.3 (out of
255) — PNG-quantization noise, not a modeling gap.

The rendering itself was validated this way once; the *font packaging*
was validated separately, in both target engines, and needed three
passes to get right — see `build_font.py`'s docstring for the two
format issues that testing (not assumption) turned up. Check any
future change to it in both headless Chrome and headless Floorp, not
just one — a font that looks right in one can be silently blank in the
other with no error either side, which is exactly what happened twice
here.

## Licenses of what's sourced here

- `waveflag.py`: **Apache 2.0** (Google Inc., 2014) — it's a derivative
  of Google's `waveflag.c` (see above). Full text in
  `LICENSE-APACHE-2.0.txt`.
- `validation/*`: flat source flags are from noto-emoji's
  `third_party/region-flags`, **Public Domain**
  (see https://github.com/googlefonts/noto-emoji/blob/main/third_party/region-flags/LICENSE).
  Used only for this validation step, not shipped as a game asset.
- `sources/arab-league.svg`: Wikimedia Commons, uploaded by user Flad,
  **Public Domain**
  (https://commons.wikimedia.org/wiki/File:Flag_of_the_Arab_League.svg).
  Tagged with an "insignia" note on Commons — a caveat some countries
  attach to official emblems regardless of copyright status, not a
  license restriction.
- Note the *font/glyph data* Noto Color Emoji itself ships under is a
  **different** license (SIL OFL 1.1) from the Apache 2.0 code above —
  nothing here copies that font or its artwork, only the (separately,
  Apache-licensed) algorithm that builds it, applied to independently-
  sourced, public-domain flag art.

## Regenerating / adding another flag

```
python3 waveflag.py path/to/flat-flag.png output.png
# WAVEFLAG_SIZE=512 for a larger render (default 128, the native emoji size —
# the flag texture itself is capped at 256x256 internally either way, so
# sizes much above that gain smoother wave edges/shading, not extra detail)
```

Input must be a PNG (rasterize an SVG source first, e.g. with
`cairosvg` or `resvg`). Then to turn a render into a font glyph:

```
pip install nanoemoji resvg-cli   # resvg-cli must end up on $PATH
python3 build_font.py output.png ../../fonts/ArabLeagueFlag.ttf
```

`../fonts/ArabLeagueFlag.ttf` was built this way. Non-obvious things
`build_font.py` handles, all found by testing the actual result in
both browser engines rather than assuming it was right:

- It builds the glyph *twice*, once as `cbdt` (the format Noto Color
  Emoji itself uses, and this project's first attempt) and once as
  `untouchedsvg` (OpenType's `SVG ` table), then merges the CBDT/CBLC
  tables into the SVG-table build so one font file carries both. Each
  alone looked right in one engine and was silently blank — no error,
  just nothing drawn — in the other: CBDT only renders in Chromium
  (Firefox has no CBDT support at all), and the SVG table only renders
  in Firefox for *our* content, because Chromium's OT-SVG
  implementation doesn't paint a raster `<image>` inside a glyph (it
  recognizes the table, it just won't draw that). A font can carry
  both color tables at once and each engine uses the one it
  understands — confirmed by testing the merged file directly in
  headless Chrome and headless Floorp.
- nanoemoji auto-adds a glyph for U+0020 (space) sized to match
  whatever glyph you gave it — here, the full flag's width. Left in,
  it hijacks every space character anywhere this font-family is in
  the stack (see the .panel-card select bug this caused, below), so
  the script strips that cmap entry from both builds before merging.

The codepoint `U+F0000` (Supplementary Private Use Area-A) is not a
real emoji sequence — it's a private-use codepoint this project made
up so the glyph can sit in ordinary text via `@font-face` +
`font-family` fallback. See `css/style.css` and `js/data.js` for how
it's wired in — including two more gotchas found the same way:
Chromium renders a `<select>`'s closed/collapsed box using the
*select element's own* computed font, not its selected `<option>`'s,
so the font-family has to go on `#setLang` itself and not just its
options; and the font is inlined as a `data:` URI in the CSS rather
than loaded from `fonts/ArabLeagueFlag.ttf` via `url()`, because
Chromium blocks that cross-directory @font-face load under `file://`
even though same-directory css/js load fine there, and this game is
meant to run by double-clicking `index.html`, not just from a server.

## Known limitation: Gecko's open dropdown list

In Firefox/Floorp on Linux, the Arabic (MSA) row showed the correct
flag in `#setLang`'s closed box but a "no glyph found" placeholder (a
box with the codepoint's hex digits) in the *open* dropdown list. This
wasn't a font bug to chase further: Gecko's `<select>` popup on this
platform renders through a more native-widget-like path that doesn't
consult page-authored `@font-face` fonts for `<option>` text at all —
confirmed by the placeholder itself, which is what Firefox draws when
literally no font (page or system) has a glyph, not what it draws for
a font-loading or table-format problem. No `--color_format` choice
fixes that, because the popup isn't asking this font in the first
place, and neither would replacing the native `<select>` with a custom
dropdown — considered, but a bigger change than this warrants.

The actual fix is in `js/data.js`: on Gecko (sniffed by the `Gecko` +
`rv:` pair MDN recommends, not a bare `"Firefox"` check, since the bug
is a property of the engine and should hit any Gecko fork), `ar`'s
flag falls back to the plain Unicode Saudi Arabia flag instead of the
custom glyph. A real Unicode flag is drawn by the platform's own emoji
font rather than a page-authored one, so it has no gap in the popup —
confirmed working in both the closed box and the open list. Not
accurate to the Arab League, but a real flag beats a broken one, and
this only ever applies on the one engine where the custom glyph can't
be made to work at all.
