"""Three small prints that trial the fits before the base.

Each feature is the same void or cradle as the base (``lib/fits.py``).
The servo coupon is the plan opening, not the full case depth. The sensor
coupon uses the same shelves, lip and pin opening, with shorter walls.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    FLAG_T,
    FLOOR_T,
    HCSR04_WALL,
    MG90S_BODY_L,
    MG90S_BODY_W,
    MG90S_HORN_ARM_L,
    MG90S_HORN_HUB_D,
    MG90S_POCKET_CLEARANCE,
    SENSOR_PCB_BOTTOM,
)
from lib.fits import hcsr04_cradle, horn_pocket_void, mg90s_pilot_slots, mg90s_pocket_void
from lib.geom import box

_SLATE = srgb("#3E4754")

# Tall enough to feel the opening. The plan size is the base's pocket.
_SERVO_WALL_H = 6.0
_SENSOR_GRIP = 8.0  # side stops above the shelf; the lip is still the full one


def _servo_shape():
    wall = HCSR04_WALL
    ox = MG90S_BODY_L + 2.0 * MG90S_POCKET_CLEARANCE + 2.0 * wall
    oy = MG90S_BODY_W + 2.0 * MG90S_POCKET_CLEARANCE + 2.0 * wall
    oz = FLOOR_T + _SERVO_WALL_H
    block = box(0, 0, oz / 2.0, ox, oy, oz)
    pocket = mg90s_pocket_void(FLOOR_T, oz + 0.4)
    slots = mg90s_pilot_slots(oz)
    return block - pocket - slots


def _horn_shape():
    hub_r = MG90S_HORN_HUB_D / 2.0 + 2.0
    length = MG90S_HORN_ARM_L + 8.0
    pad = box(length / 2.0 - 2.0, 0, FLAG_T / 2.0, length, 2.0 * hub_r, FLAG_T)
    pocket_up = bd.Pos(0, 0, FLAG_T) * bd.Rot(180, 0, 0) * horn_pocket_void()
    return pad - pocket_up


def _sensor_shape():
    return hcsr04_cradle(0, 0, SENSOR_PCB_BOTTOM, SENSOR_PCB_BOTTOM + _SENSOR_GRIP)


@step(out="STEP/coupon_servo.step")
def coupon_servo():
    body = _servo_shape()
    body.label = "coupon_servo"
    body.color = _SLATE
    return body


@step(out="STEP/coupon_horn.step")
def coupon_horn():
    body = _horn_shape()
    body.label = "coupon_horn"
    body.color = _SLATE
    return body


@step(out="STEP/coupon_sensor.step")
def coupon_sensor():
    body = _sensor_shape()
    body.label = "coupon_sensor"
    body.color = _SLATE
    return body


if __name__ == "__main__":
    coupon_servo()
    coupon_horn()
    coupon_sensor()
