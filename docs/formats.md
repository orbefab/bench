# Layered simulation: types and formats v1

**Status:** v1, adopted by [ADR 0010](decisions/0010-layered-simulation.md). `D-nnn` references are the settled decisions listed in that ADR. The nearest open standards (ADR 0010, D-011) are in §9. §10 lists the changes the circuit experiments proposed; they land in v1.1 with the code that needs them.

## 1. Quantities and units

- Files store **SI coherent numbers only**: V, A, Ω, H, N·m, rad, rad/s, kg, m, s, K, W. Degrees, mA and kgf·cm are display units.
- Each quantity has a name and a dimension vector over `kg m s A K mol cd rad`. Ports connect when the **names** match, not only the dimensions: torque and energy share a vector but not a name.
- A value may be **tagged** `{ v, q, d, unit? }`. The checker verifies the tag against the field, and a `unit` that is not the SI unit is an error.
- Dimension vectors cannot see prefixes, so mA and A look alike. The linter therefore checks **plausible ranges per quantity per part type** (D-023.7).

```ts
type Quantity =
  | "Voltage" | "Current" | "Resistance" | "Inductance"
  | "Angle" | "AngularVelocity" | "Torque"
  | "Position" | "Velocity" | "Force"
  | "Temperature" | "HeatFlow"
  | "Mass" | "Inertia" | "Time" | "Frequency"
  | "Pose" | "Wrench"                         // composite: match by name only
  | "Dimensionless" | "TorquePerCurrent" | "TorquePerAngularVelocity";

type SiNumber = number | { v: number; q: Quantity; d: Dim; unit?: string };
type Range = [SiNumber, SiNumber];
```

## 2. Ports

| Domain | Across | Through |
| --- | --- | --- |
| `electrical` | Voltage | Current |
| `rotational` | Angle (+ AngularVelocity) | Torque |
| `translational` | Position (+ Velocity) | Force |
| `thermal` | Temperature | HeatFlow |
| `mount` | Pose | Wrench |

Digital is **not** a domain (D-006):
- electrical ports carry a `role`: `power`, `ground`, `logic` or `analog`;
- a net is `digital` only when every port on it is `logic`; any `power`, `ground` or `analog` port makes it `analog`;
- unconnected pins are not nets;
- a world may force a net with `run.levels.nets`.

```ts
type PortDecl = {
  domain: Domain;
  role?: "power" | "ground" | "logic" | "analog";
  direction?: "in" | "out" | "inout" | "passive";
  pwm?: boolean; adc?: boolean;
  frame?: string;                         // mount / rotational: where on the body
  ratings?: Ratings;
};

type Ratings = {
  voltage?: Range; absMaxVoltage?: Range;
  current?: Range; absMaxCurrent?: Range;
  logic?: { vil?: SiNumber; vih?: SiNumber; vol?: SiNumber; voh?: SiNumber };
  frequency?: Range; torque?: Range; speed?: Range;
  temperature?: Range; resistance?: Range;
};

type BusDecl = { ports: string[]; protocol: string };   // "uart", "i2c", "spi"; transaction level later
```

**Port templates** (D-023.6): a type may declare repeated pins as a template, e.g. `{ "id": "D{n}", "n": [0, 13], "pwm": [3, 5, 6, 9, 10, 11], "role": "logic" }`. The loader expands the template, and the checker, lockfile and reports see only expanded ports.

### Checks at load

1. **Structural:** the port exists; domains and quantity names match.
2. **Ratings:**
   - A supply voltage outside a power input's operating range is a **warning**. Outside abs-max, it is an **error**.
   - A logic high above the receiver's abs-max is an **error**.
   - A current limit below a stall current is **not** a wiring error. It is a runtime envelope.
3. **Plausibility:** each quantity falls in the part type's plausible range.
4. **Runtime:** envelopes and SOA, warned once.

Every message names the instance path, the port, the quantity and both values.

## 3. Part types and parts

