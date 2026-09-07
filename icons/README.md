# Icons

Everything here is rendered from three SVGs at the repository root. The SVGs
are the source; these PNGs are output, and are checked in because a page needs
them at load time and the project has no build step to make them on demand.

| source | output | what it is for |
| --- | --- | --- |
| `icon.svg` | `icon-192.png`, `icon-512.png` | the manifest's `purpose: "any"` icons |
| `icon.svg` | `apple-touch-icon.png` (180) | iOS, which reads this before it reads the manifest |
| `icon-maskable.svg` | `icon-maskable-192.png`, `icon-maskable-512.png` | the manifest's `purpose: "maskable"` icons |
| `favicon.svg` | `favicon-16.png`, `favicon-32.png`, `favicon-48.png` | a browser with no SVG-favicon support, which in practice is none of them |

## Why two drawings of the same villager

A home screen icon is looked at from further away than a tab is. `icon.svg`
has room for the whole scene — Petra bottom left, a speech bubble top right
saying 文A — and `favicon.svg` crops in on her, because at sixteen pixels the
full figure is four pixels of purple and a speck of hair.

## Why two versions of the app icon

Android crops a `maskable` icon to a shape it picks — a circle, a squircle,
a rounded square — and only guarantees the centre 80% circle survives.
`icon.svg` deliberately overflows that circle so the drawing fills the frame
on every platform that doesn't crop; `icon-maskable.svg` is the same drawing
at 0.7x on the same field, sized to survive the crop. Declaring both lets each
launcher take the one it can use.

## Regenerating

Any SVG rasteriser gives the same result — the files carry no external
references and 文A is outlines rather than text, so no font has to be
installed. With librsvg:

```sh
rsvg-convert -w 512 -h 512 ../icon.svg -o icon-512.png
```

or with ImageMagick, `magick -background none ../icon.svg -resize 512x512
icon-512.png`. The set above was rendered through headless Chromium, which
agrees with both.
