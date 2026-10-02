"""Upper arm link: 120 × 20 × 10 mm bar along +X, frame at the shoulder end."""

from cadgen import build123d as bd
from cadgen import step, stl

from lib.dimensions import UPPER_X_MM, UPPER_Y_MM, UPPER_Z_MM


@step(out="../STEP/upper_arm.step")
@stl(out="../meshes/upper_arm.stl")
def upper_arm():
    # Box is centered. Shift +X by half the length so the proximal face is x=0
    # and the shoulder axis (+Z) passes through the center of that face.
    body = bd.Pos(UPPER_X_MM / 2.0, 0, 0) * bd.Box(UPPER_X_MM, UPPER_Y_MM, UPPER_Z_MM)
    body.label = "upper_arm"
    return body


if __name__ == "__main__":
    upper_arm()
