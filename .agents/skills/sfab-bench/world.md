# Worlds

Bench runs one shared sim per `.world.json`. You play, pause, step, and
read that run. The Mac and Quest watch the same one. Your play or pause
is labeled **agent**.

`get_viewer` names the open file. Pass that project-relative path as
`world` on every tool below.

## The file

A world is version 2. Copy `examples/arm/arm.world.json` and its scene
part. Do not invent a second schema. Opening a file with `"version": 1`
fails. The error is **World v1 is no longer supported**, in the page and
from the world tools.

The world file is a root part plus environment and run settings:

- `version` is `2`.
- `environment` — `ground.plane`, `gravity`, optional primitives, optional
  STEP props.
- `run` — `seed`, and `levels.default` (the arm uses `1`).
- `root.part` — `publisher/name@version`, for the arm
  `sfab/arm-scene@1.0.0`.

The scene is a part file next to the world, `parts/sfab/arm-scene@1.0.0.json`.
Its netlist names the instances and the wires. Instance ids stay short
(`arm`, `uno`, `servo`, `usb`), so a wire is still `uno.D9`.

- A robot is `sfab/arm@1.0.0` with a pose. The URDF is the part's body,
  `robot/arm.urdf` in the arm example: one revolute joint, `shoulder`.
  Link meshes are STL or OBJ next to the URDF.
- A board is `sfab/uno-r3@1.0.0`. `params.firmware` is the `.hex`.
  `params.source` is the `.ino`, shown read-only.
- A servo is `sfab/sg90@1.0.0`. Its shaft wire is
  `["servo.shaft", "arm.shoulder"]` and its mount wire is
  `["servo.mount", "arm.base"]`.
- An MG90S is `sfab/mg90s@1.0.0`, the same wires, shaft and mount.
  It has no class 2; the control-IC composite is later.
- A supply is `sfab/usb-port-500ma@1.0.0` or `sfab/bench-supply@1.0.0`.
  Override `V`, `Ilimit`, and `Rs` in `params` when the instance is not
  the part's defaults.
- Electrical wires are pin-to-pin pairs, power and ground included:
  `["usb.5V", "uno.5V"]`, `["usb.GND", "uno.GND"]`,
  `["uno.D9", "servo.signal"]`, `["uno.5V", "servo.V+"]`,
  `["uno.GND", "servo.GND"]`.

`examples/arm/arm-stall.world.json` is the same arm with stall firmware
and a bench supply.

A part file is `sfab.part@1`: an id `publisher/name@version`, a type, and
axes (behaviour, body, visual) with numbered levels. Catalog parts live
under the server catalog. A part in the project's `parts/` shadows one.

## Load errors

`world_status` includes `diagnostics` when a board has no supply. The
load itself fails before a run exists:

- **World v1 is no longer supported** — the file says `"version": 1`.
  Write a version 2 world. Nothing converts the old file.
- `board uno: no supply reaches its 5V pin` — wire a supply `5V` to the
  board's `5V`. Until you do, the board never boots. Status says
  **unpowered**.
- A servo signal drives the joint only when one wire joins
  `servo.signal` straight to a board GPIO, including A0–A5. A hop
  through another pin does not.
- `mesh-format` — link meshes are `.stl` or `.obj` at a path relative to
  the URDF. Export STL with `$cad` (`cadgen stl build`).

## Firmware

Bench never compiles. Build the `.hex` outside, then let Bench watch it:

```bash
arduino-cli compile --fqbn arduino:avr:uno \
  --output-dir /tmp/hold-build firmware/hold/hold.ino
cp /tmp/hold-build/hold.ino.hex firmware/hold/hold.hex
```

The CLI writes `<sketch>.ino.hex` into `--output-dir`. Copy that file
onto the `.hex` path the board entry names (`firmware/hold/hold.hex` in
the arm). When that file changes, Bench restarts the board. Edit the
`.ino` with your own file tools. The source view in Bench is read-only.
There is no in-app compiler and no code editor.

`examples/arm/firmware/hold/hold.ino` writes 10°, then 90°, then 120°,
each for one second, and prints the angle. The stall sketch commands 180°.
On the bench supply the first pulse resets the board. The arm walks a
few degrees from those impulses and does not reach the stop.

## Run and check