A part type is the connector contract. A part is a real product implementing it, versioned `publisher/name@x.y.z` (D-007).

```ts
type PartTypeFile = {
  format: "sfab.part-type@1";
  id: string;                                   // "hobby-servo-3wire"
  ports: Record<string, PortDecl>;              // after template expansion
  templates?: PortTemplate[];
  buses?: Record<string, BusDecl>;
  plausible?: Partial<Record<Quantity, Range>>; // D-023.7
};

type PartFile = {
  format: "sfab.part@1";
  id: string;                                   // "sfab/sg90@1.0.0"
  type: string | PartTypeFile;                  // inline type = one-file shorthand
  foreign?: boolean;                            // D-009: black box, capped quality
  declaredOnly?: boolean;                       // exists in a netlist, no working behaviour
  sources?: Citation[];
  ratings?: Record<string, Ratings>;            // per port, overrides the type
  axes: {
    behaviour?: AxisMap<BehaviourImpl>;
    body?: AxisMap<BodyImpl>;
    visual?: AxisMap<VisualImpl>;
  };
};

// D-004: classes 0..3, named variants inside each class, one default per class.
type AxisMap<T> = Partial<Record<"0" | "1" | "2" | "3", { default: string; variants: Record<string, T> }>>;
```

Every implementation carries `omits: string[]`: the effects this level leaves out. It feeds the report's "not simulated" list. For example, SG90 behaviour class 1 omits gear backlash, motor inductance and winding heat.

```ts
type BehaviourImpl = { omits: string[] } & (
  | { kind: "form"; form: FormId; params: Record<string, SiNumber> }
  | { kind: "snapshot"; ref: string }
  | { kind: "composite"; netlist: Netlist }
  | { kind: "firmware"; chip: string; imageParam?: string; params?: Record<string, number>; fuses?: Record<string, string>; boardCircuit?: string }
  | { kind: "script"; script: string });

// D-023.1: the body owns joint friction, damping and armature.
type BodyImpl = { omits: string[] } & (
  | { kind: "lumped"; mass: number; com: Vec3; inertia: Sym6;
      joint?: { armature?: number; frictionloss?: number; damping?: number } }
  | { kind: "urdf"; file: string } | { kind: "mjcf"; file: string }
  | { kind: "children" } | { kind: "none" });

type VisualImpl = { omits: string[] } & (
  | { kind: "mesh"; files: string[]; placeholder?: boolean }
  | { kind: "box"; size: Vec3 } | { kind: "children" } | { kind: "none" });

type Netlist = {
  instances: Record<string, { part: string; pose?: Pose; params?: Params }>;
  wires: [PortRef, PortRef][];
  expose: Record<string, PortRef>;             // the composite's ports → inner ports
};
```

- Instance numeric `params` override form params of the same name. For example, a bench supply takes the world's voltage and current limit.
- A firmware variant may set `boardCircuit`. It names the onboard circuit for that board's `5V`. Absent, the 5V pin is the supply terminal: no capacitors, D13 LED, or reset network, including at class 2. `nano-usb` is the clone Nano at class 2 (`arduino-nano`, part `sfab/nano-ch340@1.0.0`). A `usb-a-port` on its `5V` inserts the Schottky from VBUS plus the +5V capacitors, the D13 LED, and the reset network. Any other supply on that pin, such as a bench supply, inserts the same network without the Schottky. `snapshot:<publisher/name@version>` is the class-1 default (`snapshot:sfab/nano-usb-5v@1.0.0`). A `usb-a-port` on `5V` evaluates that snapshot as a Thevenin segment in the same rail solve when the port's series resistance and current limit sit inside the snapshot's source bounds. Any other feed, including a `usb-a-port` outside those bounds, leaves the 5V pin as the ideal terminal and the run records one warning. The non-default variant `ideal-terminal` is that ideal terminal with no snapshot. The Uno path stays on the type `arduino-uno-r3` and does not use this field.
- An instance string param `urdf` replaces the body file of a part whose body is `urdf`. The path is relative to the project folder.
- Children are instantiated only when the chosen behaviour is a composite. The lockfile still lists them.

