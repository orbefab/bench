"""CH340 Nano clone: PCB, TQFP, USB bridge, mini-USB, both headers, D13.

Part frame: PCB centre on Z, bottom face on z = 0, USB toward -X, component
side +Z. Pins point down. One solid — an outline, not the copper.
"""

from cadgen import build123d as bd
from cadgen import srgb, step

from lib.dimensions import (
    NANO_CH340_H,
    NANO_CH340_L,
    NANO_CH340_W,
    NANO_CH340_X,
    NANO_CH340_Y,
    NANO_D13_H,
    NANO_D13_L,
    NANO_D13_W,
    NANO_D13_X,
    NANO_D13_Y,
    NANO_MCU_BODY,
    NANO_MCU_H,
    NANO_MCU_LEAD,
    NANO_MCU_X,
    NANO_MCU_Y,
    NANO_PCB_L,
    NANO_PCB_T,
    NANO_PCB_W,
    NANO_PIN,
    NANO_PIN_BELOW_SHROUD,
    NANO_PIN_COUNT,
    NANO_PIN_PITCH,
    NANO_ROW_SPACING,
    NANO_SHROUD,
    NANO_USB_H,
    NANO_USB_L,
    NANO_USB_OVERHANG,
    NANO_USB_W,
)
from lib.geom import box, fuse

_GREEN = srgb("#1E7A34")


def _headers():
    span = (NANO_PIN_COUNT - 1) * NANO_PIN_PITCH
    x0 = -span / 2.0
    pin_drop = NANO_SHROUD + NANO_PIN_BELOW_SHROUD
    parts = []
    for side in (-1.0, 1.0):
        y = side * NANO_ROW_SPACING / 2.0
        parts.append(
            box(
                0,
                y,
                -NANO_SHROUD / 2.0 + 0.15,
                span + NANO_PIN,
                NANO_SHROUD,
                NANO_SHROUD + 0.3,
            )
        )
        for index in range(NANO_PIN_COUNT):
            parts.append(
                box(
                    x0 + index * NANO_PIN_PITCH,
                    y,
                    -pin_drop / 2.0 + 0.15,
                    NANO_PIN,
                    NANO_PIN,
                    pin_drop + 0.3,
                )
            )
    return parts


def nano_shape():
    pcb = box(0, 0, NANO_PCB_T / 2.0, NANO_PCB_L, NANO_PCB_W, NANO_PCB_T)
    usb_x = -NANO_PCB_L / 2.0 - NANO_USB_OVERHANG + NANO_USB_L / 2.0
    usb = box(usb_x, 0, NANO_PCB_T + NANO_USB_H / 2.0, NANO_USB_L, NANO_USB_W, NANO_USB_H)
    leads = box(
        NANO_MCU_X,
        NANO_MCU_Y,
        NANO_PCB_T + 0.08,
        NANO_MCU_LEAD,
        NANO_MCU_LEAD,
        0.2,
    )
    mcu = box(
        NANO_MCU_X,
        NANO_MCU_Y,
        NANO_PCB_T + NANO_MCU_H / 2.0,
        NANO_MCU_BODY,
        NANO_MCU_BODY,
        NANO_MCU_H,
    )
    ch340 = box(
        NANO_CH340_X,
        NANO_CH340_Y,
        NANO_PCB_T + NANO_CH340_H / 2.0,
        NANO_CH340_L,
        NANO_CH340_W,
        NANO_CH340_H,
    )
    d13 = box(
        NANO_D13_X,
        NANO_D13_Y,
        NANO_PCB_T + NANO_D13_H / 2.0,
        NANO_D13_L,
        NANO_D13_W,
        NANO_D13_H,
    )
    return fuse([pcb, usb, leads, mcu, ch340, d13, *_headers()])


@step(out="STEP/nano.step")
def nano():
    body = nano_shape()
    body.label = "nano"
    body.color = _GREEN
    return body


if __name__ == "__main__":
    nano()
