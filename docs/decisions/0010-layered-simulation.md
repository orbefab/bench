# ADR-0010: Layered simulation

**Status:** Accepted
**Date:** 2026-09-26
**Deciders:** Alwurts

## Context

ADR 0009 made the world the document: MuJoCo for the body, avr8js for the
board, and closed-form part models in between. Each part has one fixed
fidelity. The electrical side is a current budget, and SPICE-style analog
simulation was left out of the format.

Bench is heading for more than that: parts that can run at several depths,
a cheap model of any part captured from a deeper one (a snapshot), real
units at every port, and worlds that serve reinforcement learning. The
research behind this found no ready runtime that covers it. Its central
finding is that tight loops, such as servo current against rail voltage,
go wrong when black boxes pass values across a step. They must be solved
together.

Eight experiments ran standalone, outside this repo, against the SG90,
the Uno and the arm example at `b5ce591`:

| # | Question | Result |
| --- | --- | --- |
| E7 | Do the types fit today's parts? | Pass. The SG90, Uno, USB and bench supplies, the arm and a two-arm fleet as part files; the resolver, net-level picker, rating checker and lockfile catch all five broken worlds |
| E4 | Does the snapshot loop work? | Pass. Capture, lint and replay of `table@1` and `dc-motor@1` from the SG90 law; ≤ 1° free-run error; same file hash on recapture |
| E1 | Is our own circuit engine fast and right? | Pass. MNA in TypeScript, backward Euler: 9.8 µs per step at 50 linear nodes; ≤ 0.24% from ngspice 45.2 on every circuit, including the pin, PWM, ADC and Nano power path |
| E2 | Can motor and rail solve together and drive MuJoCo? | Pass. Stall matches the closed form exactly (USB rail 4.643 V); no-load 517 °/s; a stiff motor is stable with implicit damping or MuJoCo sub-steps; 12 servos on one rail cost about 14 µs per 1 ms |
| E3 | Can avr8js pins drive circuits edge by edge? | Pass. PWM into RC within 0.05% of ngspice; the ADC exact against a sagging AVCC; 9× real time with every edge; digital nets skip the circuit |
| E8 | Is compiled Modelica (OpenModelica → WASM) practical? | Runs and matches, but a causal FMU owns its inertia, which fights one MuJoCo body per joint. Offline only |
| E5 | Can MuJoCo run a deep servo body? | Pass for one gear constraint (rotor + output at 260.8:1): stable at 1 ms, collapses exactly to the lumped hinge, 1.3× its cost. Four live meshes match but cost 2.1–2.3×, so they are a capture source. Backlash drifts; offline |
| E6 | What does scale cost? | Pass. One scheduler: 12 servos + 1 Uno at 4.8× real time on avr8js, 46× with scripted firmware; 4 Unos 1.3×, 10 Unos 0.5×. The emulated chip is ~90% of the cost. 260 simulated seconds per second on 8 workers |

E9 (foreign FMUs) and E10 (a measured SG90 on a real Nano) are still
open. They can amend this record; they do not block it.

## Decision

**A part can run at several levels, on three axes, and parts contribute
equations to a few shared engines that Bench owns or borrows.**

### Parts, levels and snapshots

- Everything placed is a part, and parts nest. A world is one root part,
  an environment, and run settings (D-002).
- Each part has three axes: behaviour, body and visual. Each axis runs at
  one class of a shared ladder: 0 ideal, 1 behavioural, 2 structural (its
  children), 3 physical (offline only). Named variants live inside a class
  (D-004).
- A snapshot is a cheap model of a part at its ports, with an envelope, an
  error and provenance. It is captured from a deeper level or entered from
  a datasheet or a measurement. It is never saved state; that is a
  checkpoint (D-003).
- The world chooses levels with rules: path beats part type beats default.
  A missing class falls back to the nearest cheaper one, or else deeper
  with "capture suggested" in the report (D-005). Levels change only at
  reset (D-017).
- Parts are versioned files, `publisher/name@version`, found in project,
  personal and catalog libraries. A lockfile pins parts and part types by
  hash (D-007).

### Engines

- **Bodies:** MuJoCo, reached only through the body axis (D-012).
- **Circuits:** our own MNA engine in TypeScript, backward Euler, with
  sub-steps inside the 1 ms master step. ngspice is the offline reference,
  never linked (D-013, D-018).
