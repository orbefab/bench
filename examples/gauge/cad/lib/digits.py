"""Seven-segment digits for dial engraving.

Stroke width is wide enough for a 0.4 mm nozzle (two perimeters). Each glyph
is centered on the origin and occupies z = 0..depth.
"""

from cadgen import build123d as bd

from lib.geom import box, fuse

# Segment letters follow the usual seven-segment names.
_GLYPHS = {
    "0": "abcdef",
    "1": "bc",
    "2": "abged",
    "5": "afgcd",
}


def _digit(char: str, width: float, height: float, stroke: float, depth: float):
    s = stroke
    w = width
    h = height
    z = depth / 2.0
    segments = {
        "a": box(0, h / 2.0 - s / 2.0, z, w, s, depth),
        "g": box(0, 0, z, w - s, s, depth),
        "d": box(0, -h / 2.0 + s / 2.0, z, w, s, depth),
        "f": box(-w / 2.0 + s / 2.0, h / 4.0, z, s, h / 2.0, depth),
        "b": box(w / 2.0 - s / 2.0, h / 4.0, z, s, h / 2.0, depth),
        "e": box(-w / 2.0 + s / 2.0, -h / 4.0, z, s, h / 2.0, depth),
        "c": box(w / 2.0 - s / 2.0, -h / 4.0, z, s, h / 2.0, depth),
    }
    keys = _GLYPHS[char]
    return fuse([segments[key] for key in keys])


def label(text: str, width: float, height: float, stroke: float, depth: float, gap: float):
    """A row of digits centered on the origin."""
    total = len(text) * width + (len(text) - 1) * gap
    x = -total / 2.0 + width / 2.0
    glyphs = []
    for char in text:
        glyphs.append(bd.Pos(x, 0, 0) * _digit(char, width, height, stroke, depth))
        x += width + gap
    return fuse(glyphs)
