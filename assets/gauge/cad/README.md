# Distance gauge: renders and print files

Snapshot of the gauge CAD output, saved so it is not only on one machine.

The sources are not copied here. The CadQuery scripts, `lib/dimensions.py` and
the STEP files live in [`examples/gauge/cad/`](../../../examples/gauge/cad/).
The geometry there has not changed since these files were made (`a8ece1d`;
later commits only touched the README and added `meshes.py` for the STL).

| Folder | Contents |
| --- | --- |
| `renders/` | 13 PNG renders: the assembly from three sides, the flag at 0°, 90° and 180°, each printed part, the fit coupon, and the bought Nano, MG90S and HC-SR04 outlines |
| `print/` | 3MF print files for the three fit coupons, the flag, the dial and the base. Orientation, infill, times and masses: the print sheet below |

## State

- **Three print fixes are still open.** The files here are from before them.
  Rebuild from `examples/gauge/cad/` once they are made, then replace these files.
- The HC-SR04 pins point down, in the plane of the board (`HCSR04_PINS_DOWN`
  in `lib/dimensions.py`). That matches the owner's module.

## Print sheet

PLA, 0.4 mm nozzle, 0.2 mm layers, 3 perimeters, no supports. Mass is solid
volume × 1.24 g/cm³; time assumes 4 mm³/s. No slicer was run. Print the
coupons first and adjust the named clearance in `lib/dimensions.py` if a fit is
tight.

| Order | File | Orientation | Infill | Time | Mass |
| --- | --- | --- | --- | --- | --- |
| 1 | coupon_servo.3mf | pocket up, floor on the bed | 100% | 10 min | 3.01 g |
| 2 | coupon_horn.3mf | pocket up, lid on the bed | 100% | 5 min | 1.41 g |
| 3 | coupon_sensor.3mf | ribs on the bed, cradle up | 100% | 17 min | 5.17 g |
| 4 | flag.3mf | pocket up, lid on the bed | 100% | 6 min | 1.78 g |
| 5 | dial.3mf | underside on the bed, engraving up | 100% | 15 min | 4.52 g |
| 6 | base.3mf | floor on the bed, features up | 15% | 3 h 58 min | 70.7 g solid |
