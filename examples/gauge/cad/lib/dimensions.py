"""Shared millimetre dimensions for the distance gauge.

Every fit clearance is a named constant so one edit changes that fit.
A value marked ``# verify`` was not confirmed on a drawing of the owner's
part. Sources and the assumed numbers are listed in ``README.md``.

World frame: servo shaft on Z, origin on the bed, +Y toward the target,
+X to the right when looking along +Y. The flag's 0° pose points along +X
(2 cm). Angle increases counter-clockwise viewed from above:

    angle_deg = (distance_cm - 2) / 98 * 180
"""

import math

# PLA, used for print-mass estimates. 1.24 g/cm³ = 1.24e-3 g/mm³.
PLA_DENSITY_G_PER_CM3 = 1.24
PLA_DENSITY_G_PER_MM3 = 1.24e-3

# ---------------------------------------------------------------------------
# MG90S (TowerPro product page: 22.8 × 12.2 × 28.5 mm, tab span A = 32.5)
# ---------------------------------------------------------------------------

MG90S_BODY_L = 22.8  # along the tabs, TowerPro "B"
MG90S_BODY_W = 12.2  # TowerPro dimension line; the same page's table lists D = 12.4
MG90S_TAB_SPAN = 32.5  # TowerPro "A", overall length including tabs
MG90S_OVERALL_H = 28.5  # bottom of the case to the tip of the spline

# Letter "F" on the TowerPro table is 18.5. Read here as the height from the
# case bottom to the underside of the tabs. The letter is not defined on the page.
MG90S_TAB_UNDERSIDE = 18.5  # verify
MG90S_TAB_T = 2.5  # verify — tabs finish flush with the case top
MG90S_BODY_H = MG90S_TAB_UNDERSIDE + MG90S_TAB_T  # 21.0, verify (split of the 28.5)
MG90S_BOSS_H = 4.0  # verify — round gear cover above the case
MG90S_BOSS_D = 11.6  # verify
MG90S_SPLINE_H = MG90S_OVERALL_H - MG90S_BODY_H - MG90S_BOSS_H  # 3.5, verify split
MG90S_SPLINE_D = 4.8  # verify — smooth outline, teeth not modelled
MG90S_HOLE_SPACING = 28.0  # verify — centre to centre of the tab holes
MG90S_HOLE_D = 2.2  # verify

# Stock single-arm horn. Outline only.
MG90S_HORN_HUB_D = 7.2  # verify
MG90S_HORN_HUB_H = 3.2  # verify
MG90S_HORN_ARM_T = 1.5  # verify
MG90S_HORN_ARM_W = 4.8  # verify
MG90S_HORN_ARM_L = 18.0  # verify — centre of the hub to the tip
MG90S_HORN_SCREW_D = 2.2  # verify — clearance hole through the horn
MG90S_HORN_HOLE_D = 1.2  # verify — the three small holes along the arm
MG90S_HORN_HOLE_X = (8.0, 12.0, 16.0)  # verify

# Cable leaves the rear face, low, toward the Nano.
MG90S_CABLE_W = 4.0  # verify
MG90S_CABLE_H = 3.0  # verify
MG90S_CABLE_STUB = 3.0  # verify — how far the jacket sticks out of the case
MG90S_CABLE_Z = 4.5  # verify — height of the stub centre above the case bottom

# Fits. Slots are longer than the nominal hole spacing so a datasheet error
# still lets the stock screws find the pilots.
MG90S_POCKET_CLEARANCE = 0.60  # per side, X and Y, around the case
MG90S_FLOOR_CLEARANCE = 0.50  # under the case; the tabs carry the servo
MG90S_TAB_SEAT_CLEARANCE = 0.30  # under the tabs before the screws are tightened
MG90S_PILOT_D = 1.70  # an M2-ish stock screw bites this
MG90S_PILOT_SLOT_L = 4.2  # along X, centred slightly outboard of the nominal hole
MG90S_PILOT_DEPTH = 6.0
MG90S_CABLE_NOTCH_CLEARANCE = 0.80  # around the cable stub

# ---------------------------------------------------------------------------
# Horn → flag
# ---------------------------------------------------------------------------

