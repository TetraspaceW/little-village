#!/usr/bin/env python3
"""Re-checks waveflag.py against the real Noto Color Emoji glyphs.

Renders validation/GB_src.png and validation/YT_src.png through
waveflag.py and diffs the result against validation/GB_real.png and
validation/YT_real.png — bitmaps extracted directly out of the CBDT
table of an installed NotoColorEmoji.ttf (see README.md for how). A
mean per-channel difference in the low single digits (out of 255) is
PNG-quantization noise, not a mismatch; this is what confirms
waveflag.py reproduces the real pipeline rather than approximating it.

Usage: python3 validate.py
"""
import subprocess
import sys
import tempfile
import os
import cairo

HERE = os.path.dirname(os.path.abspath(__file__))


def diff(mine_path, real_path):
    mine = cairo.ImageSurface.create_from_png(mine_path)
    real = cairo.ImageSurface.create_from_png(real_path)
    mw, mh = mine.get_width(), mine.get_height()
    rw, rh = real.get_width(), real.get_height()
    # the real glyph's strike is padded to 136x128 (extra horizontal
    # margin); ours renders at the flag's own 128x128, so center-align
    xoff = (rw - mw) // 2
    mbuf, mstride = mine.get_data(), mine.get_stride()
    rbuf, rstride = real.get_data(), real.get_stride()
    total = 0
    n = 0
    for y in range(mh):
        for x in range(mw):
            mo = y * mstride + x * 4
            ro = y * rstride + (x + xoff) * 4
            for c in range(4):
                total += abs(mbuf[mo + c] - rbuf[ro + c])
                n += 1
    return total / n


def check(name):
    src = os.path.join(HERE, "validation", f"{name}_src.png")
    real = os.path.join(HERE, "validation", f"{name}_real.png")
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        subprocess.run([sys.executable, os.path.join(HERE, "waveflag.py"), src, tmp.name],
                        check=True)
        d = diff(tmp.name, real)
        print(f"{name}: mean abs diff/channel = {d:.3f}  {'OK' if d < 3 else 'SUSPECT'}")
        return d < 3


if __name__ == "__main__":
    ok = all([check("GB"), check("YT")])
    sys.exit(0 if ok else 1)
