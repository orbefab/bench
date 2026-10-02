"""Voids and holders shared by the base, the flag and the fit coupon.

Every size here comes from ``lib.dimensions`` so the coupon tests the same
gaps the base and the flag are built with.
"""

from cadgen import build123d as bd

from lib.dimensions import (
    DUPONT_BEND_GAP,
    DUPONT_HOUSING_L,
    DUPONT_HOUSING_W,
    FLAG_ARM_POCKET_DEPTH,
    FLAG_HORN_SIDE_CLEARANCE,
    FLAG_HUB_POCKET_DEPTH,
    HCSR04_CAN_D,
    HCSR04_CAN_Z,
    HCSR04_HEADER_BELOW_PCB,
    HCSR04_HEADER_BODY,
    HCSR04_HEADER_BODY_L,
    HCSR04_HEADER_CLEARANCE,
    HCSR04_HEADER_OVERLAP,
    HCSR04_HEADER_PINS,
    HCSR04_HEADER_PITCH,
    HCSR04_LIP_TO_CAN,
    HCSR04_PCB_H,
    HCSR04_PCB_L,
    HCSR04_PCB_T,
    HCSR04_PINS_DOWN,
    HCSR04_SHELF_CLEARANCE,
    HCSR04_SIDE_CLEARANCE,
    HCSR04_SLOT_CLEARANCE,
    HCSR04_WALL,
    HCSR04_Z,
    NANO_CX,
    NANO_CY,
    NANO_PCB_BOTTOM_Z,
    NANO_PIN_COUNT,
    NANO_PIN_PITCH,
    NANO_ROW_SPACING,
    NANO_SHROUD,
    MG90S_BODY_L,
    MG90S_BODY_W,
    MG90S_CABLE_H,
    MG90S_CABLE_NOTCH_CLEARANCE,
    MG90S_CABLE_W,
    MG90S_CABLE_Z,
    MG90S_HORN_ARM_L,
    MG90S_HORN_ARM_W,
    MG90S_HORN_HUB_D,
    MG90S_PILOT_D,
    MG90S_PILOT_DEPTH,
    MG90S_PILOT_SLOT_L,
    MG90S_PILOT_X,
    MG90S_POCKET_CLEARANCE,
)
from lib.geom import box, cyl_z, fuse


def mg90s_pocket_void(z0: float, z1: float):
    """Case pocket, open upward, expanded by MG90S_POCKET_CLEARANCE per side."""
    return box(
        0,
        0,
        (z0 + z1) / 2.0,
        MG90S_BODY_L + 2.0 * MG90S_POCKET_CLEARANCE,
        MG90S_BODY_W + 2.0 * MG90S_POCKET_CLEARANCE,
        z1 - z0,
    )


def mg90s_pilot_slots(deck_z: float):
    """Two screw slots under the tabs. An M2-ish screw bites the narrow walls."""
    slots = []
    z1 = deck_z
    z0 = deck_z - MG90S_PILOT_DEPTH
    for sign in (-1.0, 1.0):
        slots.append(
            box(
                sign * MG90S_PILOT_X,
                0,
                (z0 + z1) / 2.0,
                MG90S_PILOT_SLOT_L,
                MG90S_PILOT_D,
                z1 - z0 + 0.4,
            )
        )
    return fuse(slots)


def mg90s_cable_notch(body_bottom_z: float, reach: float):
    """Opening in the rear pocket wall for the cable stub."""
    clr = MG90S_CABLE_NOTCH_CLEARANCE
    zc = body_bottom_z + MG90S_CABLE_Z
    return box(
        0,
        -MG90S_BODY_W / 2.0 - reach / 2.0,
        zc,
        MG90S_CABLE_W + 2.0 * clr,
        reach + MG90S_BODY_W,
        MG90S_CABLE_H + 2.0 * clr,
    )


def horn_pocket_void():
    """Cutter in the flag frame: z = 0 is the flag underside, +X is the pointer.

    The cutter breaks through z = 0 so the boolean leaves a clean pocket floor.
    """
    hub_r = MG90S_HORN_HUB_D / 2.0 + FLAG_HORN_SIDE_CLEARANCE
    hub_top = FLAG_HUB_POCKET_DEPTH
    hub = cyl_z(0, 0, -0.4, hub_top, hub_r)

    arm_w = MG90S_HORN_ARM_W + 2.0 * FLAG_HORN_SIDE_CLEARANCE
    x0 = -1.0
    x1 = MG90S_HORN_ARM_L + FLAG_HORN_SIDE_CLEARANCE
    arm = box(
        (x0 + x1) / 2.0,
        0,
        (FLAG_ARM_POCKET_DEPTH - 0.4) / 2.0,
        x1 - x0,
        arm_w,
        FLAG_ARM_POCKET_DEPTH + 0.4,
    )
    return hub + arm