### `avr-pin@1` and the ADC

A firmware board carries `avr-pin@1` as numbers on the variant's `params`, not as a `form`. The names are `roh`, `rol`, `rpu` and `rLeak`, in ohms. High is the board's 5V node. Low is 0 V. The Nano D13 stamp and the ADC both use these numbers.

DDR and PORT choose the mode, read when the rail solves and when a conversion starts:

| DDR | PORT | Mode |
| --- | --- | --- |
| 1 | 1 | `high` |
| 1 | 0 | `low` |
| 0 | 1 | `pullup` |
| 0 | 0 | `input` |

An input with nothing else on the net is 0 V through `rLeak`. A pull-up with nothing else on it is the board node through `rpu`. A pin that is its own output reads that level unloaded: `high` through `roh`, `low` through `rol`.

The ADC keeps avr8js's conversion time. The count is `floor(V / Vref · 1024)`, clamped to 0..1023, after the sample-and-hold. The hold is exact at 0 Ω.

AVCC (REFS = 01) is the board node at the end of the previous 1 ms step, latched before the CPU runs, so the conversion lags the rail by at most one master step. A board that starts in the same quantum, after the solve, sees that solve. The internal 1.1 V reference (REFS = 11) is the bandgap. AREF (REFS = 00) is 0 V: these boards have no AREF port, and a conversion against it reads 0. A reserved reference (REFS = 10) also reads 0. The AREF pin circuit is omitted.

| MUX | Input |
| --- | --- |
| 0–7 | A0–A7, single-ended, from the net |
| 8 | Temperature, 0.314 V. DS40002061 Table 24-2, typical at 25 °C. A constant. |
| 14 | Bandgap, 1.1 V. DS40002061 ADC Characteristics, internal reference 1.0 V min, 1.1 V typical, 1.2 V max. |
| 15 | 0 V |

A0–A5 follow the table above. A6 and A7 are analog only. A net with this board's `5V` reads the board node. `GND` reads 0 V. A power or ground port wins over the pin's own mode. Anything else on the net, including another pin or a part, reads 0 V through `rLeak`.

Omitted: ADC INL and DNL, ADC noise, the noise canceller, temperature drift, and the AREF pin circuit.

