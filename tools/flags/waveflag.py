#!/usr/bin/env python3
#
# Copyright 2014 Google Inc. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Google contributors: Behdad Esfahbod
#
# --- Modifications ---
# This file is a line-for-line port from C to Python (using pycairo
# instead of libcairo directly) of waveflag.c from the noto-emoji
# project: https://github.com/googlefonts/noto-emoji/blob/main/waveflag.c
# (retrieved 2026-08-26; check that URL if this ever needs re-syncing
# against upstream changes). Validated by extracting the real CBDT glyph
# bitmaps out of an installed NotoColorEmoji.ttf for GB and YT and
# diffing against this script's output on the same source flags (see
# validate.py): mean abs difference was ~0.2-0.3 per channel (out of
# 255), i.e. PNG-quantization noise, not a modeling gap.
# Ported 2026-08-26.
"""Renders a flat flag PNG into Noto Color Emoji's waving-flag style.

Usage: python3 waveflag.py input.png output.png
Set WAVEFLAG_SIZE (default 128, matching the native emoji glyph size)
to render at a different resolution — the geometry scales cleanly, but
note the flag texture itself is resampled to a fixed 256x256 internally
(the same cap the original algorithm has), so sizes much above 256 gain
smoother wave edges/shading but no extra texture detail.
"""
import sys
import math
import os
import cairo

SCALE = 8
SIZE = int(os.environ.get('WAVEFLAG_SIZE', 128))
MARGIN = 0

STD_ASPECT = 5. / 3.
TOP = 21
BOT = 128 - TOP
B = 21
C = 4

MESH_POINTS = [
    (1, TOP + C),
    (43, TOP - B + C),
    (85, TOP + B - C),
    (127, TOP - C),
    (127, BOT - C),
    (85, BOT + B - C),
    (43, BOT - B + C),
    (1, BOT + C),
]


def x_aspect(v, aspect):
    return v if aspect >= 1. else (v - 64) * aspect + 64


def y_aspect(v, aspect):
    return v if aspect <= 1. else (v - 64) / aspect + 64


def M(i, aspect):
    x, y = MESH_POINTS[i]
    return x_aspect(x, aspect), y_aspect(y, aspect)


def wave_path_create(ctx_size, aspect):
    """Returns path points (already in the SIZE*SCALE device space)."""
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1)
    cr = cairo.Context(surface)
    cr.scale(SIZE / 128. * SCALE, SIZE / 128. * SCALE)

    cr.line_to(*M(0, aspect))
    cr.curve_to(*M(1, aspect), *M(2, aspect), *M(3, aspect))
    cr.line_to(*M(4, aspect))
    cr.curve_to(*M(5, aspect), *M(6, aspect), *M(7, aspect))
    cr.close_path()

    cr.identity_matrix()
    path = cr.copy_path()
    return path


def wave_mesh_create(aspect, alpha):
    pattern = cairo.MeshPattern()
    m = cairo.Matrix(128. / SIZE / SCALE, 0, 0, 128. / SIZE / SCALE, 0, 0)
    pattern.set_matrix(m)
    pattern.begin_patch()

    pattern.line_to(*M(0, aspect))
    pattern.curve_to(*M(1, aspect), *M(2, aspect), *M(3, aspect))
    pattern.line_to(*M(4, aspect))
    pattern.curve_to(*M(5, aspect), *M(6, aspect), *M(7, aspect))

    if alpha:
        pattern.set_corner_color_rgba(0, 1, 1, 1, .5)
        pattern.set_corner_color_rgba(1, .5, .5, .5, .5)
        pattern.set_corner_color_rgba(2, 0, 0, 0, .5)
        pattern.set_corner_color_rgba(3, .5, .5, .5, .5)
    else:
        pattern.set_corner_color_rgb(0, 0, 0, .5)
        pattern.set_corner_color_rgb(1, 1, 0, .5)
        pattern.set_corner_color_rgb(2, 1, 1, .5)
        pattern.set_corner_color_rgb(3, 0, 1, .5)

    pattern.end_patch()
    return pattern


def scale_flag(flag_surface):
    w = flag_surface.get_width()
    h = flag_surface.get_height()
    scaled = cairo.ImageSurface(cairo.FORMAT_ARGB32, 256, 256)
    cr = cairo.Context(scaled)
    cr.scale(256. / w, 256. / h)
    cr.set_source_surface(flag_surface, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_BEST)
    cr.get_source().set_extend(cairo.EXTEND_PAD)
    cr.paint()
    return scaled


def load_scaled_flag(filename):
    flag = cairo.ImageSurface.create_from_png(filename)
    aspect = flag.get_width() / flag.get_height()
    scaled = scale_flag(flag)
    return scaled, aspect


