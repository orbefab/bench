# ADR-0009: The world is the document

**Status:** Accepted. Amended by [0010](0010-layered-simulation.md) for analog circuits and part levels. World v1 was replaced by World v2. The world file is superseded by [0011](0011-one-document-kind.md) (the part is the only document) once A3 lands.
**Date:** 2026-09-24
**Deciders:** Alwurts

## Context

Bench has been a CAD workbench: open a folder, open a STEP, talk. It is a
robotics simulation platform. You open one world, and chat sits with that
view. CAD, firmware, electronics, and physics are the tools around it.
Reinforcement learning is later, and it runs outside Bench.

The shape is already feasible. A `$cad` URDF whose link meshes are STL
loads in `@mujoco/mujoco` 3.14.0 under Node: the meshes come in through a
virtual filesystem, `fusestatic` is false, and `mjs_attach` joins the
robot to a ground plane. Commanding the shoulder to 90° for two seconds
ends at 89.977°, with two meshes and a body per link. An unmodified
Arduino `Servo.h` sweep on an ATmega328P in avr8js 0.21.1 lands every
completed pulse within ±4 µs of 647, 1472, and 1781 µs, with no outliers.
Lockstepped with that arm, one millisecond at a time, ten seconds of
simulation take 1.790 seconds in the worker: about 5.5× real time
(5.588×). The AVR is almost all of that cost.

This record does not add the runtime. The server still loads STEP. Nothing
in the tree steps a world yet.

## Decision

**The server runs one world per document. The page is a client of that run.**

The runtime is headless and server-side, one per world document. It steps
MuJoCo and the board in lockstep through part models, records the run, and
streams transforms and signals to the viewer. The viewer is the existing
three.js / r3f stack, on the Mac and in Quest Browser. Physics is MuJoCo.
The board is avr8js. rp2040js is later. `micro-emulator` is later, and it
is separate.

A part model is Bench's behaviour for a servo, a motor, or a sensor,
between pins and the physics.

### Document

A world is `<name>.world.json` in the project folder, opened with
`?world=`. World v2 is one root part, the environment, and the run
settings. The server builds one MuJoCo model from that file. The file
ships with a Bench skill. A file with `"version": 1` does not load.
A lone STEP or a
lone URDF opens as a world too — one static object, or one posable robot —
so there is one viewer. That opening is later.

### Robot

A robot is a `.urdf` in the project, written outside Bench. Bench does not
learn which tool wrote it. Servos and sensors are not in the URDF. They
live in the wiring.

For milestone 1, every link mesh is `.stl` or `.obj` at a path relative to
the URDF. The validator rejects anything else, and hints to export STL
with `$cad` (`cadgen stl build`). MuJoCo's URDF compiler runs with
`fusestatic` false, so every link keeps a body for the transform stream,
and the validator warns on duplicate mesh basenames. D-003 had Bench
convert any other mesh to STL. D-010 amends that: milestone 1 meshes are
already STL or OBJ. 3MF and GLB conversion, and `package://` resolution,
are later.

Later, and not blocking: if a STEP has cadgen sidecar mates, the CAD lens
shows its pose sliders read-only.

### Wires and power

In the world file, `wires` are pin-to-pin pairs, including power and
ground. There is no breadboard, no net names, and no discrete resistors.
`parts` name a part model and what it drives or reads in the physics (a
joint or a site). The validator and the runtime check for a missing
ground, a voltage mismatch, and two outputs driving each other. A part
driven by `analogWrite` must sit on a PWM-capable pin. A Servo part may
use any digital pin, because `Servo.h` does. The validator warns when an
`analogWrite` part sits on D9 or D10 while any Servo is wired.

