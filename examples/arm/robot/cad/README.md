# Models

`$cad` geometry for `examples/arm`. Shared millimetre constants live in `lib/`, which these scripts import.

| Script | Output | Purpose |
| --- | --- | --- |
| base.py | ../STEP/base.step, ../meshes/base.stl | Fixed 60×60×20 mm base, link frame at bottom-face center |
| upper_arm.py | ../STEP/upper_arm.step, ../meshes/upper_arm.stl | 120×20×10 mm bar, link frame at the shoulder end |
| arm.py | ../STEP/arm.step | Assembly at the shoulder zero pose, revolute mate `shoulder` about +Z, 0–150° |

Build: `python arm.py` from `examples/arm/robot/cad`. That writes the assembly STEP and both link meshes.
Units are millimetres. PLA density 1.24 g/cm³ is applied in the URDF inertials, not in the STEP.