**Model forms** are versioned equations that parts and snapshots fill in:
- `slew@1`
- `dc-motor@1` (K, R, L?, efficiency, eSat, quiescent)
- `thevenin-limit@1`
- `ideal-voltage@1`
- `resistor@1`, `capacitor@1`, `diode@1`
- `logic-in@1`
- `table@1`
- `transfer-fn@1`
- `multibody@1` (a URDF/MJCF body run by MuJoCo; the arm's class-1 behaviour)
- `mlp@1` (later)
- `ranger@1` (c, rangeMin, rangeMax, beamHalf, trigMin, echoDelay, echoTimeout, working, quiescent, vMin, face)

Each form declares its params with quantities, its ports, its engine contributions (D-014) and, where one exists, its energy function.

`ranger@1` is the HC-SR04. The part `sfab/hc-sr04@1.0.0` fills the same form twice. Class 0 (`ideal`) casts one ray on the sensor axis. Echo rises 200 µs after Trig falls, the same protocol delay as class 1, so firmware that calls `pulseIn` after the trigger still sees the pin low. The width is exactly `2d/c`. No hit means no pulse. It draws nothing. That delay is part of the module's protocol, not an imperfection, and it is assumed until M3. Class 1 (`datasheet`) casts 41 rays: the axis, then five radial steps out to the 7.5° half-angle and eight azimuths, so the outer ring sits on the cone and two azimuths are horizontal. The nearest hit wins. A hit closer than 2 cm or past 4 m is no echo. Trig must be high for at least 10 µs, and a trigger during a measurement is ignored. Echo rises 200 µs after the falling edge (one 8-cycle 40 kHz burst; assumed until M3) and stays high for `2d/c`, or for 38 ms when nothing returns (assumed until M4). The working current is on the node that feeds `VCC` while a measurement is in progress, and the idle current while powered. Below `vMin`, or with `VCC` unwired, there is no echo and no draw. `c` is 343 m/s. The sheet uses 340 m/s, and the 58 µs/cm rule is 344.8 m/s.

The ray is cast once per accepted trigger, on the physics of the previous master step. The CPU runs before `mj_step`, the same lag as the AVCC latch above. It starts at the transducer plane (`face` metres along the part's local +Y) and goes along +Y, from the part's pose in the scene. That pose is fixed for the run. A sensor on a moving link is not supported yet. When a ranger is in the run, rays see targets and static primitives only. Every other geom, including robots and the ground, is geom group 1, and the ray includes group 0 only, with `flg_static` set and `bodyexclude` −1. A world with no ranger does not change geom groups.

## 4. World

A world is **one root part** plus environment plus run settings (D-002).

```ts
type WorldFile = {
  version: 2;
  environment: {
    ground: { plane: boolean };
    gravity: Vec3;
    air?: { density: number };
    targets?: WorldTarget[];
  };
  run: {
    seed: number;                                       // D-008: all randomness from here
    levels: {
      default: LevelSpec;                               // bare number = all three axes (D-023.4)
      types?: Record<string, LevelSpec>;                // part-type rules
      paths?: Record<string, LevelSpec>;                // "fleet.rig2.servo"
      nets?: Record<string, "digital" | "analog">;
    };
  };
  root: { id: string; part: string | PartFile; pose?: Pose; params?: Params };
};
type LevelSpec = 0 | 1 | 2 | 3 | Partial<Record<"behaviour" | "body" | "visual", 0 | 1 | 2 | 3>>;
```

**Targets.** A target is a box, sphere or cylinder that moves, and that a ray can hit. It is a MuJoCo mocap body with `contype` and `conaffinity` 0, so it does not push a robot; a mocap body would not move from contact anyway. `path` is `{ t, position }[]`, times in seconds, strictly increasing. The position is linear between keyframes, the first keyframe before its time, and held after the last. With no path the target stays at `pose`. The viewer draws it where it is, and the recording keeps that pose on the robot id `target` (`target/<id>`), the same way a link pose is kept, so scrubbing shows it move. `world_move_target` sets the position from the next master step and records a `move-target` event. A world whose targets only follow `path` stays byte-identical across runs. Dragging a target in the view is later.

**Paths:** the root is `$root` and does not prefix children (`fleet.rig2.servo`).

**Level resolution** (D-005, amended by D-023.3):
1. Per axis, a path rule beats a type rule, which beats the default.
2. A missing class falls back to the nearest **cheaper** class.
3. If there is none, it uses the nearest **deeper** class and reports "capture suggested".
4. The class's default variant runs.
5. Levels are fixed for a run (D-017).

## 5. Library and lockfile (D-007, D-023.5)

Lookup order:
1. `worlds/<w>/parts/`
2. the personal library
3. the catalog
4. the registry

A world part that shadows a catalog part is a warning.

```ts
type LockFile = {
  format: "sfab.lock@1";
  world: string;
  parts: { id: string; version: string; sha256: string; source: "world" | "library" | "catalog" | "inline"; path: string }[];
  types: { id: string; sha256: string; source: "world" | "library" | "catalog" | "inline"; path: string }[];
  snapshots?: { id: string; sha256: string; source: "world" | "library" | "catalog" | "inline"; path: string }[];
};
```

The lock sits beside its world as `<stem>.lock.json` (`arm.world.json` → `arm.world.lock.json`), and `world` is that stem (`arm.world`).

A part file whose hash no longer matches the lock is an error that names the part. A snapshot file is pinned the same way, and only when the resolved variant actually runs it. The key is omitted when the run uses none.

Snapshot files are looked up like parts, in `snapshots/<publisher>/<name>@<version>.json` under the world, the personal library, then the catalog (`apps/server/catalog/snapshots/`).

## 6. Snapshot

```ts
type Snapshot = {
  format: "sfab.snapshot@1";
  partType: string;
  part: string;                                          // exact version, D-007
  axis: "behaviour" | "body";
  form: FormId;
  ports: { inputs: string[]; outputs: string[] };        // actuators must output V+.current
  params: Record<string, number | number[]>;             // behaviour only: no joint terms (D-023.1)
  envelope: {
    bounds: Record<string, Range>;                       // "supply.voltage": [4.5, 6] (D-023.2)
    data?: { kind: "mahalanobis"; mean: number[]; cov: number[][]; limit: number };
  };
  error: "none-available" | { metric: "free-run-max-abs" | "free-run-rms"; quantity: string; value: number;
                              corner?: "typ" | "min" | "max"; heldOut: "fixture" | "use-like" | "both";
                              baseline?: { level: string; value: number } }[];
  quality: "Q0" | "Q1" | "Q2a" | "Q2b" | "Q3";           // set by the linter, never by hand
  provenance: {
    source: "captured" | "authored" | "measured" | "imported";
    from?: { part: string; level: string; hash: string };   // level = class string, "1"
    fixture?: { ref: string; hash: string; seed: number };
    data?: { file: string; sha256: string; rig?: string };
    tool?: { name: string; version: string; file?: string };
    citations?: Citation[];
    bench: { version: string; mujoco?: string; avr8js?: string };
    created: string;                                     // from config, never the wall clock
  };
};
```

`supply.voltage` is the supply setpoint. `V+.voltage` is the terminal voltage at the port, which sags under load.

### Quality and the linter

| Quality | Meaning |
| --- | --- |
| Q0 | parses and lints |
| Q1 | plausibility checks pass |
| Q2a | captured, with a measured free-run error against the source |
| Q2b | measured against a real rig |
| Q3 | both Q2a and Q2b |

Foreign parts are capped (D-009).

The linter rejects, and a snapshot that fails cannot run:
- missing provenance (a captured snapshot also needs `from`, `fixture`, and `tool`);
- a table that doesn't cover its envelope (the current axis must span `5V.current`, and `supplyAffine: 1` counts as covering `supply.voltage` when `supplyRef` sits inside that range);
- an actuator with no `V+.current` output;
- values outside the part type's plausible ranges (a current of 10 A or more is also shown in mA);
- non-physical output: voltage at a **0 V setpoint**, checked only inside the envelope, and only when that envelope includes 0 V.

Quality in the file is a claim. The linter grants Q0, Q1, Q2a, Q2b, or Q3 from the provenance and the error rows, and a claim above that grant is an error. The loader uses the grant only when the file is clean.

The Nano USB snapshot `sfab/nano-usb-5v@1.0.0` is `table@1`. Its ports are `5V.current` and `supply.voltage` in, and `5V.voltage` out (the board port is `5V`). `vAxis` is the node voltage at `supplyRef` (5 V). `supplyAffine` is 1, so `V(supply, I) = interp(vAxis, I) + (supply − supplyRef)`. The envelope is `supply.voltage` in [4.75, 5.25] V and `5V.current` from 0 up to 0.01 A below the `sfab/usb-port-500ma@1.0.0` thevenin `Ilimit` (0.9 A), so the current bound is 0.89 A. It also records that port: `supply.resistance` is [0.5, 0.5] Ω and `supply.currentLimit` is [0.9, 0.9] A, the `Rs` and `Ilimit` the capture used. A class-1 Nano whose `usb-a-port` is outside those two bounds does not run the snapshot. It runs the ideal terminal, the report says why, and the lock does not pin the snapshot. Outside the voltage or current envelope during a run, the run continues, raises one warning per instance, and lists it on the snapshot row. It does not fall back mid-run. `baseline.level` is the level the error was measured against, and `value` is that level's own error on the same metric, which is 0 for the capture source.

Rebuild the file with `pnpm --filter @sfab-bench/server capture`. That command captures the Nano USB input; other parts need their own case. The timestamp comes from `apps/server/catalog/fixtures/capture.config.json`, not the wall clock.

## 7. Fixture

```ts
type Fixture = {
  format: "sfab.fixture@1";
  partType: string;
  mount: "clamped" | { load: { inertia: number; torque?: number } };
  sweeps: { port: string; quantity: Quantity; values: number[] }[];   // includes load Inertia / Torque
  inputs: { port: string; signal: "step" | "chirp" | "prbs"; params: Record<string, number> }[];
  record: string[];
  duration: number; seed: number;
};
```

Sweeps over `Inertia` or `Torque` replace `mount.load` per run, and sweeps are crossed. Captured and measured snapshots use the same fixture. A real rig runs the same script by hand (E10).

## 8. Run report (D-008)

Each run's report contains:
- a lock summary;
- the level per instance per axis, with the reason (default / type / path / fallback from X / capture suggested);
- the nets with their level and the reason;
- the errors and warnings;
- the quality of each snapshot used, and when one ran, its ref, free-run error, envelope warnings (an empty list when the run stayed inside), and provenance for the card: `source`, `from` (`part` and `level` only), `fixture` (the ref), and `tool` (`name` and `version`). Hashes stay in the snapshot file.
- **not simulated**: the `omits` of each chosen level, one row per instance per axis so each keeps its path;
- the seed and the number of random draws;
- the cost per engine.

Its `format` is `sfab.run-report@1`. It is byte-identical across runs with the same inputs. The run keeps it and sends it on the state message: the first snapshot after load, and again when an envelope warning is added. A world that ran no snapshot still has `snapshots: []` and `snapshotQuality` of `no snapshot used; selected levels are authored forms, firmware, or composites`, and its lock summary omits `snapshots`.

## 9. Nearest standards (D-011)

| Bench format | Nearest standard | Lost there |
| --- | --- | --- |
| Part type | FMI `modelDescription` variables with units; Modelica connectors; KiCad symbol pins | roles, ratings tiers, buses, plausible ranges |
| Part | one FMU per behaviour level; Modelica `replaceable`; URDF/MJCF body; glTF visual | level ladder, `omits`, `foreign` |
| World v2 | SSP `SystemStructure.ssd` | level rules, non-signal domains |
| Snapshot | IBIS-style tables; FMU; Modelica record | envelope, error, quality, provenance |
| Fixture | SSP + a co-simulation master script | sweep and seed semantics |
| Lockfile, run report | none | — |

Export rule (D-011): every part exports as an FMU, and every world as an SSP composition, even when these extras are lost.

## 10. Proposed for v1.1 (from the circuit experiments)

These came out of the motor/rail and pin experiments. They are proposals, not yet part of v1.

- **`thevenin-limit@1`** (supply): `V` (open-circuit setpoint, V), `Rs` (Ω), `Ilim` (A, one-sided). While the load current is under `Ilim`, `v = V − Rs·I`; above it the branch holds `I = Ilim` and the terminal voltage follows the load. `supply.voltage` is `V`, never the terminal voltage.
- **`dc-motor@1`** on the circuit is `R`, `L` (optional, 0 is legal) and `K`, with ω an input held for the master step. `efficiency`, `eSat`, `quiescent` and the torque limit stay in the behaviour law and do not enter the circuit.
- **`averaged-hbridge@1`**: ports are the rail and the motor's electrical port. `V_motor = s·V_rail`, `I_rail = s·I_motor`, plus `quiescent` as a current source on the rail. `s` is the behaviour law's output, not a stored parameter. The engine may fuse the bridge and the winding into one branch.
- **`run.coupling`** on the world, not the part: `scheme` ∈ `explicit | substep | implicit-damping`, `substeps` (default 10), `bemfDamping` ∈ `body | circuit`. Default for a hobby servo is `substep`. A joint with `dt·B/J > 2` selects `implicit-damping`, which puts the derived `B(s) = η·K²/(R + Rs·s²)` on the joint's damping. `B(s)` is derived, never a parameter.
- **Braking current** returns to the rail (`I_rail = s·I` may be negative). The rail clips it at 0; the measured bench (E10) decides which the SG90 part keeps.
- **Pin element `avr-pin@1`** (landed, §3): `roh`, `rol`, `rpu` and `rLeak` on the firmware variant. High is the board node. DDR and PORT select the mode at the master step.
- **ADC** (landed, §3): AVCC is the board node from the end of the previous 1 ms step. The count is `floor(V/Vref·1024)`, clamped to 1023. The sample-and-hold is a closed form, not a live 14 pF node. INL, DNL, noise, the noise canceller and temperature drift are omitted.
- **`gear-train` body kind** beside `mjcf`: shafts `{ name, inertia, damping, friction }` and meshes `{ driver, driven, teethDriver, teethDriven }`, so the body-axis snapshot `collapse()` (armature `N²·J` plus reflected idlers, friction scaled by the speed ratio) is data. A catalog armature that was fitted, not reflected, says so.
- **Current-limit floor**: a `thevenin-limit@1` rail feeding regenerating motors needs a clamp (the bridge's body diodes) so the terminal voltage cannot go negative.
- **Run report** adds the **passivity sum** at each circuit/body cut (joules injected by the coupling) and flags it when it grows.
- **`ptc-fuse@1`** (Uno F1, Bourns MF-MSMF050-2): cold resistance is Rmin 0.15 Ω. R1max 1.00 Ω is the post-trip ceiling, not the cold value. `Ihold` 0.50 A, `Itrip` 1.00 A. Thermal state `u` integrates `I²R` once per 1 ms master step, outside the circuit solve. At `u = 1` the branch goes to a high resistance and returns to the cold value once `u` falls.
- **`pmos-switch@1`** (Uno T1, FDN340P): `Rds` in parallel with the body diode. On the USB path the gate stays on, so `Rds` is the −4.5 V figure, 60 mΩ typical. VIN and the barrel jack are not in this step.
- **Board power path:** a `usb-a-port` wired to an Uno `5V` is the USB cable: fuse, switch, the +5V capacitors, the board load (full current down to 1 V, then linear to 0 A at 0 V), and every servo on that node. A `usb-a-port` wired to a Nano `5V` is the cable into the Nano's USB connector. At class 2 (`boardCircuit` `nano-usb`) that inserts the Schottky from VBUS to +5V, the +5V capacitors, the board load, the D13 LED and the reset network, and servos on `nano.5V` load that node. A bench supply on that `5V` at class 2 inserts the same network without the Schottky, so the header is the board node and the LED, capacitors, and reset network stay. At class 1 a `usb-a-port` feed uses the captured snapshot (`boardCircuit` `snapshot:sfab/nano-usb-5v@1.0.0`) as the source into the same rail when that port's series resistance and current limit match the snapshot; the table has no capacitance, and the D13 LED and reset network are omitted. Any other class-1 feed, including a different `usb-a-port`, keeps the ideal terminal. A bench supply on an Uno `5V` is the header, and there is no path. The supply record's `current` is the terminal current and its `voltage` is the terminal voltage. The board record's `voltage` is the 5V node, and `minVoltage` is that node's minimum over the frame. A Nano whose class-2 circuit stamps the D13 LED also records `ledCurrent` (amperes). A part with a power port reports `voltage` as V+ relative to GND. With no cable the board node equals the supply terminal, and both are reported.
- **Brownout** reads the board node: the lowest board-node voltage over that millisecond's sub-steps. With no cable the board node is the supply terminal.

## Open for v2

- The transaction level for buses.
- The checkpoint format (D-003, D-019).
- Registry governance: who publishes parts, and whether they are signed.
- Visual levels beyond box, mesh and cutaway.
- `transfer-fn@1` once a deep level has state (E4).
