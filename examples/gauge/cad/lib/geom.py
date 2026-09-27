"""Axis-aligned boxes and Z cylinders. Boxes and cylinders are centered by build123d."""

from cadgen import build123d as bd


def box(cx: float, cy: float, cz: float, sx: float, sy: float, sz: float):
    return bd.Pos(cx, cy, cz) * bd.Box(sx, sy, sz)


def cyl_z(cx: float, cy: float, z0: float, z1: float, radius: float):
    height = z1 - z0
    return bd.Pos(cx, cy, z0 + height / 2.0) * bd.Cylinder(radius, height)


def fuse(shapes):
    acc = shapes[0]
    for shape in shapes[1:]:
        acc = acc + shape
    return acc
