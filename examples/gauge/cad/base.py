"""Printed base. One shell: servo pocket, dial shelf, Nano cradle, sensor slot.

Bottom face on z = 0, on the bed. Servo shaft at the origin, +Y toward the
target. The dial is a separate print that drops into the shelf.
"""

from cadgen import srgb, step

from lib.dimensions import (
    BASE_X_HALF,
    BASE_Y_FRONT,
    BASE_Y_REAR,
    BODY_BOTTOM_Z,
    COLLAR_X,
    COLLAR_Y,
    DECK_Z,
    DIAL_HEEL,
    DIAL_R_IN,
    DIAL_R_OUT,
    DIAL_RADIAL_CLEARANCE,
    DIAL_SEAT_DEPTH,
    FLOOR_T,
    HCSR04_WALL_TOP,
    HCSR04_Y,
    NANO_CX,
    NANO_CY,
    NANO_END_CLEARANCE,
    NANO_LIP_ALONG,
    NANO_LIP_T,
    NANO_NEAR_RAIL_Y,
    NANO_PCB_BOTTOM_Z,
    NANO_PCB_L,
    NANO_PCB_T,
    NANO_PCB_W,
    NANO_RAIL_H,
    NANO_RAIL_L,
    NANO_RAIL_W,
    NANO_SIDE_CLEARANCE,
    NANO_USB_RAIL_Y,
    RIB_EVERY_DEG,
    RIB_T,
    SENSOR_PCB_BOTTOM,
    SHELF_BOTTOM_Z,
    SHELF_R,
    SHELF_WALL,
    WIRE_LANE_X0,
    WIRE_LANE_X1,
    WIRE_LANE_Y0,
    WIRE_LANE_Y1,
    WIRE_RIB_H,
    WIRE_RIB_T,
    polar,
)
from lib.fits import hcsr04_cradle, mg90s_cable_notch, mg90s_pilot_slots, mg90s_pocket_void
from lib.geom import box, cyl_z, fuse

_SLATE = srgb("#3E4754")


def _dial_shelf():
    """Semicircular shelf with a heel past the dial so the seat has a back wall."""
    height = DECK_Z - SHELF_BOTTOM_Z
    y_min = -(DIAL_HEEL + DIAL_RADIAL_CLEARANCE + SHELF_WALL)
    disc = cyl_z(0, 0, SHELF_BOTTOM_Z, DECK_Z, SHELF_R)
    keeper = box(
        0,
        y_min + SHELF_R,
        SHELF_BOTTOM_Z + height / 2.0,
        2.0 * SHELF_R + 2.0,
        2.0 * SHELF_R,
        height,
    )
    return disc & keeper


def _seat_void():
    """Recess the dial drops into. Larger than the dial by the radial clearance."""
    outer_r = DIAL_R_OUT + DIAL_RADIAL_CLEARANCE
    inner_r = DIAL_R_IN - DIAL_RADIAL_CLEARANCE
    y_min = -DIAL_HEEL - DIAL_RADIAL_CLEARANCE
    z0 = DECK_Z - DIAL_SEAT_DEPTH
    z1 = DECK_Z + 0.4
    height = z1 - z0
    disc = cyl_z(0, 0, z0, z1, outer_r)
    keeper = box(0, y_min + outer_r, z0 + height / 2.0, 2.0 * outer_r + 2.0, 2.0 * outer_r, height + 0.2)
    ring = (disc & keeper) - cyl_z(0, 0, z0 - 0.2, z1 + 0.2, inner_r)
    return ring


def _ribs():
    """Radial walls under the dial shelf. The forward ones stop short of the sensor header."""
    z0 = FLOOR_T
    z1 = SHELF_BOTTOM_Z + 0.4
    ribs = []
    angle = 0.0
    while angle <= 180.0 + 1e-6:
        outer = 30.0 if 70.0 <= angle <= 110.0 else SHELF_R - 0.4
        inner = 20.0
        length = outer - inner
        cx, cy = polar((inner + outer) / 2.0, angle)
        bar = box(0, 0, (z0 + z1) / 2.0, length, RIB_T, z1 - z0)
        ribs.append(bd_rot(bar, cx, cy, angle))
        angle += RIB_EVERY_DEG
    return ribs