A supply is a nominal voltage, a series resistance, and a hard current
limit. While the draw is at or under the limit,
`V = V_nom − R_s · I`. Above it, the rail is the voltage where the
voltage-dependent loads draw exactly the limit. The Uno draws 50 mA,
including in reset. An SG90 is a voltage-mode DC motor
(`I = (V_drive − K·ω) / R`, `τ = η·K·I`); its supply current is 10 mA
plus `max(0, s·I_motor)`, where `s = V_drive / V_rail`. Braking current
does not come from the supply. A rail that falls through the ATmega328P
brown-out detector resets the board, and the recording shows that.
Revised 2026-09-25 (fidelity): see D-017. ADR 0010 makes the circuit the
run's rail; the formulas here are the class-1 reference. The USB "500 mA"
preset is 5 V, `R_s = 0.5 Ω`, `I_limit = 0.9 A`, and one stalled SG90
holds the USB terminal near 4.65 V and, through the Uno's fuse and switch,
the board node near 4.5 V without a reset. A bench preset is `R_s = 0.05 Ω` with the file's
voltage and current limit. At 5 V / 0.3 A the starting current at rest
pulls the rail to about 1.70 V (0.3 A − 50 mA board − 10 mA quiescent
leaves 0.24 A through 7.1 Ω). The board resets on the first pulse, holds
66 ms, reboots, and repeats. The torque of each assert step coasts while
the winding is open, so the arm walks a few degrees and does not reach
the stop. Reset asserts
below 2.675 V and releases above 2.725 V (extended fuse `0xFD`, BODLEVEL
2.7 V). The CPU then stays in reset for 66 ms before the first
instruction. Pins are Hi-Z from the assert. The torque of the assert
step matches the current charged on that step. There is no bootloader
delay on brownout. The recording stamps `reset` when reset asserts and
`reboot` at the first instruction.

Wires, those checks, and the power budget are all milestone 1. Left out of
the format until added later, without breaking it: SPICE and other analog
simulation, heat, wire resistance, a breadboard view, KiCad import.

### Firmware

Bench never compiles. A board entry names the firmware artifact (`.hex`
for AVR). The agent or the user builds it with their toolchain (the
starter documents `arduino-cli`; that firmware section is a follow-up
after milestone 1). Bench watches the artifact and restarts that board
when the file changes, the way a STEP reloads. Source files in the
folder show read-only. There is no in-app code editor.

### One shared run

For a world, the run is shared per document: play state, sim time, poses,
and signals. The Mac, Quest, and the agent attach to that one run. Camera,
selection, lens, and timeline scrub stay per client. Any client or the
agent may play or pause. The last command wins. The event names who sent
it, and every client shows who sent it.

Milestone 1 is demo 1, judged on the pipe. On the Mac, an unmodified
Arduino `Servo.h` sweep moves a one-joint arm made of STEP parts, in a
world file. The timeline scrubs. The agent can run it and read pulse
widths. Quest opens that world, sees the same run live, and has one
play/pause control in the existing XR chrome. Chat on Quest behaves as it
does today. Quest has no timeline, board panel, console, or pin inspection
in milestone 1. Browser evidence for the Quest path uses IWER.

Demo 2 is later: a sensor, ground contact, a wheeled robot. RL export is
later.

## Settled decisions

One line each, as settled. D-002, D-013, and D-016 are named and not
product rules.