FLAG_HORN_SIDE_CLEARANCE = 0.40  # per side, hub and arm
FLAG_HORN_Z_CLEARANCE = 0.35  # between the horn's top surfaces and the pocket floors
FLAG_ABOVE_BOSS = 0.40  # flag underside above the gear boss, so it clears the servo
FLAG_LID = 1.6  # material left above the hub pocket for the screw head
FLAG_LENGTH = 33.0  # hub centre to tip; reaches the dial ticks
FLAG_ROOT_W = 10.0
FLAG_TIP_W = 4.2
FLAG_HUB_R = 8.0
FLAG_SCREW_D = 2.4  # the horn screw passes through; the head clamps the lid
FLAG_COUNTERBORE_D = 4.4  # verify — assumed head diameter of the stock horn screw
FLAG_COUNTERBORE_DEPTH = 1.0

# Hub and arm rise above the boss. The flag starts FLAG_ABOVE_BOSS higher,
# so the pocket only has to swallow the remainder, plus a little air.
FLAG_HUB_POCKET_DEPTH = (MG90S_HORN_HUB_H - FLAG_ABOVE_BOSS) + FLAG_HORN_Z_CLEARANCE
FLAG_ARM_POCKET_DEPTH = (MG90S_HORN_ARM_T - FLAG_ABOVE_BOSS) + FLAG_HORN_Z_CLEARANCE
FLAG_T = FLAG_HUB_POCKET_DEPTH + FLAG_LID

# ---------------------------------------------------------------------------
# HC-SR04 (datasheet envelope 45 × 20 × 15 mm)
# ---------------------------------------------------------------------------

HCSR04_PCB_L = 45.0  # across the two transducers
HCSR04_PCB_H = 20.0  # the board, not the cans
HCSR04_PCB_T = 1.6  # verify
HCSR04_CAN_D = 16.0  # verify — the usual TCT40-16 can; the module drawing gives 15 mm overall height
HCSR04_CAN_H = 12.0  # verify — protrusion past the PCB face (1.6 + 12 ≈ the 15 mm envelope)
HCSR04_CAN_SPACING = 25.0  # verify — centre to centre
HCSR04_CAN_Z = 2.0  # verify — can centre above the PCB centre, toward the top edge
HCSR04_CRYSTAL_L = 8.0  # verify
HCSR04_CRYSTAL_W = 3.6  # verify
HCSR04_CRYSTAL_H = 3.2  # verify — stands off the PCB between the cans
HCSR04_HEADER_PINS = 4
HCSR04_HEADER_PITCH = 2.54  # datasheet: 2.54 mm header
HCSR04_HEADER_PIN_L = 8.0  # verify
HCSR04_HEADER_PIN = 0.64  # verify — square post
HCSR04_HEADER_BODY_L = 10.2  # 4 × 2.54
HCSR04_HEADER_BODY = 2.54  # verify
HCSR04_HEADER_CLEARANCE = 1.0  # air around the header plastic and the housings
HCSR04_HEADER_OVERLAP = 0.3  # plastic bites the PCB so the outline is one solid
HCSR04_HEADER_BELOW_PCB = HCSR04_HEADER_BODY - HCSR04_HEADER_OVERLAP
# Common module: the header is on the bottom edge and the pins point down,
# in the plane of the board, past that edge. Confirm on the owner's part.
HCSR04_PINS_DOWN = True  # verify

# The board drops into a rear wall, side stops, end shelves and a short
# front lip that stays below the cans. With the pins down, the shelves stop
# either side of the header so the housings hang in the open centre.
HCSR04_SLOT_CLEARANCE = 0.45  # per face, PCB thickness direction
HCSR04_SIDE_CLEARANCE = 0.60  # per end, along the 45 mm edge
HCSR04_SHELF_CLEARANCE = 0.40  # under the PCB
HCSR04_LIP_TO_CAN = 1.0  # lip top stays this far under the can bottoms
HCSR04_WALL = 2.4

# ---------------------------------------------------------------------------
# Arduino Nano (CH340 clone). Outline 18 × 45 mm per Arduino Nano / A000005.
# ---------------------------------------------------------------------------

NANO_PCB_W = 18.0  # Arduino product page
NANO_OVERALL_L = 45.0  # Arduino product page, includes the mini-USB shell
NANO_PCB_L = 43.2  # verify — FR4; the shell overhang makes the 45 mm overall
NANO_PCB_T = 1.6  # verify
NANO_PIN_COUNT = 15  # each long edge
NANO_PIN_PITCH = 2.54  # Arduino Nano PCB guide
NANO_ROW_SPACING = 15.24  # verify — usual breadboard span; some drawings differ
NANO_PIN = 0.64
NANO_SHROUD = 2.54  # verify — header plastic height
NANO_PIN_BELOW_SHROUD = 8.0  # verify
NANO_USB_W = 7.7  # verify — mini-B shell
NANO_USB_H = 4.0  # verify
NANO_USB_L = 8.0  # verify
NANO_USB_OVERHANG = NANO_OVERALL_L - NANO_PCB_L  # 1.8 past the FR4