def bd_rot(shape, cx: float, cy: float, angle_deg: float):
    from cadgen import build123d as bd

    return bd.Pos(cx, cy, 0) * bd.Rot(0, 0, angle_deg) * shape


def _nano_cradle():
    """End rails and corner lips. PCB bottom is NANO_PCB_BOTTOM_Z, USB toward -Y.

    The board's length is along Y after the assembly rotation: the near end
    (toward the servo) is the more positive Y, the USB end the more negative.
    """
    half_l = NANO_PCB_L / 2.0
    half_w = NANO_PCB_W / 2.0
    near_y = NANO_CY + half_l  # toward the servo, +Y
    usb_y = NANO_CY - half_l
    rail_z = FLOOR_T + NANO_RAIL_H / 2.0
    # Inset the rails so they land on FR4, not on the header row.
    near_rail_y = NANO_NEAR_RAIL_Y
    usb_rail_y = NANO_USB_RAIL_Y
    rails = [
        box(NANO_CX, near_rail_y, rail_z, NANO_RAIL_L, NANO_RAIL_W, NANO_RAIL_H),
        box(NANO_CX, usb_rail_y, rail_z, NANO_RAIL_L, NANO_RAIL_W, NANO_RAIL_H),
    ]
    # Corner lips on the long sides. Open middle for the Dupont housings.
    lip_z = (NANO_PCB_BOTTOM_Z + NANO_PCB_T + 3.0) / 2.0
    lip_h = NANO_PCB_BOTTOM_Z + NANO_PCB_T + 3.0
    lip_x = half_w + NANO_SIDE_CLEARANCE + NANO_LIP_T / 2.0
    lips = []
    for x_sign in (-1.0, 1.0):
        for y_end, y_dir in ((near_y, -1.0), (usb_y, 1.0)):
            y = y_end + y_dir * (NANO_LIP_ALONG / 2.0)
            lips.append(box(NANO_CX + x_sign * lip_x, y, lip_z, NANO_LIP_T, NANO_LIP_ALONG, lip_h))
    # Stop at the servo end. The USB end is open for the cable.
    stop = box(
        NANO_CX,
        near_y + NANO_END_CLEARANCE + NANO_LIP_T / 2.0,
        lip_z,
        NANO_PCB_W + 2.0 * NANO_SIDE_CLEARANCE,
        NANO_LIP_T,
        lip_h,
    )
    return rails + lips + [stop]


def _wire_lane():
    z = FLOOR_T + WIRE_RIB_H / 2.0
    span = WIRE_LANE_Y1 - WIRE_LANE_Y0
    cy = (WIRE_LANE_Y0 + WIRE_LANE_Y1) / 2.0
    return [
        box(WIRE_LANE_X0, cy, z, WIRE_RIB_T, span, WIRE_RIB_H),
        box(WIRE_LANE_X1, cy, z, WIRE_RIB_T, span, WIRE_RIB_H),
    ]


def base_shape():
    floor = box(
        0,
        (BASE_Y_REAR + BASE_Y_FRONT) / 2.0,
        FLOOR_T / 2.0,
        2.0 * BASE_X_HALF,
        BASE_Y_FRONT - BASE_Y_REAR,
        FLOOR_T,
    )
    # Solid collar. A cavity here would swallow the pocket walls; infill is a slicer setting.
    collar = box(0, 0, DECK_Z / 2.0, 2.0 * COLLAR_X, 2.0 * COLLAR_Y, DECK_Z)
    parts = [floor, collar, _dial_shelf(), *_ribs(), *_nano_cradle(), *_wire_lane()]
    parts.append(hcsr04_cradle(0, HCSR04_Y, SENSOR_PCB_BOTTOM, HCSR04_WALL_TOP))
    body = fuse(parts)
    pocket = mg90s_pocket_void(FLOOR_T, DECK_Z + 1.0)
    notch = mg90s_cable_notch(BODY_BOTTOM_Z, reach=COLLAR_Y)
    body = body - pocket - mg90s_pilot_slots(DECK_Z) - notch - _seat_void()
    return body


@step(out="STEP/base.step")
def base():
    body = base_shape()
    body.label = "base"
    body.color = _SLATE
    return body


if __name__ == "__main__":
    base()
