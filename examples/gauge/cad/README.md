# Distance gauge

`$cad` geometry for the distance gauge. Shared millimetre constants live in `lib/dimensions.py`. Every fit clearance is a named constant there.

| Script | Output | Purpose |
| --- | --- | --- |
| base.py | STEP/base.step | Printed base: servo pocket, dial seat, Nano cradle, sensor clip, wire lane |
| dial.py | STEP/dial.step | Printed semicircular scale, separate from the base |
| flag.py | STEP/flag.step | Printed pointer that seats on the single-arm horn |
| coupon.py | STEP/coupon_servo.step | Fit coupon: MG90S pocket and screw slots |
| coupon.py | STEP/coupon_horn.step | Fit coupon: horn pocket, opened upward |
| coupon.py | STEP/coupon_sensor.step | Fit coupon: HC-SR04 cradle, same shelves and lip |
| nano.py | STEP/nano.step | Bought CH340 Nano, outline only |
| mg90s.py | STEP/mg90s.step | Bought MG90S body and single-arm horn |
| hcsr04.py | STEP/hcsr04.step | Bought HC-SR04, outline only |
| gauge.py | STEP/gauge.step | Assembly at 0°. Sidecar `STEP/gauge.step.json` |
| check.py | — | Closed solids, clearances, flag sweep, Dupont keep-outs |
| meshes.py | ../robot/meshes/*.stl | STL for the URDF. Does not change the STEP |

Build, from this directory:

```bash
python gauge.py
python check.py
```

`gauge.py` writes every STEP. The three coupons are separate prints and stay out of the assembly. Units are millimetres.

## Frame

Origin on the bed, on the servo shaft. +Z up. +Y toward the target. +X to the right when looking along +Y. The flag at 0° points along +X (2 cm). Angle increases counter-clockwise from above:

```text
angle_deg = (distance_cm - 2) / 98 * 180
```

Named solids: `base`, `dial`, `flag`, `nano`, `mg90s`, `horn`, `hcsr04`. The horn and the flag are grouped as `servo_output`. Revolute `servo` turns that group about +Z through the origin, limits 0–180°. Poses `deg0`, `deg90`, `deg180`.

## Assembly

1. Print the three coupons first. Try the MG90S in the servo coupon, the horn in the horn coupon, and the HC-SR04 in the sensor coupon. Then print the base, the dial, and the flag.
2. Seat the servo in the pocket, tabs on the deck, cable toward the Nano (−Y). The two stock screws go through the tabs into the slots.
3. Drop the dial into the seat, engraved face up. The long tick is 0° and lies on +X.
4. Clip the HC-SR04 into the front holder, cans toward +Y. The pins point down, in the plane of the board. Four female Dupont housings hang in the open centre, under the shelves. Their wires turn and run under the shelf to the lane on the −X side.
5. Set the Nano on the rails, pins down, mini-USB out the back.
6. Upload the firmware. With the servo at its 0° pulse, press the single-arm horn onto the spline so the arm points along +X, at the long tick. The flag's pocket goes over that horn; the horn screw clamps it. The spline tooth that lands on 0° is chosen at this step.

Wires from the sensor and the servo join the floor lane on the −X side, and run through the bay under the dial shelf to the Nano. The servo cable uses the notch on the −Y face of the collar. Under the Nano, each Dupont housing has 8 mm of air below it before the wire turns; the rails are raised to leave that air above the floor.

## Decisions

- The dial is its own print, in a D-shaped seat, so a bad scale can be reprinted without the base.
- The Nano sits pins-down on two end rails, component side up. That keeps the mini-USB and the D13 LED on the top face, and leaves the long edges open for female Dupont housings and the wires leaving them. The rails are tall enough for a housing plus an 8 mm bend above the floor. The floor stays closed under the pins.
- The HC-SR04 pins point down, in the plane of the board (`HCSR04_PINS_DOWN`). The shelves stop either side of the header so the housings hang free, and the wires leave under the shelf to the −X lane. The owner's module is this way.
- The fit coupons are three small prints. Each one calls the same pocket or cradle as the base.
- The scale is horizontal, under the flag. Standing in front of the sensor (+Y) and looking down, the flag and the dial are both in view. Number labels are turned so they read upright from that side. The long tick at 0° is the degree mark; 10, 50 and 100 cm are numbered. "100" sits at 168° so the glyphs stay on the plate.
- The servo's tab holes are short slots, not round pilots, so a hole-spacing error still takes the stock screws.
- The flag is one slab. Its pocket opens downward onto the horn and is held by the horn screw. Print it pocket-up.
- The collar is solid in the model. Infill is a slicer setting; a modelled cavity deleted the pocket walls.
- The spline is a smooth cylinder. Teeth are not modelled.

## Sources

Outline dimensions that are not marked `verify` in `lib/dimensions.py`:

- Arduino Nano, 18 × 45 mm, mini-USB: [Arduino Nano](https://docs.arduino.cc/hardware/nano/) and [A000005 datasheet](https://docs.arduino.cc/resources/datasheets/A000005-datasheet.pdf). Header pitch 2.54 mm: [Nano PCB guide](https://docs.arduino.cc/learn/hardware/nano-pcb-guide).
- ATmega328P-AU, TQFP-32, 7 × 7 mm body, 9 × 9 mm lead span: Microchip package drawing. Where it sits on the clone is a `verify` value.
- TowerPro MG90S, 22.8 × 12.2 × 28.5 mm, tab span A = 32.5, table F = 18.5: [MG90S product page](https://towerpro.com.tw/product/mg90s-3/). The same page lists D = 12.4 mm against a 12.2 mm dimension line. The model uses 12.2 mm; the pocket clearance covers 12.4 mm.
- HC-SR04, envelope 45 × 20 × 15 mm, 2.54 mm header: HandsOnTec `HC-SR04-Ultrasonic.pdf`.

## Dimensions to verify

These are in `lib/dimensions.py` with a `# verify` comment. Fits are loose because the only measuring tool is a tape measure.

| Name | Assumed | Why it is open |
| --- | --- | --- |
| MG90S_TAB_UNDERSIDE | 18.5 mm | TowerPro table "F"; the page does not define the letter |
| MG90S_TAB_T | 2.5 mm | tabs drawn flush with the case top |
| MG90S_BOSS_H | 4.0 mm | gear cover above the case |
| MG90S_BOSS_D | 11.6 mm | gear cover diameter |
| MG90S_SPLINE_D | 4.8 mm | smooth outline; teeth omitted |
| MG90S_HOLE_SPACING | 28.0 mm | not on the TowerPro page; slots absorb the error |
| MG90S_HOLE_D | 2.2 mm | tab hole |
| MG90S_HORN_HUB_D | 7.2 mm | single-arm horn |
| MG90S_HORN_HUB_H | 3.2 mm | single-arm horn |
| MG90S_HORN_ARM_T | 1.5 mm | single-arm horn |
| MG90S_HORN_ARM_W | 4.8 mm | single-arm horn |
| MG90S_HORN_ARM_L | 18.0 mm | hub centre to tip |
| MG90S_HORN_SCREW_D | 2.2 mm | hole through the horn |
| MG90S_HORN_HOLE_D | 1.2 mm | three holes on the arm |
| MG90S_HORN_HOLE_X | 8, 12, 16 mm | those holes along the arm |
| MG90S_CABLE_W | 4.0 mm | jacket leaving the case |
| MG90S_CABLE_H | 3.0 mm | jacket |
| MG90S_CABLE_STUB | 3.0 mm | how far the jacket sticks out |
| MG90S_CABLE_Z | 4.5 mm | stub centre above the case bottom |
| FLAG_COUNTERBORE_D | 4.4 mm | stock horn-screw head |
| HCSR04_PCB_T | 1.6 mm | board thickness |
| HCSR04_CAN_D | 16.0 mm | usual TCT40-16 can; the module drawing's height is 15 mm |
| HCSR04_CAN_H | 12.0 mm | can protrusion; 1.6 + 12 matches the 15 mm envelope |
| HCSR04_CAN_SPACING | 25.0 mm | centre to centre |
| HCSR04_CAN_Z | 2.0 mm | can centre above the board centre |
| HCSR04_CRYSTAL_L | 8.0 mm | crystal between the cans |
| HCSR04_CRYSTAL_W | 3.6 mm | crystal |
| HCSR04_CRYSTAL_H | 3.2 mm | crystal |
| HCSR04_HEADER_PIN_L | 8.0 mm | right-angle posts |
| HCSR04_HEADER_PIN | 0.64 mm | square post |
| HCSR04_HEADER_BODY | 2.54 mm | header plastic |
| NANO_PCB_L | 43.2 mm | FR4; the shell makes the 45 mm overall |
| NANO_PCB_T | 1.6 mm | board thickness |
| NANO_ROW_SPACING | 15.24 mm | usual breadboard span |
| NANO_SHROUD | 2.54 mm | header plastic |
| NANO_PIN_BELOW_SHROUD | 8.0 mm | pin tail |
| NANO_USB_W | 7.7 mm | mini-B shell |
| NANO_USB_H | 4.0 mm | mini-B shell |
| NANO_USB_L | 8.0 mm | mini-B shell |
| NANO_MCU_X | 3.0 mm | TQFP from the board centre, away from USB |
| NANO_MCU_Y | 0.0 mm | TQFP across the board |
| NANO_CH340_L | 10.0 mm | usual 150 mil SOP-16 |
| NANO_CH340_W | 3.9 mm | SOP-16 |
| NANO_CH340_H | 1.5 mm | SOP-16 |
| NANO_CH340_X | −12.0 mm | toward the USB end |
| NANO_CH340_Y | 0.0 mm | across the board |
| NANO_D13_L | 2.0 mm | 0805 LED |
| NANO_D13_W | 1.25 mm | 0805 LED |
| NANO_D13_H | 0.8 mm | 0805 LED |
| NANO_D13_X | −15.0 mm | toward the USB end |
| NANO_D13_Y | 5.2 mm | toward one long edge |
| DUPONT_HOUSING_L | 14.0 mm | female Dupont housing |
| DUPONT_HOUSING_W | 2.54 mm | female Dupont housing |
| DUPONT_BEND_GAP | 8.0 mm | air below each housing before the wire turns |