def hcsr04_cradle(center_x: float, center_y: float, pcb_bottom: float, wall_top: float):
    """Rear wall, side stops, shelf and front lip around an HC-SR04.

    The board's centre is ``(center_x, center_y)``. Its bottom face is
    ``pcb_bottom`` (the shelf is HCSR04_SHELF_CLEARANCE below that).
    """
    if HCSR04_PINS_DOWN:
        return _cradle_pins_down(center_x, center_y, pcb_bottom, wall_top)
    return _cradle_pins_back(center_x, center_y, pcb_bottom, wall_top)


def _cradle_pins_down(center_x: float, center_y: float, pcb_bottom: float, wall_top: float):
    """End shelves with an open centre so the pins and housings hang free.

    Walls sit on the shelves. A rib under the front of each end plate
    carries it, and the pin bay stays open. Wires leave under the plate
    toward -X and the floor lane.
    """
    half_l = HCSR04_PCB_L / 2.0
    half_t = HCSR04_PCB_T / 2.0
    slot = HCSR04_SLOT_CLEARANCE
    side = HCSR04_SIDE_CLEARANCE
    wall = HCSR04_WALL
    shelf_top = pcb_bottom - HCSR04_SHELF_CLEARANCE
    plate_t = wall

    rear_face = center_y - half_t - slot
    lip_face = center_y + half_t + slot
    span_y = (lip_face + wall) - (rear_face - wall)
    side_y = (rear_face - wall + lip_face + wall) / 2.0
    shelf_w = HCSR04_PCB_T + 2.0 * slot + 2.0 * wall

    gap = HCSR04_HEADER_BODY_L / 2.0 + HCSR04_HEADER_CLEARANCE
    stop_x = half_l + side
    plate_outer = stop_x + 0.4  # tuck under the side wall so the two fuse
    pad_w = plate_outer - gap
    pad_cx = (plate_outer + gap) / 2.0
    plate_z = shelf_top - plate_t / 2.0

    parts = []
    for sign in (-1.0, 1.0):
        parts.append(
            box(center_x + sign * pad_cx, center_y, plate_z, pad_w, shelf_w, plate_t)
        )
        rib_x = center_x + sign * pad_cx
        rib_y = center_y + shelf_w / 2.0 - wall / 2.0
        parts.append(box(rib_x, rib_y, shelf_top / 2.0, pad_w, wall, shelf_top))

    # Walls start just under the shelf top, clear of the housings below.
    z0 = shelf_top - 0.4
    zh = wall_top - z0
    zc = (z0 + wall_top) / 2.0
    parts.append(
        box(
            center_x,
            rear_face - wall / 2.0,
            zc,
            HCSR04_PCB_L + 2.0 * side + 2.0 * wall,
            wall,
            zh,
        )
    )
    side_x = stop_x + wall / 2.0
    parts.append(box(center_x - side_x, side_y, zc, wall, span_y, zh))
    parts.append(box(center_x + side_x, side_y, zc, wall, span_y, zh))

    can_bottom = pcb_bottom + HCSR04_PCB_H / 2.0 + HCSR04_CAN_Z - HCSR04_CAN_D / 2.0
    lip_h = can_bottom - HCSR04_LIP_TO_CAN - shelf_top
    parts.append(
        box(
            center_x,
            lip_face + wall / 2.0,
            shelf_top - 0.4 + (lip_h + 0.4) / 2.0,
            HCSR04_PCB_L + 2.0 * side,
            wall,
            lip_h + 0.4,
        )
    )
    # The header plastic is thicker than the PCB. Open it through the walls
    # so the pins-down shroud is not pinched; the board above is still gripped.
    relief_z1 = pcb_bottom + HCSR04_HEADER_OVERLAP + HCSR04_HEADER_CLEARANCE
    relief = box(
        center_x,
        center_y,
        (z0 + relief_z1) / 2.0,
        HCSR04_HEADER_BODY_L + 2.0 * HCSR04_HEADER_CLEARANCE,
        span_y + 2.0,
        relief_z1 - z0,
    )
    return fuse(parts) - relief


