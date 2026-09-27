"""Link meshes for ../robot/gauge.urdf.

Exports STL from the STEP files this folder already writes, plus the horn
solid (it lives inside mg90s.step, not as its own file). Does not change
the solids. Units are millimetres. The URDF scales them by 0.001.

Run from this directory, with the cad environment on PYTHONPATH:

    python meshes.py
"""

from pathlib import Path

import cadgen
from build123d import export_stl
from cadgen import build123d as bd
from cadgen.geometry import mass_properties

from base import base_shape
from dial import dial_shape
from flag import flag_shape
from lib.dimensions import BODY_BOTTOM_Z, DIAL_BOTTOM_Z, FLAG_BOTTOM_Z
from mg90s import mg90s_horn

HERE = Path(__file__).resolve().parent
MESHES = HERE.parent / "robot" / "meshes"
# kg/mm³. 1.24 g/cm³.
PLA = 1.24e-6
# The print sheet's base is solid in the STEP and printed at 15% infill.
BASE_INFILL = 0.15


def _export_step(name: str) -> None:
    cadgen.stl.build(HERE / "STEP" / f"{name}.step", MESHES / f"{name}.stl", force=True)


def _export_horn() -> None:
    # The horn is a solid inside mg90s.step, not its own STEP file.
    export_stl(mg90s_horn(), str(MESHES / "horn.stl"))


def _solid(shape: bd.Part) -> bd.Solid:
    solid = shape.solid()
    if solid is None:
        raise RuntimeError("shape has no single solid")
    return solid


def _report(label: str, props) -> None:
    # Inertia is kg·mm² about the centre of mass. URDF wants kg·m².
    i = props.inertia
    com = props.center_of_mass
    print(
        f"{label}: mass {props.mass:.6e} kg, "
        f"com {com.X / 1000:.6e} {com.Y / 1000:.6e} {com.Z / 1000:.6e} m"
    )
    print(
        "  ixx iyy izz "
        f"{i[0][0] * 1e-6:.6e} {i[1][1] * 1e-6:.6e} {i[2][2] * 1e-6:.6e}"
    )
    print(
        "  ixy ixz iyz "
        f"{i[0][1] * 1e-6:.6e} {i[0][2] * 1e-6:.6e} {i[1][2] * 1e-6:.6e}"
    )


def main() -> None:
    MESHES.mkdir(parents=True, exist_ok=True)
    _export_step("base")
    _export_step("dial")
    _export_step("flag")
    _export_horn()

    dial = bd.Pos(0, 0, DIAL_BOTTOM_Z) * dial_shape()
    flag = bd.Pos(0, 0, FLAG_BOTTOM_Z) * flag_shape()
    horn = bd.Pos(0, 0, BODY_BOTTOM_Z) * mg90s_horn()
    base = mass_properties([(_solid(base_shape()), PLA * BASE_INFILL), (_solid(dial), PLA)])
    moving = mass_properties([(_solid(flag), PLA), (_solid(horn), PLA)])
    _report("base link (15% base + solid dial)", base)
    _report("flag link (flag + horn, solid)", moving)


if __name__ == "__main__":
    main()
