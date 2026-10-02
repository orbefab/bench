"""TowerPro MG90S outline: case, tabs, boss, spline, cable stub, single-arm horn.

Part frame: shaft on Z, case bottom on z = 0, tabs along X, cable toward -Y.
The horn is a separate solid so the assembly can turn it with the flag.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    MG90S_BODY_H,
    MG90S_BODY_L,
    MG90S_BODY_W,
    MG90S_BOSS_D,
    MG90S_BOSS_H,
    MG90S_CABLE_H,
    MG90S_CABLE_STUB,
    MG90S_CABLE_W,
    MG90S_CABLE_Z,
    MG90S_HOLE_D,
    MG90S_HOLE_SPACING,
    MG90S_HORN_ARM_L,
    MG90S_HORN_ARM_T,
    MG90S_HORN_ARM_W,
    MG90S_HORN_HOLE_D,
    MG90S_HORN_HOLE_X,
    MG90S_HORN_HUB_D,
    MG90S_HORN_HUB_H,
    MG90S_HORN_SCREW_D,
    MG90S_SPLINE_D,
    MG90S_SPLINE_H,
    MG90S_TAB_SPAN,
    MG90S_TAB_T,
)
from lib.geom import box, cyl_z, fuse

_BODY = srgb("#2C3138")
_HORN = srgb("#F3F0E8")


def mg90s_body():
    case = box(0, 0, MG90S_BODY_H / 2.0, MG90S_BODY_L, MG90S_BODY_W, MG90S_BODY_H)
    tabs = box(
        0,
        0,
        MG90S_BODY_H - MG90S_TAB_T / 2.0,
        MG90S_TAB_SPAN,
        MG90S_BODY_W,
        MG90S_TAB_T,
    )
    holes = []
    for sign in (-1.0, 1.0):
        holes.append(
            cyl_z(
                sign * MG90S_HOLE_SPACING / 2.0,
                0,
                MG90S_BODY_H - MG90S_TAB_T - 0.2,
                MG90S_BODY_H + 0.2,
                MG90S_HOLE_D / 2.0,
            )
        )
    boss = cyl_z(0, 0, MG90S_BODY_H, MG90S_BODY_H + MG90S_BOSS_H, MG90S_BOSS_D / 2.0)
    spline_z0 = MG90S_BODY_H + MG90S_BOSS_H
    spline = cyl_z(0, 0, spline_z0, spline_z0 + MG90S_SPLINE_H, MG90S_SPLINE_D / 2.0)
    # The horn screw threads into the shaft. Shown as a plain hole.
    screw = cyl_z(0, 0, spline_z0 + MG90S_SPLINE_H - 2.6, spline_z0 + MG90S_SPLINE_H + 0.2, 0.8)
    cable = box(
        0,
        -MG90S_BODY_W / 2.0 - MG90S_CABLE_STUB / 2.0 + 0.2,
        MG90S_CABLE_Z,
        MG90S_CABLE_W,
        MG90S_CABLE_STUB + 0.4,
        MG90S_CABLE_H,
    )
    body = fuse([case, tabs, boss, spline, cable]) - fuse(holes) - screw
    body.label = "mg90s"
    body.color = _BODY
    return body


def mg90s_horn():
    """Single-arm horn at 0°, arm along +X, seated on the gear boss."""
    z0 = MG90S_BODY_H + MG90S_BOSS_H
    hub = cyl_z(0, 0, z0, z0 + MG90S_HORN_HUB_H, MG90S_HORN_HUB_D / 2.0)
    arm = box(
        MG90S_HORN_ARM_L / 2.0,
        0,
        z0 + MG90S_HORN_ARM_T / 2.0,
        MG90S_HORN_ARM_L,
        MG90S_HORN_ARM_W,
        MG90S_HORN_ARM_T,
    )
    screw = cyl_z(0, 0, z0 - 0.2, z0 + MG90S_HORN_HUB_H + 0.2, MG90S_HORN_SCREW_D / 2.0)
    holes = [
        cyl_z(x, 0, z0 - 0.2, z0 + MG90S_HORN_ARM_T + 0.2, MG90S_HORN_HOLE_D / 2.0)
        for x in MG90S_HORN_HOLE_X
    ]
    horn = (hub + arm) - screw - fuse(holes)
    horn.label = "horn"
    horn.color = _HORN
    return horn


@step(out="STEP/mg90s.step")
def mg90s():
    return bd.Compound(children=[mg90s_body(), mg90s_horn()], label="mg90s_parts")


if __name__ == "__main__":
    mg90s()