def _cradle_pins_back(center_x: float, center_y: float, pcb_bottom: float, wall_top: float):
    """Pins leave the back face. A full shelf and a window in the rear wall."""
    half_l = HCSR04_PCB_L / 2.0
    half_t = HCSR04_PCB_T / 2.0
    slot = HCSR04_SLOT_CLEARANCE
    side = HCSR04_SIDE_CLEARANCE
    wall = HCSR04_WALL
    shelf_top = pcb_bottom - HCSR04_SHELF_CLEARANCE

    rear_face = center_y - half_t - slot  # +Y face of the rear wall
    lip_face = center_y + half_t + slot  # -Y face of the front lip
    span_y = (lip_face + wall) - (rear_face - wall)

    rear = box(
        center_x,
        rear_face - wall / 2.0,
        wall_top / 2.0,
        HCSR04_PCB_L + 2.0 * side + 2.0 * wall,
        wall,
        wall_top,
    )
    side_x = half_l + side + wall / 2.0
    side_y = (rear_face - wall + lip_face + wall) / 2.0
    left = box(center_x - side_x, side_y, wall_top / 2.0, wall, span_y, wall_top)
    right = box(center_x + side_x, side_y, wall_top / 2.0, wall, span_y, wall_top)

    shelf_w = HCSR04_PCB_T + 2.0 * slot + 2.0 * wall
    shelf = box(
        center_x,
        center_y,
        shelf_top / 2.0,
        HCSR04_PCB_L + 2.0 * side,
        shelf_w,
        shelf_top,
    )
    # Window through the rear wall so the right-angle header and its pins
    # leave toward the wire bay. The wall above the window is the backstop.
    gap = HCSR04_HEADER_CLEARANCE
    window = box(
        center_x,
        rear_face - wall / 2.0,
        pcb_bottom + HCSR04_HEADER_BODY / 2.0,
        HCSR04_HEADER_BODY_L + 2.0 * gap,
        wall + 2.0,
        HCSR04_HEADER_BODY + 2.0 * gap,
    )

    can_bottom = pcb_bottom + HCSR04_PCB_H / 2.0 + HCSR04_CAN_Z - HCSR04_CAN_D / 2.0
    lip_h = can_bottom - HCSR04_LIP_TO_CAN - shelf_top
    lip = box(
        center_x,
        lip_face + wall / 2.0,
        shelf_top + lip_h / 2.0,
        HCSR04_PCB_L + 2.0 * side,
        wall,
        lip_h,
    )
    # Tie the lip down to the shelf so the cradle is one solid with the base.
    lip_leg = box(
        center_x,
        lip_face + wall / 2.0,
        shelf_top / 2.0,
        wall,
        wall,
        shelf_top,
    )
    return fuse([rear, left, right, shelf, lip, lip_leg]) - window


def nano_dupont_keepouts():
    """One box per Nano pin: the female housing plus the bend gap, in the assembly."""
    span = (NANO_PIN_COUNT - 1) * NANO_PIN_PITCH
    x0 = -span / 2.0
    height = DUPONT_HOUSING_L + DUPONT_BEND_GAP
    z = -NANO_SHROUD - height / 2.0
    boxes = []
    for side in (-1.0, 1.0):
        y = side * NANO_ROW_SPACING / 2.0
        mark = "+" if side > 0 else "-"
        for index in range(NANO_PIN_COUNT):
            local = box(
                x0 + index * NANO_PIN_PITCH,
                y,
                z,
                DUPONT_HOUSING_W,
                DUPONT_HOUSING_W,
                height,
            )
            world = bd.Pos(NANO_CX, NANO_CY, NANO_PCB_BOTTOM_Z) * bd.Rot(0, 0, 90) * local
            boxes.append((f"nano {mark}{index}", world.solid()))
    return boxes


def hcsr04_dupont_keepouts(center_x: float, center_y: float):
    """One box per HC-SR04 pin: the housing plus the bend gap, at this board centre."""
    span = (HCSR04_HEADER_PINS - 1) * HCSR04_HEADER_PITCH
    x0 = -span / 2.0
    height = DUPONT_HOUSING_L + DUPONT_BEND_GAP
    boxes = []
    if HCSR04_PINS_DOWN:
        body_bottom = -HCSR04_PCB_H / 2.0 - HCSR04_HEADER_BELOW_PCB
        z = body_bottom - height / 2.0
        for index in range(HCSR04_HEADER_PINS):
            local = box(
                x0 + index * HCSR04_HEADER_PITCH,
                0,
                z,
                DUPONT_HOUSING_W,
                DUPONT_HOUSING_W,
                height,
            )
            world = bd.Pos(center_x, center_y, HCSR04_Z) * local
            boxes.append((f"hcsr04 {index}", world.solid()))
        return boxes
    body_y = -HCSR04_PCB_T / 2.0 - HCSR04_HEADER_BODY / 2.0 + 0.15
    y = body_y - HCSR04_HEADER_BODY / 2.0 - height / 2.0
    z = -HCSR04_PCB_H / 2.0 + HCSR04_HEADER_BODY / 2.0
    for index in range(HCSR04_HEADER_PINS):
        local = box(
            x0 + index * HCSR04_HEADER_PITCH,
            y,
            z,
            DUPONT_HOUSING_W,
            height,
            DUPONT_HOUSING_W,
        )
        world = bd.Pos(center_x, center_y, HCSR04_Z) * local
        boxes.append((f"hcsr04 {index}", world.solid()))
    return boxes