# ATmega328P-AU is a 7 × 7 mm TQFP-32 (Microchip package drawing). Where it
# sits on this clone is not.
NANO_MCU_BODY = 7.0
NANO_MCU_LEAD = 9.0
NANO_MCU_H = 1.0
NANO_MCU_X = 3.0  # verify — from PCB centre, toward the end opposite USB
NANO_MCU_Y = 0.0  # verify

# CH340G is SOP-16. Body size below is the usual 150 mil SOP-16, not measured
# from the WCH drawing in this session. Position is the common clone layout.
NANO_CH340_L = 10.0  # verify
NANO_CH340_W = 3.9  # verify
NANO_CH340_H = 1.5  # verify
NANO_CH340_X = -12.0  # verify — toward the USB end
NANO_CH340_Y = 0.0  # verify

# D13 ("L") LED. 0805 outline. Corner toward USB, component side.
NANO_D13_L = 2.0  # verify
NANO_D13_W = 1.25  # verify
NANO_D13_H = 0.8  # verify
NANO_D13_X = -15.0  # verify
NANO_D13_Y = 5.2  # verify

# Female Dupont housing. One housing per pin. The wire leaves it straight
# and needs DUPONT_BEND_GAP to turn. The rails are raised to leave that gap
# above the floor; the floor is not opened under the pins.
DUPONT_HOUSING_L = 14.0  # verify
DUPONT_HOUSING_W = 2.54  # verify — square section of one housing
DUPONT_BEND_GAP = 8.0  # verify — below every housing, before the wire turns

# Cradle. End rails, pins down, component side up. Long sides stay open.
NANO_RAIL_CLEARANCE = 0.35  # between rail top and the PCB
NANO_SIDE_CLEARANCE = 1.20  # PCB edge to the corner lip; leaves room for a housing
NANO_END_CLEARANCE = 0.80  # PCB end to the end stop
NANO_RAIL_H = NANO_SHROUD + DUPONT_HOUSING_L + DUPONT_BEND_GAP
NANO_RAIL_L = 12.0  # across the board, inboard of the pin rows
NANO_RAIL_W = 3.2
NANO_LIP_T = 1.8
NANO_LIP_ALONG = 6.0
# The servo block is wider than the case. The PCB's near end clears that block.
NANO_SERVO_GAP = 9.5  # case rear face to the near end of the PCB

# ---------------------------------------------------------------------------
# Dial
# ---------------------------------------------------------------------------

DIAL_R_OUT = 36.0
DIAL_R_IN = 18.5  # clears the tab corners
DIAL_T = 2.4
DIAL_HEEL = 1.5  # material past the diameter so the 0° and 180° ticks print
DIAL_SEAT_DEPTH = 1.2
DIAL_RADIAL_CLEARANCE = 0.50
DIAL_Z_CLEARANCE = 0.30  # dial underside above the seat floor
DIAL_TICK_W = 1.0
DIAL_TICK_R0 = 29.0
DIAL_TICK_R1 = 34.5
DIAL_ZERO_TICK_W = 1.6
DIAL_ZERO_TICK_R0 = 26.0
DIAL_ENGRAVE = 0.6
DIAL_DIGIT_H = 4.4
DIAL_DIGIT_W = 2.7
DIAL_DIGIT_STROKE = 0.90
DIAL_DIGIT_GAP = 0.55
DIAL_LABEL_R = 24.5

DIAL_MARKS_CM = (2, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100)
DIAL_LABELS_CM = (10, 50, 100)

# ---------------------------------------------------------------------------
# Base shell
# ---------------------------------------------------------------------------

FLOOR_T = 2.4
BASE_X_HALF = 48.0
BASE_Y_FRONT = 52.0
COLLAR_X = 19.0  # half-size of the servo block
COLLAR_Y = 12.5
SHELF_T = 3.0  # dial shelf; the seat is recessed into this
SHELF_WALL = 2.4  # radial wall outside the dial
RIB_T = 2.0
RIB_EVERY_DEG = 18.0
HOLDER_WALL = HCSR04_WALL