- **D-001.** Milestone 1 = probes, cleanup on main, and demo 1 (the world document, runtime, Mac and Quest viewers, avr8js board, wires, power budget, timeline, and agent tools). An unmodified Arduino `Servo.h` sweep moves a one-joint arm made of STEP parts, in a world file, on the Mac. The timeline scrubs. The agent can run it and read pulse widths. Demo 2 (a sensor and ground contact) and later stay as rough rows.
- **D-002.** workspace/process decision, not product.
- **D-003.** A robot is a `.urdf` in the project, written with `$urdf` (link meshes from `$cad`, bought parts from `$step-parts`) or exported by any CAD tool. In milestone 1 the link meshes are already `.stl` or `.obj` at paths relative to the URDF (D-010); converting other meshes is later. Servos and sensors live in the wiring, not in the URDF. Later, and not blocking: cadgen sidecar mates show read-only pose sliders in the CAD lens.
- **D-004.** A world is `<name>.world.json`, opened with `?world=`: robots (URDF path and pose), environment (ground, primitives, STEP props), boards (chip and firmware path), and wiring. The server builds the MuJoCo model from it, with a validator and a Bench skill. A lone STEP or URDF opens as a world with one static object or one posable robot, so there is one viewer. That opening is later.
- **D-005.** `wires` are pin-to-pin pairs, including power and ground: no breadboard, no net names, no discrete resistors. `parts` name a part model and what it drives or reads in the physics. The validator and runtime check missing ground, a voltage mismatch, and two outputs driving each other. The PWM-capable-pin check applies to `analogWrite` parts, and a Servo may use any digital pin (D-018). The validator warns when an `analogWrite` part sits on D9 or D10 while any Servo is wired. A supply is a nominal voltage, a series resistance, and a hard current limit: `V = V_nom − R_s·I` while the draw is at or under the limit, and above it the rail is the voltage where the draw equals the limit. Servo current follows the motor law in D-017. A board below brownout resets, which the recording shows. Wires, checks, and the power budget are milestone 1. Out: SPICE/analog, heat, wire resistance, a breadboard view, KiCad import. Each can be added later without breaking the format.
- **D-006.** Bench never compiles. A board names its firmware artifact (`.hex` for AVR). The agent or the user builds it with their toolchain (the starter documents `arduino-cli`; that firmware section is a follow-up after milestone 1). Bench watches that artifact and restarts the board when it changes. Source is read-only. There is no in-app code editor.
- **D-007.** `origin/mcu` stays at `49cda2e` and is never merged. The port starts from main and, onto avr8js, takes the one-machine-per-document host (`emu/host.ts`), `SerialConsole`, `SourceView`, the run/read/send serial tools, and the contract types renamed device → board. Not ported: the vendored esp-emu files, the ESP32 fixtures, `.esp32c3.bin` naming, `experience.ts` and the per-screen chat work from #54, and the DevKit board view. D-009 on that branch (the QEMU fork runner) is void. Deleting the nine merged `feat/mcu-*` remote branches needs its own approval.
- **D-008.** In milestone 1, Quest opens a world, sees the same server run live and in sync with the Mac, and has one play/pause control in the existing XR chrome. Chat behaves as today. No timeline, board panel, console, or pin inspection in XR. Browser evidence uses IWER.
- **D-009.** Dead-code cuts first. The store split comes before the world viewer. The one shared chat hook comes before the board tools, which are built on it (D-012). Chat survival across a restart (stop → `resumeFrom`, no leaked process per thread) is already done and is outside milestone 1. Left as notes: pairing scopes, OCCT test-only modules, the recents poll, the chat error path, trust-model docs. The old probe scratch directories and the nine merged `feat/mcu-*` branches are not approved for deletion.
- **D-010.** Amends D-003 for milestone 1: URDF link meshes are `.stl` or `.obj` at paths relative to the URDF. The validator rejects anything else and hints to export STL with `$cad` (`cadgen stl build`). MuJoCo's URDF compiler runs with `fusestatic` false so every link keeps a body, and the validator warns on duplicate mesh basenames. 3MF/GLB conversion and `package://` resolution are later.
- **D-011.** Fixture `.hex` files ship with their `.ino` sources, the arduino-cli version, the `arduino:avr` core and Servo library versions, and a NOTICE naming LGPL-2.1. Fixture geometry is authored with `$cad`. No step.parts or other vendor geometry in the repo.
- **D-012.** Amends D-009: the one shared chat hook runs before the board tools, and those tools are built on it. Chat survival across a restart is already done and leaves milestone 1. The leftover (unfinished-turn handles never leave the sessions map, `chat.ts:327`) stays a note.
- **D-013.** workspace/process decision, not product.
- **D-014.** Milestone 1 is judged on the pipe in D-001. The vision shows at demo 2, which is later: a sensor, ground contact, a wheeled robot.
- **D-015.** For worlds only, the run (play state, sim time, poses, signals) is shared per document. Camera, selection, lens, and timeline scrub stay per client. Any client or the agent may play or pause. The last command wins. The event names who sent it, and every client shows it. This ADR records that. ADR 0008 is void.
- **D-016.** workspace/process decision, not product.
- **D-017.** Revised 2026-09-25 (fidelity). Refines D-005. The SG90 is a voltage-mode DC motor on the output side, gearbox included: `I_motor = (V_drive − K·ω) / R`, `τ = η·K·I_motor`, with `K = 0.458 V·s/rad`, `R = 7.1 Ω`, `η = 0.57`. `|V_drive| ≤ V_rail` and `V_drive = V_rail · clamp(error / E_sat, −1, 1)`. No pulse for 60 ms is no drive. `E_sat`, joint `frictionloss`, viscous `damping`, and `armature` are fitted catalog values and replace the URDF damping, friction, and armature on the driven joint. `torqueNm` stays the clamp. Idle, moving, and stall are display states only; stall shows after the saturated slow condition has held for 20 ms. A supply is `V = V_nom − R_s·I` while `I ≤ I_limit`; above the limit the rail is where the draw equals `I_limit`. USB ("500 mA" port) is 5 V, `R_s = 0.5 Ω`, `I_limit = 0.9 A`. A bench supply takes the user's voltage and current limit with `R_s = 0.05 Ω`. The Uno draws 50 mA, including in reset. Servo supply current is 10 mA plus `max(0, s·I_motor)`, `s = V_drive / V_rail`; braking current does not come from the supply. The ATmega328P (extended fuse `0xFD`, BODLEVEL 2.7 V) resets below 2.675 V and releases above 2.725 V, then holds reset 66 ms before the first instruction. Pins are Hi-Z from the assert, and the torque of that step matches the current charged to the rail. No bootloader on brownout. The recording stamps `reset` at assert and `reboot` at the first instruction. On a 5 V / 0.3 A bench supply the starting current at rest pulls the rail to about 1.70 V and the board resets on the first pulse. The assert-step torque coasts while the winding is open, so the arm walks a few degrees and does not reach the stop. The same stall on USB sits near 4.6 V and does not reset.
- **D-018.** Amends D-005: a Servo part may use any digital pin. The PWM-capable-pin check applies to parts driven by `analogWrite`. The validator warns when an `analogWrite` part sits on D9 or D10 while any Servo is wired.

