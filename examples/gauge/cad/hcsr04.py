"""HC-SR04 outline: PCB, two transducer cans, crystal, 4-pin header.

Part frame: PCB centre at the origin, cans toward +Y, pin header toward -Y
off the bottom edge. The board stands in this frame (45 mm along X, 20 mm
along Z) so the assembly only translates it.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    HCSR04_CAN_D,
    HCSR04_CAN_H,
    HCSR04_CAN_SPACING,
    HCSR04_CAN_Z,
    HCSR04_CRYSTAL_H,
    HCSR04_CRYSTAL_L,
    HCSR04_CRYSTAL_W,
    HCSR04_HEADER_BODY,
    HCSR04_HEADER_PINS,
    HCSR04_HEADER_PITCH,
    HCSR04_HEADER_PIN,
    HCSR04_HEADER_PIN_L,
    HCSR04_PCB_H,
    HCSR04_PCB_L,
    HCSR04_PCB_T,
)
from lib.geom import box, fuse

_BLUE = srgb("#1D4E89")


def _can(x: float):
    # Cylinder is along Z and centered. Tip it onto +Y and sit it on the PCB face.
    y = HCSR04_PCB_T / 2.0 + HCSR04_CAN_H / 2.0
    return bd.Pos(x, y, HCSR04_CAN_Z) * bd.Rot(-90, 0, 0) * bd.Cylinder(HCSR04_CAN_D / 2.0, HCSR04_CAN_H)


def _header():
    span = (HCSR04_HEADER_PINS - 1) * HCSR04_HEADER_PITCH
    x0 = -span / 2.0
    z = -HCSR04_PCB_H / 2.0 + HCSR04_HEADER_BODY / 2.0
    body_y = -HCSR04_PCB_T / 2.0 - HCSR04_HEADER_BODY / 2.0 + 0.15
    parts = [
        box(0, body_y, z, span + HCSR04_HEADER_PITCH, HCSR04_HEADER_BODY + 0.3, HCSR04_HEADER_BODY)
    ]
    pin_y = body_y - HCSR04_HEADER_PIN_L / 2.0
    for index in range(HCSR04_HEADER_PINS):
        parts.append(
            box(
                x0 + index * HCSR04_HEADER_PITCH,
                pin_y,
                z,
                HCSR04_HEADER_PIN,
                HCSR04_HEADER_PIN_L,
                HCSR04_HEADER_PIN,
            )
        )
    return parts


def hcsr04_shape():
    pcb = box(0, 0, 0, HCSR04_PCB_L, HCSR04_PCB_T, HCSR04_PCB_H)
    cans = [_can(-HCSR04_CAN_SPACING / 2.0), _can(HCSR04_CAN_SPACING / 2.0)]
    crystal = box(
        0,
        HCSR04_PCB_T / 2.0 + HCSR04_CRYSTAL_H / 2.0 - 0.05,
        0,
        HCSR04_CRYSTAL_L,
        HCSR04_CRYSTAL_H,
        HCSR04_CRYSTAL_W,
    )
    return fuse([pcb, crystal, *cans, *_header()])


@step(out="STEP/hcsr04.step")
def hcsr04():
    body = hcsr04_shape()
    body.label = "hcsr04"
    body.color = _BLUE
    return body


if __name__ == "__main__":
    hcsr04()