Call these with the `world` path from `get_viewer`. Use sim time. Wait
for the status they return. Do not sample "whatever arrived last".

1. `world_restart` — sim time 0, paused, new recording.
2. `world_step` with `ms` from 1 to 10000 — pauses if it was playing,
   advances exactly that many milliseconds, returns `world_status`.
3. `read_pulses` with `part` — runs of pulse width (equal within 1 µs
   collapsed), each with `commandDeg` and the first and last sim time,
   plus that part's board and pin.
4. `read_recording` — tracks such as `part:servo.pulseUs`,
   `part:servo.voltage` (V+ relative to GND), `supply:usb.voltage`
   (the terminal), `board:uno.voltage` (the 5V node), `joint:shoulder`
   or `joint:arm/shoulder`, `board:uno.pins`. Default window is the last
   5 s, 50 frames, 500 max.
   Events in range are resets, reloads, faults, and serial lines. Serial
   text keeps the last 4000 characters and sets `truncated` when it drops
   the rest.
5. `read_serial` — that board's console. `send_serial` writes to it.
   Neither one plays or pauses.

`world_play` and `world_pause` are the shared run. The last command wins.
Every client shows **agent**.

On the hold arm, step about 3.5 s from a restart. `read_pulses` on
`servo` (D9) shows **647, 1472, and 1781 µs** (±4) for 10°, 90°, and 120°.
The same widths are on the `part:servo.pulseUs` track.

`world_status` lists driven pins only (`D9: out H`), joint positions in
degrees (metres for a prismatic joint), and each part's own board and pin
when several robots share a folder. `warnings` is an array of short
strings, empty when nothing is wrong: a board whose 5V node is above
brownout and below the 3.78 V an ATmega328P needs at 16 MHz, a hinge more
than 1° or a slide more than 1 mm past its limit, and any validator
warning on the document.
`read_recording` uses the same array for the range you asked for (the
worst limit violation in that range, and a 1 ms out-of-SOA dip kept the
way brownout is). It also returns `manifest`: MuJoCo and avr8js versions,
timestep, integrator, frame period, the world file's SHA-256, each
board's firmware path and the SHA-256 of the loaded `.hex`, and the
part-model catalog values in use. The manifest is fixed when the run is
built.

## A reset

The SG90 is a voltage-mode DC motor. Supply current is 10 mA plus
`max(0, s·I_motor)`, where `s` is the signed drive fraction. Braking
current does not come from the supply. The Uno draws 50 mA, including
while it is in reset. A supply is `V = V_nom − rSeries·I` up to
`currentLimit`; above that the rail sits where the draw equals the
limit. USB ("500 mA" port) is 5 V, 0.5 Ω, 0.9 A. A bench supply is
0.05 Ω with the voltage and current limit in the file.

`arm-stall.world.json` is a bench supply at 5 V / 0.3 A. The starting
current at rest pulls the rail to about 1.70 V: 0.3 A minus the 50 mA
board and the 10 mA servo electronics leaves 0.24 A through 7.1 Ω. The
board resets on the first pulse, holds 66 ms, reboots, and repeats. Each
of those steps torques the joint once and the open winding coasts, so in
2 s the arm walks a few degrees and does not reach the stop. The
ATmega328P resets below 2.675 V and releases
above 2.725 V. Pins float from the reset. The recording has a `reset`
event at the assert and a `reboot` event at the first instruction. The
same stall on the USB preset keeps the 5V node near 4.5 V, reaches the
joint stop, and does not reset. A stall display needs the drive saturated and slower
than 5 °/s for 20 ms.

To explain one: `world_restart` `arm-stall.world.json`, `world_step` 2000,
then `read_recording` from 0 to 2. Expect `resets` ≥ 1 on the board, a
`reset` event, a later `reboot`, and a board frame whose `minVoltage`
(the 5V node) is under 2.675. On a bench header that node equals the
supply terminal. The serial line `— brownout reset —` is on the reboot.
The board status says **in reset** through the 66 ms hold.

## Not yet

Sensors, ground contact, and rp2040 are later. Link meshes other than
STL or OBJ are rejected. Do not look for a breadboard, a net name, or a
regulator. Do not compile inside Bench, and do not edit the world or the
firmware through a world tool — change the files with your file tools,
then `world_restart` or let the `.hex` watch restart the board.