## Contradictions resolved

1. The 2026-09-21 direction note (Bench is the browser) says Bench does
   not build a peripheral simulator. Part models are that simulator:
   behaviour between a pin and the physics. This ADR supersedes the note
   on that point. Bench still does not write a chip emulator, and it still
   does not learn which tool wrote the CAD or the firmware. It borrows
   MuJoCo and avr8js (rp2040js later, `micro-emulator` later) and owns the
   runtime, the wiring format, the part models, the viewer, and the agent
   tools.
2. The product plan and the repo entry point called Bench a CAD workbench
   and said the app does not author. The robot is still authored outside
   Bench. Bench does not author CAD and does not compile firmware. It runs
   the world. Those two docs are rewritten with this ADR.
3. On the `mcu` branch, D-005 put CAD and Device on two screens. ADR 0008
   records that split. The world is one view plus chat. The panel follows
   the selection. There is one timeline. The runtime is headless, and the
   page is a client of it.
4. On the `mcu` branch, D-009 named a QEMU fork as the runner. That choice
   is void. The board runs on avr8js.
5. Code on the `mcu` branch calls the microcontroller a device. The word
   is board: a microcontroller running firmware in the world, with a pose
   and simple geometry.
6. ADR 0003 keeps the live stream on the client that started it. For a
   world, one document has one live run, shared by every client and the
   agent (D-015). ADR 0003 is amended for worlds only. A STEP or GLB
   viewport stays as ADR 0003 left it.

## Amends / voids

Amends [ADR 0003](0003-library-not-viewport.md) for worlds only. The run
(play state, sim time, poses, signals) is shared per document. Camera,
selection, lens, and timeline scrub stay per client. The last play or
pause wins, and every client shows who sent it. File, selection, camera,
and live chat for a STEP or GLB stay per client.