- **Chips:** avr8js, with pin edges stamped in cycles. A net is digital
  when every port on it is a logic port, and analog otherwise (D-006).
  When the firmware is not under test, a chip runs a cheaper behaviour
  level: scripted pins, or the sketch compiled natively against a host
  HAL (E6).
- **Snapshots:** evaluated by form (`table@1`, `dc-motor@1`, …) and
  contributing like any part.
- **Compiled Modelica** stays offline, as a reference and a snapshot
  source. **Black-box FMUs** are for foreign parts only, coupled at event
  boundaries with an energy check (D-009).

Parts do not own engines. They contribute stamps to the circuit, bodies
and forces to MuJoCo, and handlers to the scheduler. Tight loops are
solved in one engine (D-014).

### Time

One clock: the MuJoCo step is the 1 ms master quantum. The circuit
sub-steps inside it (10 backward-Euler steps for a hobby servo). Pin edges
land at their cycle. Same-instant events use a fixed order, so a run is
bit-reproducible from the world, the pinned parts, the seed and the build
(D-008, D-015). Magnetics, FEM, gear-tooth contact and transistor-level
SPICE are offline only (D-016).

### Formats

Open, royalty-free standards first: SI units, URDF/MJCF, glTF/STL, STEP,
Intel HEX, SPICE netlists, FMI and SSP. Bench's own formats exist only
where none fits, name their nearest standard, and publish a permissive
spec. Every part exports as an FMU and every world as an SSP composition,
even when levels and envelopes are lost (D-011). The v1 formats (part
types, parts, World v2, snapshots, fixtures, lockfile, run report) are in
[`docs/formats.md`](../formats.md).

### Reinforcement learning

Bench is to be a Gymnasium-style environment: seeded `reset`, `step`, fast
checkpoint and restore, headless faster than real time, many worlds in
parallel. Training runs outside Bench (D-019). Not built yet: today
`bench run` runs one world headless for a fixed span, with no reset,
observe or act.

### First deep part

The order of deep parts is pin circuits (an LED, an RC filter on PWM, a
pot on the ADC), then the Uno power path: USB, polyfuse, the 5 V rail,
its capacitors and brownout, from the open schematic, checked against
ngspice. Then a DC gear motor with an H-bridge, then the servo at level 2
(D-020).

## Settled decisions

One line each. The layered-sim packet has the full text and alternatives.

- **D-001.** Real units at ports; any level is a valid place to author; three separate axes; snapshots from capture or entry; the first deep part is picked by testability; each direction has a kill line.
- **D-002.** Everything placed is a part, recursively; a world is one root part plus environment and run settings.
- **D-003.** Vocabulary: snapshot, capture, checkpoint, part, part type, port, axis, level, form, fixture, envelope, world.
- **D-004.** Classes 0 ideal, 1 behavioural, 2 structural, 3 physical on every axis; named variants inside a class; one class is enough.
- **D-005.** Level rules in the world: path > type > default; a structural composite exposes its children to the rules.
- **D-006.** Every pin is electrical; a net is solved digital or analog, picked from its port roles, forceable by rule.
- **D-007.** `publisher/name@version`; project → personal → catalog → registry; a lockfile pins versions and hashes; snapshots name their part version.
- **D-008.** Bit-reproducible runs; randomness only from the seed; the report lists levels, snapshot quality, warnings and what is not simulated.
- **D-009.** Parts are open; foreign parts are black boxes with capped quality, coupled at events with an energy check.
- **D-010.** workspace/process decision, not product.
- **D-011.** Standard, free formats first; every part exports as an FMU, every world as SSP.
- **D-012.** MuJoCo stays for bodies, behind the body axis.
- **D-013.** Direction A (own light engines) is the default; compiled Modelica and black-box orchestration stay open by experiment.
- **D-014.** Parts contribute equations; tight loops are solved together.
- **D-015.** A 1 ms master step, sub-steps inside, cycle-stamped edges, superdense time for same-instant events.
- **D-016.** The live floor is lumped circuits, instruction-level chips and rigid bodies; deeper physics is offline.
- **D-017.** Levels change only at reset.
- **D-018.** The runtime links only MIT, Apache-2.0, BSD or ISC code; ngspice is a separate process.
- **D-019.** Bench is to be a Gymnasium-style RL environment (not built yet); training runs elsewhere.
- **D-020.** The order of deep parts is pin circuits, then the Uno power path.
- **D-021, D-022, D-024.** workspace/process decisions (the E10 bench rig), not product.
- **D-023.** Types v1: the body owns joint friction, damping and armature; `supply.voltage` is the setpoint; a bare level rule sets all three axes; the lockfile pins types; port templates; plausible ranges per quantity.

