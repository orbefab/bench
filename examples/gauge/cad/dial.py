"""Semicircular distance dial. Separate print, seated in the base.

Part frame: centre of the diameter on the origin, underside on z = 0, scale
in +Y. 0° (2 cm) is +X. Marks sit at angle = (d - 2) / 98 × 180°.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.digits import label
from lib.dimensions import (
    DIAL_DIGIT_GAP,
    DIAL_DIGIT_H,
    DIAL_DIGIT_STROKE,
    DIAL_DIGIT_W,
    DIAL_ENGRAVE,
    DIAL_HEEL,
    DIAL_LABEL_R,
    DIAL_LABELS_CM,
    DIAL_MARKS_CM,
    DIAL_R_IN,
    DIAL_R_OUT,
    DIAL_T,
    DIAL_TICK_R0,
    DIAL_TICK_R1,
    DIAL_TICK_W,
    DIAL_ZERO_TICK_R0,
    DIAL_ZERO_TICK_W,
    cm_to_deg,
    polar,
)
from lib.geom import cyl_z

_CREAM = srgb("#F4EFE4")


def _disc(radius: float, z0: float, z1: float, y_min: float):
    height = z1 - z0
    disc = bd.Pos(0, 0, z0 + height / 2.0) * bd.Cylinder(radius, height)
    keeper = bd.Pos(0, y_min + radius, z0 + height / 2.0) * bd.Box(
        2.0 * radius + 2.0, 2.0 * radius, height
    )
    return disc & keeper


def _tick(angle_deg: float, r0: float, r1: float, width: float):
    length = r1 - r0
    cx, cy = polar((r0 + r1) / 2.0, angle_deg)
    bar = bd.Box(length, width, DIAL_ENGRAVE + 0.3)
    return bd.Pos(cx, cy, DIAL_T - DIAL_ENGRAVE / 2.0 + 0.15) * bd.Rot(0, 0, angle_deg) * bar


def dial_shape():
    plate = _disc(DIAL_R_OUT, 0, DIAL_T, -DIAL_HEEL) - cyl_z(0, 0, -0.4, DIAL_T + 0.4, DIAL_R_IN)
    cutters = []
    for distance in DIAL_MARKS_CM:
        angle = cm_to_deg(distance)
        if distance == 2:
            cutters.append(_tick(angle, DIAL_ZERO_TICK_R0, DIAL_TICK_R1, DIAL_ZERO_TICK_W))
        else:
            cutters.append(_tick(angle, DIAL_TICK_R0, DIAL_TICK_R1, DIAL_TICK_W))
    # Labels read upright for someone standing in front of the sensor (+Y),
    # looking back toward the Nano. The long tick at 0° is the degree reference.
    for distance in DIAL_LABELS_CM:
        angle = cm_to_deg(distance)
        # Keep "100" on the plate; the 180° ray is the heel's edge.
        if distance == 100:
            angle = 168.0
        text = label(
            str(distance),
            DIAL_DIGIT_W,
            DIAL_DIGIT_H,
            DIAL_DIGIT_STROKE,
            DIAL_ENGRAVE + 0.3,
            DIAL_DIGIT_GAP,
        )
        lx, ly = polar(DIAL_LABEL_R, angle)
        cutters.append(
            bd.Pos(lx, ly, DIAL_T - DIAL_ENGRAVE) * bd.Rot(0, 0, 180) * text
        )
    acc = cutters[0]
    for cutter in cutters[1:]:
        acc = acc + cutter
    return plate - acc


@step(out="STEP/dial.step")
def dial():
    body = dial_shape()
    body.label = "dial"
    body.color = _CREAM
    return body


if __name__ == "__main__":
    dial()
