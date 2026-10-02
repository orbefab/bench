"""Fixed base link: 60 × 60 × 20 mm block, frame at the bottom-face center."""

from cadgen import build123d as bd
from cadgen import step, stl

from lib.dimensions import BASE_X_MM, BASE_Y_MM, BASE_Z_MM


@step(out="../STEP/base.step")
@stl(out="../meshes/base.stl")
def base():
    # Box is centered. Shift +Z by half the height so the bottom face is z=0.
    body = bd.Pos(0, 0, BASE_Z_MM / 2.0) * bd.Box(BASE_X_MM, BASE_Y_MM, BASE_Z_MM)
    body.label = "base"
    return body


if __name__ == "__main__":
    base()