## Amends / voids

Amends [ADR 0009](0009-world-simulation.md):

- **D-005 (0009)'s out list.** Analog simulation is in: the MNA engine
  solves lumped circuits. Heat, wire resistance and KiCad import stay out
  until a part needs them. World v1 was dropped on 2026-09-26 (green field; no v1 data kept).
- **D-017 (0009)'s closed-form rail** stays the SG90's class-1 law and the
  reference the circuit is checked against. Since 2026-09-26 the circuit, with
  the Uno USB path, is the run's rail; the closed form is the reference only.
  Braking current stays clipped until the measured bench decides.
- **Part models** become parts with levels. Today's SG90 and supplies are
  class-1 behaviour parts.

Everything else in ADR 0009 stands: the world is the document, one shared
run, Bench never compiles firmware, and avr8js is the board.

## Consequences

### Positive

- One idea covers a resistor, a servo, a robot and a fleet: a part with
  levels, and a snapshot that makes it cheap.
- The rail, the motor and the pins solve together, so sag and stall come
  from the circuit: the motor is a lumped law in it (winding resistance
  and back-EMF), and brownout is a threshold on the solved board node.
  The lowest level is lumped devices (R, C, L, a Shockley diode, and
  behavioural regulator, fuse, switch and comparator), not transistors.
  The experiments match ngspice on the same netlists, and the closed
  forms, to well under 1%. Nothing is checked against hardware yet (E10).
- Runs are reproducible and say what they leave out, so a snapshot can be
  scored against its deeper level.
- Formats map to open standards, and the runtime stays permissive.

### Negative

- Bench owns a circuit engine, a scheduler, model forms and a snapshot
  toolchain, and must validate each part itself.
- Nonlinear circuits cost more: 50 nodes with diodes were 82–126 µs per
  step before the frozen-Jacobian bypass (about 12 µs after it).
- avr8js is the main cost: 100–190 µs per simulated millisecond per chip,
  so about four emulated chips fit in real time on one core.
- World v2 is a new format, and today's worlds need conversion.

### Mitigations

- ngspice, MuJoCo's closed forms and a real bench are the references.
  Every deep part is checked against something outside Bench (D-001).
- Digital nets skip the circuit; averaged PWM is a cheaper level; a chip
  whose firmware is not under test runs scripted pins at ~46× real time
  (E6).
- A stiff motor on a light joint is to use implicit damping in MuJoCo
  (proposed, `formats.md` §10). The run report carries a seam ledger at
  each circuit/body cut: energy in joules, flagged when its residual grows
  (`formats.md` §8).

## Implementation notes

- The engine, the pin harness and the coupling began as experiment code
  (E1, E2, E3). They now live in `packages/engine-circuit` (the MNA engine,
  `avr-pin@1` and the other elements), `packages/parts` (the loader and
  levels) and `packages/sim` (`circuit-stamp.ts`, `rail-circuit.ts`,
  `power-path.ts` and the step loop). `apps/server/src/world/worker.ts` is
  a thin Node host ([ADR 0012](0012-layers-and-plugin-seams.md)).
- Order of what was built: the Uno power path came before pin circuits,
  the reverse of D-020's plan. Both are in the run now: the loader, the
  circuit engine, the motor and rail stamps, and stamped pins, with the
  ADC reading the solved node. Digital inputs do not yet read a voltage
  threshold.
- Tests: each circuit against a stored ngspice trace; the SG90 against
  today's closed form; bit-identical recordings from the same seed.

## Alternatives considered

- One fixed fidelity per part, as in ADR 0009 (D-001).
- Our own physics engine, or Drake as the live body engine (D-012).
- Compiled Modelica as the default (D-013; E8 kept it offline).
- Every part as an FMU-style `step()` box (D-014).
- Bench-only formats, or FMI/SSP as the native format (D-011).
- Hot-swapping levels mid-run (D-017).
- RL training built into Bench, or no RL for now (D-019).
- A DC gear motor, or the servo at level 2, as the first deep part (D-020).

## Related

- [0009](0009-world-simulation.md) — amended as above
- [Types v1](../formats.md)
- [`product.md`](../product.md) — the plan this feeds