# Wire lane on the floor, -X side, clear of the dial shelf.
WIRE_RIB_H = 4.0
WIRE_RIB_T = 1.8
WIRE_LANE_X0 = -47.0
WIRE_LANE_X1 = -36.0
WIRE_LANE_Y0 = -52.0
WIRE_LANE_Y1 = 50.0  # forward to the sensor pin bay

# ---------------------------------------------------------------------------
# Stack. Derived from the fits above; do not retune these by hand.
# ---------------------------------------------------------------------------

BODY_BOTTOM_Z = FLOOR_T + MG90S_FLOOR_CLEARANCE
BODY_TOP_Z = BODY_BOTTOM_Z + MG90S_BODY_H
TAB_BOTTOM_Z = BODY_BOTTOM_Z + MG90S_TAB_UNDERSIDE
DECK_Z = TAB_BOTTOM_Z - MG90S_TAB_SEAT_CLEARANCE
BOSS_TOP_Z = BODY_TOP_Z + MG90S_BOSS_H
SPLINE_TOP_Z = BOSS_TOP_Z + MG90S_SPLINE_H

DIAL_BOTTOM_Z = DECK_Z - DIAL_SEAT_DEPTH + DIAL_Z_CLEARANCE
DIAL_TOP_Z = DIAL_BOTTOM_Z + DIAL_T
SHELF_BOTTOM_Z = DECK_Z - SHELF_T
SHELF_R = DIAL_R_OUT + DIAL_RADIAL_CLEARANCE + SHELF_WALL

FLAG_BOTTOM_Z = BOSS_TOP_Z + FLAG_ABOVE_BOSS
FLAG_TOP_Z = FLAG_BOTTOM_Z + FLAG_T

# Servo sweep must stay this far off the dial and the base. The designed
# vertical gap is several millimetres; the check uses this floor.
FLAG_SWEEP_CLEARANCE = 1.0

# Nano placement. Length runs along Y, USB toward -Y (out the back).
NANO_FAR_Y = -MG90S_BODY_W / 2.0 - NANO_SERVO_GAP
NANO_CY = NANO_FAR_Y - NANO_PCB_L / 2.0
NANO_CX = 0.0
NANO_PCB_BOTTOM_Z = FLOOR_T + NANO_RAIL_H + NANO_RAIL_CLEARANCE
NANO_USB_FACE_Y = NANO_FAR_Y - NANO_PCB_L - NANO_USB_OVERHANG
# Floor stops short of the mini-USB face so a plug can seat.
BASE_Y_REAR = NANO_USB_FACE_Y + 1.2
NANO_NEAR_RAIL_Y = NANO_FAR_Y - NANO_END_CLEARANCE - NANO_RAIL_W / 2.0 - 1.2
NANO_USB_RAIL_Y = (NANO_FAR_Y - NANO_PCB_L) + NANO_RAIL_W / 2.0 + 1.6

# Sensor placement. Cans point +Y. The PCB rear face sits SENSOR_GAP past the dial.
SENSOR_GAP = 8.0
HCSR04_Y = DIAL_R_OUT + SENSOR_GAP + HCSR04_PCB_T / 2.0
# Pins-down: header plastic, then a housing, then the bend, then a little air
# above the floor. Pins-back keeps the low shelf; nothing hangs below the board.
_HCSR04_UNDER_BOARD = (
    HCSR04_HEADER_BELOW_PCB + DUPONT_HOUSING_L + DUPONT_BEND_GAP + 0.6
    if HCSR04_PINS_DOWN
    else 5.0 - FLOOR_T
)
SENSOR_PCB_BOTTOM = FLOOR_T + _HCSR04_UNDER_BOARD
HCSR04_Z = SENSOR_PCB_BOTTOM + HCSR04_PCB_H / 2.0
# Walls grip the lower part of the board. The top stays open.
HCSR04_WALL_TOP = SENSOR_PCB_BOTTOM + 12.0

# Nominal pilot-slot centre, slightly outboard of the datasheet hole so the
# slot (length MG90S_PILOT_SLOT_L) still covers that hole.
MG90S_PILOT_X = MG90S_HOLE_SPACING / 2.0 + 0.4

SERVO_LIMITS_DEG = (0.0, 180.0)


def cm_to_deg(distance_cm: float) -> float:
    """Servo angle for a distance on the 2–100 cm scale."""
    return (distance_cm - 2.0) / 98.0 * 180.0


def polar(radius: float, angle_deg: float) -> tuple[float, float]:
    radians = math.radians(angle_deg)
    return radius * math.cos(radians), radius * math.sin(radians)
