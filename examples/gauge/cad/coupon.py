"""One small print that trials the three fits before the base.

The servo pocket is the plan-view opening (not the full case depth). The
sensor slot uses the same clearances as the base, with shorter walls. The
horn pocket is the flag's pocket, opened upward.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    FLAG_T,
    FLOOR_T,
    MG90S_BODY_W,
    MG90S_POCKET_CLEARANCE,
    MG90S_TAB_SPAN,
    SENSOR_PCB_BOTTOM,
)
from lib.fits import hcsr04_cradle, horn_pocket_void, mg90s_pilot_slots, mg90s_pocket_void
from lib.geom import box, fuse

_SLATE = srgb("#3E4754")

# Shorter than the base so the coupon is a fast print. The gaps match.
_COUPON_WALL_TOP = 14.0
_COUPON_POCKET_TOP = 10.0
_PLATE_X = 72.0
_PLATE_Y = 118.0


def coupon_shape():
    plate = box(0, 0, FLOOR_T / 2.0, _PLATE_X, _PLATE_Y, FLOOR_T)

    servo_y = -36.0
    servo_top = _COUPON_POCKET_TOP
    servo_block = box(
        0,
        servo_y,
        servo_top / 2.0,
        MG90S_TAB_SPAN + 8.0,
        MG90S_BODY_W + 2.0 * MG90S_POCKET_CLEARANCE + 8.0,
        servo_top,
    )
    pocket = bd.Pos(0, servo_y, 0) * mg90s_pocket_void(FLOOR_T, servo_top + 0.4)
    slots = bd.Pos(0, servo_y, 0) * mg90s_pilot_slots(servo_top)

    horn_y = 2.0
    pad_h = FLAG_T
    pad = box(0, horn_y, pad_h / 2.0, 30.0, 18.0, pad_h)
    # Pocket opens upward: flip the flag cutter, which opens downward.
    pocket_up = bd.Pos(0, horn_y, pad_h) * bd.Rot(180, 0, 0) * horn_pocket_void()

    sensor = hcsr04_cradle(0, 38.0, SENSOR_PCB_BOTTOM, _COUPON_WALL_TOP)

    body = fuse([plate, servo_block, pad, sensor]) - pocket - slots - pocket_up
    return body


@step(out="STEP/coupon.step")
def coupon():
    body = coupon_shape()
    body.label = "coupon"
    body.color = _SLATE
    return body


if __name__ == "__main__":
    coupon()
