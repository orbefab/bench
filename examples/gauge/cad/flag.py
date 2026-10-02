"""Pointer that drops over the MG90S single-arm horn.

Part frame: hub centre on the origin, underside on z = 0, tip toward +X.
The horn pocket is open downward. Print it pocket-up. The stock horn screw
passes through the counterbore and clamps the lid.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    FLAG_COUNTERBORE_D,
    FLAG_COUNTERBORE_DEPTH,
    FLAG_HUB_R,
    FLAG_LENGTH,
    FLAG_ROOT_W,
    FLAG_SCREW_D,
    FLAG_T,
    FLAG_TIP_W,
)
from lib.fits import horn_pocket_void
from lib.geom import cyl_z

_ORANGE = srgb("#E15A2D")


def _blank():
    face = bd.Polygon(
        (0, -FLAG_ROOT_W / 2.0),
        (FLAG_LENGTH, -FLAG_TIP_W / 2.0),
        (FLAG_LENGTH, FLAG_TIP_W / 2.0),
        (0, FLAG_ROOT_W / 2.0),
    )
    blade = bd.extrude(face, amount=FLAG_T)
    hub = bd.Pos(0, 0, FLAG_T / 2.0) * bd.Cylinder(FLAG_HUB_R, FLAG_T)
    return blade + hub


def flag_shape():
    screw = cyl_z(0, 0, -0.2, FLAG_T + 0.2, FLAG_SCREW_D / 2.0)
    bore = cyl_z(
        0,
        0,
        FLAG_T - FLAG_COUNTERBORE_DEPTH,
        FLAG_T + 0.2,
        FLAG_COUNTERBORE_D / 2.0,
    )
    return _blank() - horn_pocket_void() - screw - bore


@step(out="STEP/flag.step")
def flag():
    body = flag_shape()
    body.label = "flag"
    body.color = _ORANGE
    return body


if __name__ == "__main__":
    flag()
