#!/usr/bin/env python3
"""Wraps a waveflag.py render into a one-glyph @font-face-able font.

Builds a *hybrid* color font carrying two separate color tables for the
same glyph — CBDT/CBLC (Noto Color Emoji's own format, and the one
Chromium/Blink renders) and an OpenType "SVG " table (the one Firefox/
Gecko renders). Neither format alone covers both engines:

- cbdt only: correct in Chrome, blank in Firefox — Firefox has no CBDT
  support at all.
- untouchedsvg (SVG table) only: correct in Firefox, but blank in
  Chrome too — Chromium's OT-SVG implementation does not paint a
  raster <image> inside a glyph (it recognizes the table, just doesn't
  render its content), and our content is fundamentally a raster
  (waveflag.py's mesh-warped, shaded PNG), not vector paths.

A font can carry both tables at once; each engine is specified to use
whichever it understands. Tested directly in headless Chrome and
headless Floorp with the same file — both render it correctly.

nanoemoji also auto-adds a glyph for U+0020 (space) sized to match
whatever glyph you gave it — here, the full flag's width. Left alone,
that makes the custom font hijack every space character wherever its
font-family is in the stack, blowing up letter-spacing on unrelated
text (see css/style.css's #setLang rule, which needs this font on the
whole <select> as well as its <option>s). This script strips that cmap
entry from both builds before merging.

Requires: pip install nanoemoji resvg-cli   (resvg must end up on $PATH)

Usage:
  python3 build_font.py flag.png output.ttf [--codepoint 0xF0000] [--family "Arab League Flag"]
"""
import argparse
import base64
import subprocess
import os
import tempfile
from fontTools.ttLib import TTFont


def _build_one(svg_path, color_format, family, tmp):
    out = os.path.join(tmp, f"{color_format}.ttf")
    subprocess.run(
        ["nanoemoji", "--color_format", color_format, "--family", family,
         "--output_file", out, svg_path],
        check=True, cwd=tmp,
    )
    f = TTFont(out)
    for tbl in f["cmap"].tables:
        tbl.cmap.pop(0x20, None)  # see module docstring
    return f


def build(png_path, out_path, codepoint, family):
    with open(png_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    with tempfile.TemporaryDirectory() as tmp:
        svg_path = os.path.join(tmp, f"emoji_u{codepoint:x}.svg")
        with open(svg_path, "w") as f:
            f.write(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
                f'<image width="128" height="128" href="data:image/png;base64,{b64}"/>'
                "</svg>"
            )

        cbdt_font = _build_one(svg_path, "cbdt", family, tmp)
        hybrid = _build_one(svg_path, "untouchedsvg", family, tmp)
        assert hybrid.getGlyphOrder() == cbdt_font.getGlyphOrder(), \
            "glyph order mismatch between the two builds — merge would corrupt them"
        hybrid["CBDT"] = cbdt_font["CBDT"]
        hybrid["CBLC"] = cbdt_font["CBLC"]
        hybrid.save(out_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("png")
    ap.add_argument("out_ttf")
    ap.add_argument("--codepoint", type=lambda s: int(s, 0), default=0xF0000)
    ap.add_argument("--family", default="Arab League Flag")
    args = ap.parse_args()
    build(args.png, args.out_ttf, args.codepoint, args.family)
    print(f"wrote {args.out_ttf}")
