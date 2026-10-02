"""Shared millimetre dimensions for the one-joint arm.

Link frames are the frames the URDF uses. Each part model returns geometry
already expressed in its link frame, so the STL export is identity-placed.
"""

# PLA, 1.24 g/cm³. mass_properties wants kg/mm³.
PLA_DENSITY_G_PER_CM3 = 1.24
PLA_DENSITY_KG_PER_MM3 = 1.24e-6

# base: 60 × 60 × 20 mm block. Link frame at the center of the bottom face.
BASE_X_MM = 60.0
BASE_Y_MM = 60.0
BASE_Z_MM = 20.0

# upper_arm: 120 × 20 × 10 mm bar along +X.
# Link frame at the shoulder: center of the proximal end face, +Z through it.
UPPER_X_MM = 120.0
UPPER_Y_MM = 20.0
UPPER_Z_MM = 10.0

# Shoulder sits on the base top face, raised by half the bar thickness so the
# bar's bottom face is coincident with the base top (no penetration).
SHOULDER_Z_MM = BASE_Z_MM + UPPER_Z_MM / 2.0
SHOULDER_LIMITS_DEG = (0.0, 150.0)
