"""Fit checks for the distance gauge.

Run from this directory:

    python check.py

Lengths are millimetres. A line starts with PASS or FAIL. The process exits
1 if any check fails.
"""

from __future__ import annotations

import sys
from pathlib import Path

from cadgen import build123d as bd
from cadgen import read_step, read_scene
from cadgen.geometry import boundary_edges, closest_points, overlap_volume, topology_errors

from lib.fits import hcsr04_dupont_keepouts, nano_dupont_keepouts
from lib.dimensions import (
    BODY_BOTTOM_Z,
    BOSS_TOP_Z,
    DECK_Z,
    DIAL_BOTTOM_Z,
    DIAL_HEEL,
    DIAL_R_OUT,
    DIAL_RADIAL_CLEARANCE,
    DIAL_Z_CLEARANCE,
    FLAG_HORN_SIDE_CLEARANCE,
    FLAG_SWEEP_CLEARANCE,
    HCSR04_CAN_D,
    HCSR04_CAN_Z,
    HCSR04_HEADER_BODY,
    HCSR04_HEADER_BODY_L,
    HCSR04_HEADER_CLEARANCE,
    HCSR04_PINS_DOWN,
    HCSR04_LIP_TO_CAN,
    HCSR04_PCB_L,
    HCSR04_PCB_T,
    HCSR04_SHELF_CLEARANCE,
    HCSR04_SIDE_CLEARANCE,
    HCSR04_SLOT_CLEARANCE,
    HCSR04_WALL,
    HCSR04_Y,
    HCSR04_Z,
    MG90S_BODY_L,
    MG90S_BODY_W,
    MG90S_CABLE_H,
    MG90S_CABLE_NOTCH_CLEARANCE,
    MG90S_CABLE_W,
    MG90S_CABLE_Z,
    MG90S_FLOOR_CLEARANCE,
    MG90S_HORN_ARM_L,
    MG90S_HORN_ARM_T,
    MG90S_HORN_ARM_W,
    MG90S_POCKET_CLEARANCE,
    MG90S_TAB_SEAT_CLEARANCE,
    NANO_FAR_Y,
    NANO_LIP_ALONG,
    NANO_NEAR_RAIL_Y,
    NANO_PCB_BOTTOM_Z,
    NANO_PCB_T,
    NANO_PCB_W,
    NANO_RAIL_CLEARANCE,
    NANO_SIDE_CLEARANCE,
    SENSOR_PCB_BOTTOM,
    TAB_BOTTOM_Z,
)

ROOT = Path(__file__).resolve().parent
STEP = ROOT / "STEP"
TOL = 0.08
FAILURES = 0


def report(ok: bool, message: str) -> None:
    global FAILURES
    if not ok:
        FAILURES += 1
    print(f"{'PASS' if ok else 'FAIL'} {message}")


def expect(name: str, measured: float, expected: float) -> None:
    ok = measured > 0.05 and abs(measured - expected) <= TOL
    report(ok, f"{name}: {measured:.3f} mm (expected {expected:.3f})")


def closed_solid(path: Path, label: str) -> None:
    shape = read_step(str(path))
    solids = list(shape.solids())
    issues = []
    if len(solids) != 1:
        issues.append(f"{len(solids)} solids")
    for solid in solids:
        if solid.volume <= 0:
            issues.append(f"volume {solid.volume:.1f}")
        topo = topology_errors(solid)
        if topo:
            issues.append(f"topology {[item.code for item in topo]}")
        free = []
        for shell in solid.shells():
            free.extend(boundary_edges(shell))
        if free:
            issues.append(f"{len(free)} free edges")
    if issues:
        report(False, f"{label}: " + "; ".join(issues))
    else:
        report(True, f"{label}: one closed solid, volume {solids[0].volume:.1f} mm^3")