Voids ADR 0008 (a firmware image as a second domain, two screens, an
`esp-emulator` loader). That ADR exists only on the `mcu` branch, which
stays unmerged. Voids D-009 on that branch, the QEMU fork runner. avr8js
is the board.

## Consequences

### Positive

- One file to open. The URDF is the robot, and the server builds one
  MuJoCo model from the world file.
- Pin-to-pin wires catch a missing ground, a voltage clash, and two
  outputs driving each other. The power budget reproduces the bench
  5 V / 0.3 A starting current resetting the board, and a USB port that
  does not, and the numbers are fixed so that check can fail a test.
- CAD and firmware stay outside Bench. Bench still does not learn which
  tool wrote them.
- The Mac, Quest, and the agent watch one run. Demo 1 is a visible pipe:
  unmodified `Servo.h` moves a joint. The probes already load the arm, hit
  the pulse window, and run ahead of real time.

### Negative

- Bench owns a runtime, a wiring format, and part models. That is more
  than a viewer.
- Milestone 1 accepts STL and OBJ at a relative path, and rejects other
  meshes.
- One shared run means one client's play, pause, or serial write is
  everyone's.
- In milestone 1 Quest can watch and play or pause. It cannot scrub, open
  the console, or inspect pins.
- The chip in milestone 1 is avr8js. rp2040js and `micro-emulator` wait.
  The port leaves the ESP32 image and the DevKit screen behind.
- The electrical model is a current budget (D-005's out list: SPICE, heat,
  wire resistance, a breadboard, KiCad import).

### Mitigations

- The validator rejects a bad mesh and a bad wire, warns on duplicate mesh
  basenames, and warns when `analogWrite` shares D9 or D10 with a Servo.
- Brownout uses the ATmega328P BODLEVEL 2.7 V thresholds, so the
  comparator is not tuned until a test passes.
- Play and pause name who sent the command. Camera, selection, lens, and
  scrub stay on the client, so two people can look at different parts of
  one run.
- `origin/mcu` stays where it is, as the reference for the host, the
  console, and the serial tools the world ports. It is not merged.

## Alternatives considered

- Demo 2 as the first milestone, or a foundation with nothing a person can
  see (D-001).
- The cadgen kinematics sidecar as the robot, or an MJCF the agent writes
  by hand (D-003).
- An MJCF scene plus a separate wiring file, or an SDF world plus a wiring
  file (D-004).
- Signal connections only, or a full netlist in the style of Wokwi's
  `diagram.json` or KiCad (D-005).
- Play runs a build command named in the world file, or Bench bundles the
  toolchain (D-006).
- Change the runner on `mcu` and merge that branch, or drop the branch and
  rewrite the host, console, and serial tools (D-007).
- Mac only for milestone 1, or XR parity with the desktop panels (D-008).
- A wider cleanup that also touches pairing and the OCCT loader, or only
  the chat-restart fix (D-009).
- Keeping D-003's "Bench converts" inside milestone 1 (D-010). That
  conversion cannot be built yet: `$urdf` writes 3MF, MuJoCo reads
  STL/OBJ/MSH, and opencascade.js has no 3MF reader.
- Compiling the fixture in CI, or register-level firmware with no Arduino
  core (D-011).
- Moving the serial tools later so the shared chat hook can stay late
  (D-012).
- Leaving the currents, the sag, and the stall rule to whoever implements
  the part model (D-017).
- Keeping D-005's rule that a servo must sit on a PWM-capable pin (D-018).
  That rejects wiring `Servo.h` accepts.

D-014 and D-015 record no alternative.

## Related

- [0003](0003-library-not-viewport.md) — amended for worlds only
- [0002](0002-step-loader-occt.md), [0004](0004-occt-via-opencascade-js.md)
  — STEP is still a loader, and still the only tessellator
- [0006](0006-folder-is-a-tab.md) — the folder stays the tab's
- [0001](0001-new-private-repo.md) — do not merge `sfab-cad`; this ADR
  does not reopen that
- [`product.md`](../product.md) — the plan that follows this decision
- The 2026-09-21 direction note (Bench is the browser) — superseded where
  it forbids a peripheral simulator
