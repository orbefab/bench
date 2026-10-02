"""One-joint arm: fixed base and upper_arm on revolute shoulder about +Z."""

import cadgen
from cadgen import build123d as bd
from cadgen import step

from base import base
from lib.dimensions import SHOULDER_LIMITS_DEG, SHOULDER_Z_MM
from upper_arm import upper_arm

KINEMATICS = {
    "mates": [
        cadgen.revolute(
            "shoulder",
            parent="#base",
            child="#upper_arm",
            origin=(0, 0, SHOULDER_Z_MM),
            direction=(0, 0, 1),
            limits=SHOULDER_LIMITS_DEG,
        ),
    ],
}


@step(out="../STEP/arm.step", kinematics=KINEMATICS)
def arm():
    base_part = base()
    base_part.label = "base"
    # upper_arm is authored in its link frame. The link frame coincides with
    # the shoulder joint, which sits at (0, 0, SHOULDER_Z_MM) in the base frame.
    arm_part = bd.Pos(0, 0, SHOULDER_Z_MM) * upper_arm()
    arm_part.label = "upper_arm"
    return bd.Compound(children=[base_part, arm_part], label="arm")


if __name__ == "__main__":
    arm()
