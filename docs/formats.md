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

Every implementation carries `omits: string[]`: the effects this level leaves out. It feeds the report's "not simulated" list. For example, SG90 behaviour class 1 omits gear backlash, motor inductance and winding heat. The catalog's other hobby servo is `sfab/mg90s@1.0.0`; it stops at class 1, and its control-IC composite is later.

```ts
type BehaviourImpl = { omits: string[] } & (
  | { kind: "form"; form: FormId; params: Record<string, SiNumber> }
  | { kind: "snapshot"; ref: string }
  | { kind: "composite"; netlist: Netlist }
  | { kind: "firmware"; chip: string; imageParam?: string; fuses?: Record<string, string> }
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
- An instance string param `urdf` replaces the body file of a part whose body is `urdf`. The path is relative to the project folder.
- Children are instantiated only when the chosen behaviour is a composite. The lockfile still lists them.

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

Each form declares its params with quantities, its ports, its engine contributions (D-014) and, where one exists, its energy function.

## 4. World

A world is **one root part** plus environment plus run settings (D-002).

```ts
type WorldFile = {
  version: 2;
  environment: { ground: { plane: boolean }; gravity: Vec3; air?: { density: number } };
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
};
```

The lock sits beside its world as `<stem>.lock.json` (`arm.world.json` → `arm.world.lock.json`), and `world` is that stem (`arm.world`).

A part file whose hash no longer matches the lock is an error that names the part.

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

The linter rejects:
- missing provenance;
- a table that doesn't cover its envelope;
- an actuator with no `V+.current` output;
- values outside plausible ranges;
- non-physical output: current or torque at a **0 V setpoint**, checked only inside the envelope.

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
- the quality of each snapshot used;
- **not simulated**: the `omits` of each chosen level, one row per instance per axis so each keeps its path;
- the seed and the number of random draws;
- the cost per engine.

Its `format` is `sfab.run-report@1`. It is byte-identical across runs with the same inputs.

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
- **Pin element `avr-pin@1`**: Thevenin source to the rail node (`Roh`, `Rol`), Hi-Z as an input, and the pull-up stored as its datasheet **range** (20–50 kΩ, default the midpoint) until a measured snapshot replaces it. Pin changes land at their cycle timestamp.
- **ADC**: the reference is the **AVCC node**, never a constant 5 V, and the conversion is the datasheet's `floor(V/Vref·1024)`, clamped to 1023. The sample-and-hold is a closed form, not a live 14 pF node.
- **`gear-train` body kind** beside `mjcf`: shafts `{ name, inertia, damping, friction }` and meshes `{ driver, driven, teethDriver, teethDriven }`, so the body-axis snapshot `collapse()` (armature `N²·J` plus reflected idlers, friction scaled by the speed ratio) is data. A catalog armature that was fitted, not reflected, says so.
- **Current-limit floor**: a `thevenin-limit@1` rail feeding regenerating motors needs a clamp (the bridge's body diodes) so the terminal voltage cannot go negative.
- **Run report** adds the **passivity sum** at each circuit/body cut (joules injected by the coupling) and flags it when it grows.
- **`ptc-fuse@1`** (Uno F1, Bourns MF-MSMF050-2): cold resistance is Rmin 0.15 Ω. R1max 1.00 Ω is the post-trip ceiling, not the cold value. `Ihold` 0.50 A, `Itrip` 1.00 A. Thermal state `u` integrates `I²R` once per 1 ms master step, outside the circuit solve. At `u = 1` the branch goes to a high resistance and returns to the cold value once `u` falls.
- **`pmos-switch@1`** (Uno T1, FDN340P): `Rds` in parallel with the body diode. On the USB path the gate stays on, so `Rds` is the −4.5 V figure, 60 mΩ typical. VIN and the barrel jack are not in this step.
- **Board power path:** a `usb` preset wired to an Uno `5V` is the USB cable: fuse, switch, the +5V capacitors, the board load (full current down to 1 V, then linear to 0 A at 0 V), and every servo on that node. A `bench` preset on `5V` is the header, and there is no path. The supply record's `current` is the terminal current and its `voltage` is the terminal voltage. The board record's `voltage` is the 5V node, and `minVoltage` is that node's minimum over the frame. A part with a power port reports `voltage` as V+ relative to GND. With no cable the board node equals the supply terminal, and both are reported.
- **Brownout** reads the board node: the lowest board-node voltage over that millisecond's sub-steps. With no cable the board node is the supply terminal.

## Open for v2

- The transaction level for buses.
- The checkpoint format (D-003, D-019).
- Registry governance: who publishes parts, and whether they are signed.
- Visual levels beyond box, mesh and cutaway.
- `transfer-fn@1` once a deep level has state (E4).