def is_transparent(a):
    return a < 255


def border_is_transparent(scaled_flag):
    skip = 5
    w = scaled_flag.get_width()
    h = scaled_flag.get_height()
    buf = scaled_flag.get_data()
    stride = scaled_flag.get_stride()

    def alpha_at(x, y):
        off = y * stride + x * 4
        # BGRA little-endian in memory -> byte order B,G,R,A
        return buf[off + 3]

    transparent = False
    for x in range(skip, w - skip):
        transparent |= is_transparent(alpha_at(x, 0))
    for y in range(1 + skip, h - 1 - skip):
        transparent |= is_transparent(alpha_at(skip, y))
        transparent |= is_transparent(alpha_at(w - 1 - skip, y))
    for x in range(skip, w - skip):
        transparent |= is_transparent(alpha_at(x, h - 1))
    return transparent


def create_image():
    size = (SIZE + 2 * MARGIN) * SCALE
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    return cairo.Context(surface)


def wave_surface_create(aspect):
    cr = create_image()
    surface = cr.get_target()
    mesh = wave_mesh_create(aspect, 0)
    cr.set_source(mesh)
    cr.paint()
    return surface


def texture_map(src, tex):
    width = src.get_width()
    height = src.get_height()
    s_stride = src.get_stride()
    s_buf = src.get_data()

    dst = cairo.ImageSurface(cairo.FORMAT_ARGB32, width, height)
    d_stride = dst.get_stride()
    d_buf = dst.get_data()

    twidth = tex.get_width()
    theight = tex.get_height()
    assert twidth == 256 and theight == 256
    t_stride = tex.get_stride()
    t_buf = tex.get_data()

    for y in range(height):
        for x in range(width):
            so = y * s_stride + x * 4
            sb, sg, sr, sa = s_buf[so], s_buf[so + 1], s_buf[so + 2], s_buf[so + 3]
            do = y * d_stride + x * 4
            if sa == 0:
                d_buf[do:do + 4] = b'\x00\x00\x00\x00'
                continue
            if sa != 255:
                sr = sr * 255 // sa
                sg = sg * 255 // sa
                sb = sb * 255 // sa
            assert 127 <= sb <= 129, sb
            to = sg * t_stride + sr * 4
            d_buf[do:do + 4] = t_buf[to:to + 4]
    dst.mark_dirty()
    return dst


def wave_flag(filename, out_path):
    scaled_flag, raw_aspect = load_scaled_flag(filename)

    aspect = raw_aspect / STD_ASPECT
    aspect = math.sqrt(aspect)
    if .9 <= aspect <= 1.1:
        aspect = 1.

    wave_path = wave_path_create(SIZE, aspect)
    wave_surface = wave_surface_create(aspect)

    border_transparent = border_is_transparent(scaled_flag)
    waved_flag = texture_map(wave_surface, scaled_flag)

    cr = create_image()
    cr.translate(SCALE * MARGIN, SCALE * MARGIN)

    # Paint waved flag
    cr.set_source_surface(waved_flag, 0, 0)
    cr.append_path(wave_path)
    cr.clip_preserve()
    cr.paint()

    # Paint border
    if not border_transparent:
        border_alpha = .2
        border_width = 4 * SCALE
        border_gray = 0x42 / 255.

        cr.save()
        cr.set_source_rgba(border_gray * border_alpha,
                            border_gray * border_alpha,
                            border_gray * border_alpha,
                            border_alpha)
        cr.set_line_width(2 * border_width)
        cr.set_operator(cairo.OPERATOR_MULTIPLY)
        cr.stroke()
        cr.restore()
    else:
        cr.new_path()

    # Paint shade gradient
    gradient = wave_mesh_create(aspect, 1)
    w_pattern = cairo.SurfacePattern(waved_flag)

    cr.save()
    cr.set_source(gradient)
    cr.set_operator(cairo.OPERATOR_SOFT_LIGHT)
    cr.mask(w_pattern)
    cr.restore()

    # Downsample 2x at a time: 1024 -> 512 -> 256 -> 128
    scale = SCALE
    surface = cr.get_target()
    while scale > 1:
        old_surface = surface
        scale //= 2
        new_size = (SIZE + 2 * MARGIN) * scale
        new_surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, new_size, new_size)
        cr = cairo.Context(new_surface)
        cr.scale(.5, .5)
        cr.set_source_surface(old_surface, 0, 0)
        cr.paint()
        surface = new_surface

    surface.write_to_png(out_path)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: waveflag.py input.png output.png", file=sys.stderr)
        sys.exit(1)
    wave_flag(sys.argv[1], sys.argv[2])
