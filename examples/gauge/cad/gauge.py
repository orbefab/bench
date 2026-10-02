"""Distance gauge at the 0° pose. The flag and the horn share one revolute.

Run from this directory: ``python gauge.py``. That writes every STEP.
"""

import cadgen
from cadgen import build123d as bd
from cadgen import step

from base import base
from coupon import coupon_horn, coupon_sensor, coupon_servo
from dial import dial
from flag import flag
from hcsr04 import hcsr04
from lib.dimensions import (
    BODY_BOTTOM_Z,
    DIAL_BOTTOM_Z,
    FLAG_BOTTOM_Z,
    HCSR04_Y,
    HCSR04_Z,
    NANO_CX,
    NANO_CY,
    NANO_PCB_BOTTOM_Z,
    SERVO_LIMITS_DEG,
)
from mg90s import mg90s, mg90s_body, mg90s_horn
from nano import nano

KINEMATICS = {
    "mates": [
        cadgen.revolute(
            "servo",
            parent="#base",
            child="#servo_output",
            origin=(0, 0, 0),
            direction=(0, 0, 1),
            limits=SERVO_LIMITS_DEG,
        ),
    ],
    "poses": {
        "deg0": {"servo": 0},
        "deg90": {"servo": 90},
        "deg180": {"servo": 180},
    },
}


@step(out="STEP/gauge.step", kinematics=KINEMATICS)
def gauge():
    # Child models write their own STEP files. The coupons stay out of the assembly.
    coupon_servo()
    coupon_horn()
    coupon_sensor()
    mg90s()

    base_part = base()
    base_part.label = "base"

    dial_part = bd.Pos(0, 0, DIAL_BOTTOM_Z) * dial()
    dial_part.label = "dial"

    # USB toward -Y: local -X is the connector, and RotZ(+90) sends -X to -Y.
    board = bd.Pos(NANO_CX, NANO_CY, NANO_PCB_BOTTOM_Z) * bd.Rot(0, 0, 90) * nano()
    board.label = "nano"

    servo = bd.Pos(0, 0, BODY_BOTTOM_Z) * mg90s_body()
    servo.label = "mg90s"

    horn = bd.Pos(0, 0, BODY_BOTTOM_Z) * mg90s_horn()
    horn.label = "horn"

    pointer = bd.Pos(0, 0, FLAG_BOTTOM_Z) * flag()
    pointer.label = "flag"

    output = bd.Compound(children=[horn, pointer], label="servo_output")
    sensor = bd.Pos(0, HCSR04_Y, HCSR04_Z) * hcsr04()
    sensor.label = "hcsr04"

    return bd.Compound(
        children=[base_part, dial_part, board, servo, output, sensor],
        label="gauge",
    )


if __name__ == "__main__":
    gauge()