def _keepouts_clear(title: str, boxes, solids) -> None:
    """Female housings and their bend gaps must miss every printed solid."""
    hits = 0
    for box_name, box in boxes:
        for solid_name, solid in solids:
            # The assembly sensor keep-outs are not meant to miss the coupon,
            # and the coupon keep-outs are not meant to miss the base.
            if title.startswith("HC-SR04 dupont") and solid_name == "coupon_sensor":
                continue
            if title.startswith("nano") and solid_name == "coupon_sensor":
                continue
            volume = overlap_volume(box, solid)
            if volume > 0.01:
                hits += 1
                report(False, f"{title} {box_name} vs {solid_name}: {volume:.4f} mm^3")
    if hits == 0:
        report(True, f"{title}: housings and bend gaps clear of printed parts")


def gap_at(point: tuple[float, float, float], other) -> float:
    """Distance from a point on a mating face to the other solid."""
    return closest_points(bd.Vertex(*point), other).distance


def main() -> None:
    for name in ("base", "dial", "flag", "coupon_servo", "coupon_horn", "coupon_sensor"):
        closed_solid(STEP / f"{name}.step", name)

    scene = read_scene(str(STEP / "gauge.step"))
    labels = ("base", "dial", "flag", "nano", "mg90s", "horn", "hcsr04")
    solids = {}
    for label in labels:
        found = list(scene.resolve(f"#{label}").shape().solids())
        report(len(found) == 1, f"assembly #{label}: {len(found)} solid(s)")
        if found:
            solids[label] = found[0]

    bought = ("nano", "mg90s", "horn", "hcsr04")
    printed = ("base", "dial", "flag")
    for left in bought:
        for right in printed:
            if left not in solids or right not in solids:
                report(False, f"overlap {left} vs {right}: missing solid")
                continue
            volume = overlap_volume(solids[left], solids[right])
            report(volume <= 0.01, f"overlap {left} vs {right}: {volume:.4f} mm^3")

    base = solids.get("base")
    pocket_z = (BODY_BOTTOM_Z + DECK_Z) / 2.0
    if base is not None:
        expect(
            "MG90S pocket +X",
            gap_at((MG90S_BODY_L / 2.0, 0.0, pocket_z), base),
            MG90S_POCKET_CLEARANCE,
        )
        expect(
            "MG90S pocket +Y",
            gap_at((0.0, MG90S_BODY_W / 2.0, pocket_z), base),
            MG90S_POCKET_CLEARANCE,
        )
        expect(
            "MG90S floor",
            gap_at((0.0, 0.0, BODY_BOTTOM_Z), base),
            MG90S_FLOOR_CLEARANCE,
        )
        expect(
            "MG90S tab seat",
            gap_at((MG90S_BODY_L / 2.0 + 2.0, 2.0, TAB_BOTTOM_Z), base),
            MG90S_TAB_SEAT_CLEARANCE,
        )
        stub_y = -MG90S_BODY_W / 2.0 - 1.5 + 0.2
        expect(
            "MG90S cable notch",
            gap_at((MG90S_CABLE_W / 2.0, stub_y, BODY_BOTTOM_Z + MG90S_CABLE_Z), base),
            MG90S_CABLE_NOTCH_CLEARANCE,
        )

    if base is not None:
        expect(
            "HC-SR04 side",
            gap_at((HCSR04_PCB_L / 2.0, HCSR04_Y, HCSR04_Z), base),
            HCSR04_SIDE_CLEARANCE,
        )
        expect(
            "HC-SR04 slot",
            gap_at((0.0, HCSR04_Y - HCSR04_PCB_T / 2.0, HCSR04_Z), base),
            HCSR04_SLOT_CLEARANCE,
        )
        expect(
            "HC-SR04 shelf",
            gap_at((10.0, HCSR04_Y, SENSOR_PCB_BOTTOM), base),
            HCSR04_SHELF_CLEARANCE,
        )
        if not HCSR04_PINS_DOWN:
            # Header body, just inside the rear-wall window, on its +X face.
            header_z = SENSOR_PCB_BOTTOM + HCSR04_HEADER_BODY / 2.0
            header_y = HCSR04_Y - HCSR04_PCB_T / 2.0 - HCSR04_HEADER_BODY / 2.0 + 0.15
            expect(
                "HC-SR04 header window",
                gap_at((HCSR04_HEADER_BODY_L / 2.0, header_y, header_z), base),
                HCSR04_HEADER_CLEARANCE,
            )
        can_bottom = HCSR04_Z + HCSR04_CAN_Z - HCSR04_CAN_D / 2.0
        lip_y = HCSR04_Y + HCSR04_PCB_T / 2.0 + HCSR04_SLOT_CLEARANCE + HCSR04_WALL / 2.0
        expect(
            "HC-SR04 lip below can",
            gap_at((0.0, lip_y, can_bottom), base),
            HCSR04_LIP_TO_CAN,
        )

    if base is not None:
        expect(
            "Nano side",
            gap_at(
                (
                    NANO_PCB_W / 2.0,
                    NANO_FAR_Y - NANO_LIP_ALONG / 2.0,
                    NANO_PCB_BOTTOM_Z + NANO_PCB_T / 2.0,
                ),
                base,
            ),
            NANO_SIDE_CLEARANCE,
        )
        expect(
            "Nano rail",
            gap_at((0.0, NANO_NEAR_RAIL_Y, NANO_PCB_BOTTOM_Z), base),
            NANO_RAIL_CLEARANCE,
        )

    pointer = solids.get("flag")
    if pointer is not None:
        arm_z = BOSS_TOP_Z + MG90S_HORN_ARM_T / 2.0
        expect(
            "flag horn side",
            gap_at((MG90S_HORN_ARM_L * 0.65, MG90S_HORN_ARM_W / 2.0, arm_z), pointer),
            FLAG_HORN_SIDE_CLEARANCE,
        )

    dial = solids.get("dial")
    if base is not None and dial is not None:
        # Midway up the seated band. Above the deck the seat wall has ended.
        seated_z = DIAL_BOTTOM_Z + 0.4
        expect(
            "dial radial",
            gap_at((0.0, DIAL_R_OUT, seated_z), base),
            DIAL_RADIAL_CLEARANCE,
        )
        expect(
            "dial heel",
            gap_at((24.0, -DIAL_HEEL, seated_z), base),
            DIAL_RADIAL_CLEARANCE,
        )
        expect(
            "dial seat",
            gap_at((0.0, 20.0, DIAL_BOTTOM_Z), base),
            DIAL_Z_CLEARANCE,
        )

    if pointer is not None and dial is not None and base is not None:
        worst = None
        for deg in range(0, 181, 15):
            moved = bd.Rot(0, 0, float(deg)) * pointer
            clearance = min(
                closest_points(moved, dial).distance,
                closest_points(moved, base).distance,
            )
            if worst is None or clearance < worst[0]:
                worst = (clearance, deg)
        ok = worst is not None and worst[0] >= FLAG_SWEEP_CLEARANCE
        report(
            ok,
            f"flag sweep 0-180: min {worst[0]:.3f} mm at {worst[1]} deg (limit {FLAG_SWEEP_CLEARANCE:.2f})",
        )

    printed = []
    for key in ("base", "dial", "flag"):
        if key in solids:
            printed.append((key, solids[key]))
    sensor_coupon = STEP / "coupon_sensor.step"
    if sensor_coupon.exists():
        coupon_solids = list(read_step(str(sensor_coupon)).solids())
        if len(coupon_solids) == 1:
            printed.append(("coupon_sensor", coupon_solids[0]))
    _keepouts_clear("nano dupont", nano_dupont_keepouts(), printed)
    _keepouts_clear("HC-SR04 dupont", hcsr04_dupont_keepouts(0.0, HCSR04_Y), printed)
    # The sensor coupon sits the cradle at the origin, same height as the base.
    coupon_only = [item for item in printed if item[0] == "coupon_sensor"]
    if coupon_only:
        _keepouts_clear("HC-SR04 coupon", hcsr04_dupont_keepouts(0.0, 0.0), coupon_only)

    if FAILURES:
        print(f"{FAILURES} failed")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
