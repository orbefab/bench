# Layered simulation: types and formats v1

**Status:** v1, adopted by [ADR 0010](decisions/0010-layered-simulation.md). `D-nnn` references are the settled decisions listed in that ADR. The nearest open standards (ADR 0010, D-011) are in §9. §10 lists the changes the circuit experiments proposed; they land in v1.1 with the code that needs them.

## 1. Quantities and units

- Files store **SI coherent numbers only**: V, A, C, Ω, F, H, N·m, rad, rad/s, kg, m, s, K, W. Degrees, mA and kgf·cm are display units.
- Each quantity has a name and a dimension vector over `kg m s A K mol cd rad`. Ports connect when the **names** match, not only the dimensions: torque and energy share a vector but not a name.
- A value may be **tagged** `{ v, q, d, unit? }`. The checker verifies the tag against the field, and a `unit` that is not the SI unit is an error.
- Dimension vectors cannot see prefixes, so mA and A look alike. The linter therefore checks **plausible ranges per quantity per part type** (D-023.7).

```ts
type Quantity =
  | "Voltage" | "Current" | "Charge" | "Resistance" | "Capacitance" | "Inductance"
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
  internal?: boolean;                     // not a wiring target; the cable reaches it
  connector?: string;                     // cable family; "usb" matches a supply to a board port
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
  | { kind: "firmware"; chip: string; imageParam?: string; params?: Record<string, number>; fuses?: Record<string, string>; boardCircuit?: string; resetPort?: string; board?: Netlist }
  | { kind: "script"; script: string });

// D-023.1: the body owns joint friction, damping and armature.
type BodyImpl = { omits: string[] } & (
  | { kind: "lumped"; mass: number; com: Vec3; inertia: Sym6;
      joint?: { armature?: number; frictionloss?: number; damping?: number } }
  | { kind: "gear-train"; input: string; output: string;
      shafts: { name: string; inertia: number; damping: number; frictionloss: number; mass?: number }[];
      meshes: { driver: string; driven: string; teethDriver: number; teethDriven: number }[] }
  | { kind: "snapshot"; ref: string }
  | { kind: "urdf"; file: string } | { kind: "mjcf"; file: string }
  | { kind: "children" } | { kind: "none" });

type VisualImpl = { omits: string[] } & (
  | { kind: "mesh"; files: string[]; placeholder?: boolean }
  | { kind: "box"; size: Vec3 } | { kind: "children" } | { kind: "none" });

A mesh with `placeholder: true` is drawn as the nearest lower class whose visual is a `box`. The visual level row says which class, for example "placeholder mesh; drawn as the class-0 box". A mesh file is not drawn. A URDF body is not also drawn as a box.

type Netlist = {
  instances: Record<string, { part: string; pose?: Pose; params?: Params; level?: LevelSpec }>;
  wires: [PortRef, PortRef][];
  expose: Record<string, PortRef>;             // the composite's ports → inner ports
};
```

- Instance numeric `params` override form params of the same name. For example, a bench supply takes the world's voltage and current limit.
- A netlist instance may set `level` (`LevelSpec`, defined with the world). A bare number sets behaviour, body and visual. An object sets the named axes. A path rule beats that level, and that level beats a type rule. A parent class replaces a request only while it is still the default. The report reason is `instance level`.
- A firmware variant may set `boardCircuit` to `path:uno-usb`. The non-default variant `ideal-terminal` is an ideal terminal with no board. `path:uno-usb` on a variant names that part's own class-2 board netlist. The plan expands it under the instance path and sets `board.stamp` the same way a class-2 netlist does. A usb feed attaches the cable's Thevenin to the internal `VBUS`. Any other feed attaches at `5V` and leaves `VBUS` unfed, so the fuse and the switch drop and the capacitors on `5V` stay. Every board on a supply is stamped into that supply's one circuit, each under its instance path, with its own board node, brownout, reset and pins. A part that declares `path:uno-usb` and has no class-2 board netlist is a load error naming the part. `fuseStart: "tripped"` trips every `ptc-fuse@1` stamped on the rail. A header feed has none after the prune. Any other `boardCircuit` string is an error.
- A firmware variant may set `resetPort` to the logic port the chip uses as reset (`RESET` on the Nano and the Uno). The rail's reset threshold is that chip's fraction of the rail. `atmega328p` is 0.9. An unknown `chip` is a plan error.
- The board's supply input is the non-internal port with `role: "power"`, `direction: "in"`, and a voltage rating that contains the chip rail. The run prefers the candidate a supply is wired to. `VIN` on these boards is rated above the 5 V rail, so it is not the chip's voltage pin, and a supply on `5V` still wins when both are wired. A supply wired only to `VIN` attaches at `VIN`. The onboard regulator then feeds the 5 V node. If that power-input group was asked for class 1, it runs class 2: a branch table cannot regulate. The card's reason is `nearest runnable level`, source `fallback`. Ground is the non-internal port with `role: "ground"`. A port's `connector` names the cable family. The catalog `usb-a-port` pin `5V` says `usb`, and so does the internal `VBUS` on the Nano and the Uno, so a usb supply on `5V` lands on `VBUS` when the variant has a board netlist or when `boardCircuit` is `path:uno-usb`, and on `5V` otherwise. A bench supply has no connector, so it attaches to `5V`. On that header feed, `VBUS` is unfed: the fuse and the switch drop, and the capacitors the netlist puts on `5V` stay.
- A firmware variant may set `board`, a netlist of circuit parts and composites. The world still addresses the board as one instance. The chosen variant's children are resolved. A composite child is a shell: its circuit leaves are stamped with the board. The clone Nano class 2 (`sfab/nano-ch340@1.0.0`, variant `circuits`) is that netlist: SS14 from `VBUS` to `5V`, the +5V capacitors, the reset network, and the D13 LED. Class 1 (`avr8js`) is its own board netlist: the power group held at behaviour class 1, with no +5V capacitors, so it stays algebraic. The rail still stamps the board load, the pins, and parts on those pins. The D13 LED, the reset network and the rail capacitance stay in that variant's omits. `VBUS` is an `internal` power port on `arduino-nano`. It is not a wiring target. A part whose only other node is then unconnected, such as the Schottky with an open anode, is pruned. No extra conductance is added.
- The run flattens composites before dispatch, at any depth, including a group inside a board netlist. An instance whose selected behaviour is `composite` is a shell and is not itself a runtime. Leaves are dispatched by behaviour kind and form: `firmware`, a form id, or a `urdf` body with `multibody@1`. A leaf with no runtime is an error that names the path and the form or kind. A wire endpoint is the instance path, then the port, split at the last `.`, so a world wire can land on a nested exposed port.
- A circuit part (`resistor@1`, `capacitor@1`, `diode@1`, `ptc-fuse@1`, `pmos-switch@1`, `ldo-regulator@1`, `comparator@1`) belongs to the rail of the supply its nets reach. There is one rail per supply. A firmware board on that supply adds its board stamp and pins. A part that reaches that supply and shares no net with the board is still stamped on the board. A supply with those parts and no board stamps them against the supply's positive and ground ports. A circuit part that reaches no supply and no board is a plan error naming the path. After the stamps are built, every such part is in exactly one stamp. A part `realize` later prunes still counts as placed. A part nested under one board stays in that board's stamp even when the shared net also touches another board. A part that reaches two boards on the same supply is stamped once. A part on two supplies is a plan error. Several firmware boards share one supply: each board netlist is stamped into that one rail. A branch snapshot is stamped like any other circuit part and shares that supply. The supply is always a part. A v1 draft has neither a stamp nor a snapshot, and those pairs still share.
- An instance string param `urdf` replaces the body file of a part whose body is `urdf`. The path is relative to the project folder.
- Children are instantiated when the chosen behaviour is a composite, when it is firmware with a `board` netlist, or when `boardCircuit` is `path:uno-usb` (that part's class-2 board, resolved as class 2). The lockfile still lists children of every class.
- A `gear-train` stores shaft-side inertia, damping and friction in SI. Teeth are positive integers. `collapse()` reflects them onto the output: armature is Σ n²J, damping is Σ n²B, frictionloss is Σ |n|τ, and n is |ω_shaft / ω_output|, the product of `teethDriven / teethDriver` walking from the output. The run uses that hinge. It does not instance the gear bodies. On the SG90 the train sits on the servo, not on the `gears` child. Those children are instanced only when the behaviour is the class-2 composite, and that composite still has no runtime. When the children run, the `gears` child takes this body over.

### `avr-pin@1` and the ADC

A firmware board carries `avr-pin@1` as numbers on the variant's `params`, not as a `form`. The names are `roh`, `rol`, `rpu` and `rLeak`, in ohms. High is the board's 5V node. Low is 0 V. `rLeak` belongs to the pin element. The rail stamps one pin for every chip pin that has an Arduino bit and whose net contains a circuit part. Each of those pins follows `driveMode` at the master step. The ADC uses the same numbers.

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

A0–A5 follow the table above. A6 and A7 are analog only. A net with this board's `5V` reads the board node. `GND` reads 0 V. A power or ground port wins over the pin's own mode. Any other net that is a node of a stamped circuit reads that node's solved voltage at the conversion's master step. The source resistance is the node's Thevenin resistance from the same factor: one extra backsolve with a 1 A injection, and only when a conversion happens. A net that is not in a stamp, including another pin or a part the circuit did not take, reads 0 V through `rLeak`.

Omitted: ADC INL and DNL, ADC noise, the noise canceller, temperature drift, and the AREF pin circuit.

**Model forms** are versioned equations that parts and snapshots fill in:
- `slew@1`
- `dc-motor@1` (K, R, L?, efficiency, eSat, quiescent)
- `thevenin-limit@1`
- `battery@1` (supply, ports `+` and `-`). `ocv` is a table of `[soc, volts]` knots, monotonic, with soc running from 0 to 1. `rInternal` is resistance in ohms. `capacity` is charge in coulombs. `soc0` is the initial state of charge. `vCutoff` is volts, and it is optional. Each 1 ms master step the terminal is a Thevenin source inside the rail, `V = ocv(soc)` and `R = rInternal`. After the step, `soc` moves by `−I·dt/capacity`, outside the solve. The state is per instance. At `soc = 0`, or when the terminal voltage is at or below `vCutoff`, the next master step stamps `V = ocv(0)` and `R = rInternal`, and the run warns once. The step that first crosses `vCutoff` still reports that crossing voltage. The latch applies from the next master step. The run does not stop. The supply record's `voltage` is the terminal voltage, its `current` is the terminal current, and the record also has `soc`. A recorded frame stores that `soc` beside voltage and current when the supply has a state of charge. Omitted: temperature, Peukert rate capacity, relaxation, and aging. `sfab/battery-3xaa-alkaline@1.0.0` and `sfab/battery-2s-lipo@1.0.0` fill this form.
- `ideal-voltage@1`
- `resistor@1` (`R`, resistance, ohms)
- `capacitor@1` (`C`, capacitance, farads; `esr`, resistance, ohms, optional). `esr` of 0 is legal and adds no node. `esr` above 0 is a series resistor and an internal node.
- `diode@1` (`Is`, current, amperes; `N`, dimensionless; `Rs`, resistance, ohms, optional). An LED is this form on a part whose type is `led`.
- `ptc-fuse@1` (ports `A`, `B`). `rCold` and `rHot` are resistance in ohms, and `rHot` must be greater than `rCold`. `iHold` and `iTrip` are current in amperes. `tripPower` is heat flow in watts. `tau` is time in seconds. `uReset` is dimensionless. The branch stamps `rCold` until the thermal state `u` reaches 1, then `rHot`, and it returns to `rCold` once `u` falls to `uReset`. One step of `u` runs per 1 ms master step, from the current that step solved, outside the solve. Power in that step is `I²` times the resistance the solve stamped. `u` moves toward `I²R / tripPower` with time constant `tau`. The state is per instance, in any stamped circuit. A resistance change drops the factored matrix. `iHold` and `iTrip` are the part's declared currents; the step uses `tripPower`. A static table cannot hold `u`. `sfab/mf-msmf050@1.0.0` fills this form. On the Uno it is F1, between `VBUS` and the P-channel switch.
- `pmos-switch@1` (ports `S`, `D`, `G`). `rds` is resistance in ohms. `vth` is the gate threshold in volts. The body diode uses `Is`, `N` and `Rs`, the same quantities as `diode@1`, and `Rs` is optional. The diode's anode is `D` and its cathode is `S`. The gate is decided once per master step from the previous solve: the channel is on when `V(G) − V(S) ≤ vth`, and on means `rds` in parallel with the body diode. Off leaves the body diode alone. The channel starts on, because the first solve has no previous gate. A state change drops the factored matrix. A missing gate net is an error. `sfab/fdn340p@1.0.0` fills this form. On the Uno, U5A drives the gate. With VIN open the realization holds that gate at ground, which is U5A low, and the USB path stays on. With VIN driven the gate goes to the comparator's positive rail and the channel turns off.
- `ldo-regulator@1` (ports `IN`, `OUT`, `GND`). `vOut` is the regulated output in volts. `dropout` is a table of `[amps, volts]` knots, current rising, dropout not falling; outside the first and last knots the voltage is flat. `iGround` is the ground-pin current in amperes. `iLimit` is the output current limit in amperes. `rOut` is an optional output resistance in ohms. In regulation `OUT = vOut − rOut·I`. In dropout `OUT = IN − dropout(I)`. The two meet in a softmin. Past `iLimit`, and below 0 A, a smooth wall holds the pass current. `iGround` flows `IN → GND` while `IN` is above the bias knee. The law is the solve; there is no per-step state. Omitted: line and load transients, PSRR, thermal shutdown and temperature, noise. A reverse path is in the part's omits unless that datasheet gives a DC law. `sfab/ams1117-5v0@1.0.0`, `sfab/ncp1117-5v0@1.0.0`, and `sfab/lp2985-3v3@1.0.0` fill this form.
- `comparator@1` (ports `P`, `N`, `OUT`, `VP`, `VN`). `vHyst` is optional hysteresis in volts. The output is an ideal source to `VP` or `VN`, chosen once per master step from the previous solve, so the read is 1 ms late. High when `V(P) − V(N)` is above the hysteresis. It starts low. A change drops the factored matrix. `sfab/lmv358@1.0.0` fills this form. On the Uno it is U5A.
- `logic-in@1`
- `table@1`
- `transfer-fn@1`
- `multibody@1` (a URDF/MJCF body run by MuJoCo; the arm's class-1 behaviour)
- `hinge@1` (body axis only: `armature` Inertia, `damping` TorquePerAngularVelocity, `frictionloss` Torque). On the behaviour axis it is a load error. A behaviour form on the body axis is a load error.
- `mlp@1` (later)
- `ranger@1` (c, rangeMin, rangeMax, beamHalf, trigMin, echoDelay, echoTimeout, working, quiescent, vMin, face)

Catalog supplies on these forms: `sfab/usb2-host-port@1.0.0`, `sfab/usb3-host-port@1.0.0`, `sfab/usb-charger-1a@1.0.0`, and `sfab/bench-supply-2a@1.0.0` (`thevenin-limit@1`); `sfab/battery-3xaa-alkaline@1.0.0` and `sfab/battery-2s-lipo@1.0.0` (`battery@1`). `sfab/usb-port-500ma@1.0.0` and `sfab/bench-supply@1.0.0` are unchanged. Fixed regulators: `sfab/ams1117-5v0@1.0.0`, `sfab/ncp1117-5v0@1.0.0`, and `sfab/lp2985-3v3@1.0.0` (`ldo-regulator@1`). `sfab/lmv358@1.0.0` (`comparator@1`).

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
type AxisLevel = 0 | 1 | 2 | 3 | { class: 0 | 1 | 2 | 3; variant: string };
type LevelSpec = 0 | 1 | 2 | 3 | Partial<Record<"behaviour" | "body" | "visual", AxisLevel>>;
```

**Targets.** A target is a box, sphere or cylinder that moves, and that a ray can hit. It is a MuJoCo mocap body with `contype` and `conaffinity` 0, so it does not push a robot; a mocap body would not move from contact anyway. `path` is `{ t, position }[]`, times in seconds, strictly increasing. The position is linear between keyframes, the first keyframe before its time, and held after the last. With no path the target stays at `pose`. The viewer draws it where it is, and the recording keeps that pose on the robot id `target` (`target/<id>`), the same way a link pose is kept, so scrubbing shows it move. `world_move_target` sets the position from the next master step and records a `move-target` event. A world whose targets only follow `path` stays byte-identical across runs. Dragging a target in the view is later.

**Paths:** the root is `$root` and does not prefix children (`fleet.rig2.servo`).

**Level resolution** (D-005, amended by D-023.3):
1. Per axis, a path rule beats a type rule, which beats the default.
2. Children of the world root use the world default. The scene composite is a container, not a parent. Below that, a nested instance whose request is still the default takes its parent's resolved behaviour class when the parent has that class, whether the parent is a firmware board or a composite. A parent that only reached its class by fallback does not pass it down. The report source is `parent`. A leaf that lacks the parent's class falls back, and the report says so. A part with no behaviour class stays on the world default.
3. A missing class falls back to the nearest **cheaper** class.
4. If there is none, it uses the nearest **deeper** class and reports "capture suggested".
5. A bare class runs that class's default variant. `{ class, variant }` selects that named variant in that class. A variant the part does not have is a plan error naming the path, axis, class and variant. It does not fall back. The level row shows the variant, and the reason says the rule chose it. A named variant does not inherit a parent class.
6. Levels are fixed for a run (D-017).

`world_set_level` writes a class number onto one axis. When that axis held a variant rule, the write replaces the rule with the class alone. The other axes keep their variant objects.

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

A snapshot is one behaviour or body level of a part. `{kind: "snapshot", ref}` on a variant is loaded like a part (world, then library, then catalog), linted, pinned in the lock when that variant runs, reported with its quality, and run. A snapshot that fails to load or lint is a plan error. It does not fall back. Body rows carry `axis: "body"`.

A part may hold several snapshots. A run row is keyed by path, axis, and ref. The report sets `axis` explicitly.

```ts
type Snapshot = {
  format: "sfab.snapshot@1";
  partType: string;
  part: string;                                          // exact version, D-007
  axis: "behaviour" | "body";
  form: FormId;
  ports: { inputs: string[]; outputs: string[] };        // port.quantity, from the type
  params: Record<string, number | string | (number | string)[]>; // behaviour: no joint terms (D-023.1). hinge@1: the joint terms.
  envelope: {
    bounds: Record<string, Range>;                       // "port.quantity": [lo, hi] (D-023.2)
    data?: { kind: "mahalanobis"; mean: number[]; cov: number[][]; limit: number };
  };
  error: "none-available" | { metric: "static-max-abs" | "free-run-max-abs" | "free-run-rms" | "step-rise"; quantity: string; value: number;
                              corner?: "typ" | "min" | "max"; heldOut: "fixture" | "use-like" | "both";
                              baseline?: { level: string; value: number } }[];
  quality: "Q0" | "Q1" | "Q2a" | "Q2b" | "Q3";           // set by the linter, never by hand
  provenance: {
    source: "captured" | "authored" | "measured" | "imported";
    from?: { part: string; level: string; hash: string };   // level = class string
    fixture?: { ref: string; hash: string; seed: number };
    data?: { file: string; sha256: string; rig?: string };
    tool?: { name: string; version: string; file?: string };
    citations?: Citation[];
    bench: { version: string; mujoco?: string; avr8js?: string };
    created: string;                                     // from config, never the wall clock
  };
};
```

`table@1` is DC only, one port pair. There is no `transfer-fn@1` yet, and no servo actuator table yet: that table needs `map@1` and the E10 data. A world run does not instance live gear bodies, and it does not add backlash.

### `table@1`

A `table@1` snapshot is one port pair and the current through the first port.

- `across` is `[p, m]`, the port names.
- `iAxis` is amperes. `iSense` is `1` when that axis is current into `p` from outside, and `-1` when it is current out of `p`. A source's output current is negative (section 2). `iSense` is required. There is no default.
- `vAxis` is volts: `V(p) − V(m)` at each knot. The current axis is monotone.
- `ports.inputs` and `ports.outputs` name the same quantities by port (`p.current` in, `p.voltage` out). The linter takes the quantity from the part type's port declarations.

One use. The table is a branch between two of the part's own ports. The supply is always a part in the scene. A snapshot must not carry its fixture's supply: the linter rejects an envelope bound on `supply.*`, a port that is not one of the snapshot's own ports, or a `supplyPort`, `supplyRef`, or `supplyAffine` param.

- **Branch.** The table is a two-terminal branch between the two live nodes, with no current limit and no floor. Outside the knots it extrapolates the end segments, and the envelope warns once. A behaviour variant `{kind: "snapshot", ref}` whose law is `table@1` is this use. It is stamped on its `across` ports, on the rail of the supply those nets reach, the same way as any circuit part.

During a run, every key in `envelope.bounds` whose quantity is observed on the rail is checked. There is at most one warning per path and ref. The warning names the port and the bound. The run continues. It does not fall back mid-run.

### `hinge@1`

A body-axis form. The axis must be `body`, and a body snapshot must be this form. `armature` (Inertia) is finite and greater than 0. `damping` (TorquePerAngularVelocity) and `frictionloss` (Torque) are finite and non-negative. Port quantities come from the type's declarations and are a rotational port's angle, speed or torque. Envelope keys are on that same port. The type's plausible ranges apply. `hobby-servo-3wire` allows Inertia from 1e-9 to 0.01 kg·m² and TorquePerAngularVelocity from 0 to 1 N·m·s/rad, wide enough for a fitted armature and a reflected one, and tight enough to catch a missing prefix.

`step-rise` is |t₁₀₋₉₀(snapshot) − t₁₀₋₉₀(baseline)| in seconds, on the named quantity. Each side's rise is 10% to 90% of that trace's own start-to-end span. A captured free-run row with a baseline earns Q2a, the same rule as `table@1`. `step-rise` does not grant Q2a by itself.

Each master step compares the driven joint's speed and the applied actuator torque with the snapshot's speed and torque bounds. At most one warning per path and ref. The warning names the port and the bound. The run continues.

The servo adapter takes its joint from the selected body: a lumped joint, a `hinge@1` snapshot, or `collapse()` of a gear train. Anything else is a plan error.

### Quality and the linter

| Quality | Meaning |
| --- | --- |
| Q0 | parses and lints |
| Q1 | plausibility checks pass |
| Q2a | captured, with a measured free-run error against the source |
| Q2b | measured against a real rig |
| Q3 | both Q2a and Q2b |

Foreign parts are capped (D-009).

The linter is per form. It rejects, and a snapshot that fails cannot run:
- missing provenance (a captured snapshot also needs `from`, `fixture`, and `tool`);
- for `table@1`: an axis that is not monotone; an `across` port that is not on the type; a table that does not cover its envelope (the current knots span the current bound); an envelope that bounds a supply quantity or a port the part does not declare, or a `supplyPort`, `supplyRef`, or `supplyAffine` param (a snapshot must not carry its fixture's supply); a listed port quantity the declarations do not match;
- for `hinge@1`: an axis other than body; a body snapshot that is not `hinge@1`; a param that is missing, non-finite or negative; `armature` that is not greater than 0; a port quantity that is not angle, speed or torque on a declared rotational port; an envelope key that is not on that port;
- a missing output that the part type lists in `requiredOutputs` (no such list means no extra output is required);
- values outside the part type's plausible ranges (a current of 10 A or more is also shown in mA);
- non-physical output: voltage at a **0 V setpoint**, checked only inside the envelope, and only when that envelope includes 0 V.

Quality in the file is a claim. The linter grants Q0, Q1, Q2a, Q2b, or Q3 from the provenance and the error rows, and a claim above that grant is an error. The loader uses the grant only when the file is clean. A captured free-run row with a baseline earns Q2a. A `static-max-abs` row alone stays Q1.

### Capture

`apps/server/catalog/fixtures/capture.config.json` is a list of entries. Capture dispatches on `form`. A `table@1` entry names the part, the variant, the instance, the `across` pair, the port the current goes through, the sweep, the envelope, the baseline level, and an optional free-run case list. A `hinge@1` entry names the part, the fixture, the baseline and the source class. The runner reads those fields from the entry. It has no part-specific numbers.

A plain-branch capture drives an ideal current source through `p` into `m` on the assembly's stamp and reads `V(p) − V(m)`, with `m` pinned at 0. `provenance.from` holds the part id and the stamp hash. An entry that asks records `static-max-abs` against its baseline level, the max-abs error between knots. Free-run rows are written when the entry has cases.

Rebuild with `pnpm --filter @sfab-bench/server capture`. The timestamp comes from the config, not the wall clock.

### Worked examples

**Branch, Nano power input.** `sfab/nano-power-input@1.0.0` is the SS14 from `VBUS` to `5V` and the 10 µF capacitor, as one group. Class 2 is that composite. Class 1 is the snapshot, a branch between two of the part's own ports: `across` `["VBUS", "5V"]`, current into `VBUS`, swept 0 to 0.9 A. The envelope bounds `VBUS.current`. The supply is not in the table. The Nano class-2 netlist instances the group as `power` and wires through `power.5V` and `power.GND`. A path rule can run that child at the snapshot while the rest of the board stays the circuit. The class-1 Nano board netlist instances the same group with `level: { behaviour: 1 }`, so the branch runs even when a type rule would pick class 2. `baseline.level` is the level the error was measured against, and `value` is that level's own error on the same metric, which is 0 for the capture source. The static-max-abs row is the table's interpolation error against that class-2 group.

**Plain branch, Uno power input.** `sfab/uno-power-input@1.0.0` is the USB front end: a `ptc-fuse@1`, a `pmos-switch@1`, the +5V capacitors, and, in the class-2 netlist, the VIN regulator. The class-1 snapshot is that USB path with VIN open: the gate is held at ground and the regulator is not in the stamp. Class 2 is that composite. Class 1 is the snapshot: `across` `["VBUS", "5V"]`, current into `VBUS`, swept from 0 to the fuse's `iHold` (0.5 A). The table cannot hold the fuse's thermal state, so the variant omits fuse trip, thermal state, rail capacitance and temperature, and the envelope stops at that current. Above it the run warns once and continues. `sfab/uno-r3@1.0.0` class 2 instances the group as `power`. Class 1 `boardCircuit: "path:uno-usb"` is that same netlist, stamped in the plan at the instance path.

**Plain branch, any assembly.** `sfab/led-module-red@1.0.0` is 220 Ω and a red LED. Class 1 is the snapshot, `across` `["IN", "GND"]`, swept 0 to 20 mA. `examples/nano/nano-led-module.world.json` holds D9 high into that module. At class 1 the record has no inner LED channel.

**Body.** `sfab/sg90@1.0.0` body class 1 default `lumped` is the fitted joint: armature 5e-5 kg·m², damping 0.0025 N·m·s/rad, frictionloss 0.002 N·m. Variant `collapsed` is the snapshot `sfab/sg90-hinge@1.0.0`, the class-2 collapse, so the armature is reflected rather than fitted. Class 2 is the gear train: a 9-tooth pinion, compounds 47:10, 38:8 and 32:7, and a 23-tooth output. Tooth counts are the published brochure figures. Shaft inertias are estimates (a copper rotor cup, POM gear disks). Damping is 70% on the rotor and 30% on the output. Friction is split evenly. The snapshot's ports are `shaft.torque` in and `shaft.angle` out. Its envelope is the speed and torque the fixture reached, clipped to the shaft ratings, so the box covers normal use. `examples/nano/nano-servo-collapsed.world.json` selects `{ class: 1, variant: "collapsed" }` on `servo`.

A `hinge@1` capture runs the gear train and the collapsed hinge on the same fixture. The deep side is one MuJoCo hinge per shaft and one joint equality per mesh, with the load inertia on the output, at the 1 ms master step. The snapshot side is one hinge from `collapse()`, with the same load. The error rows compare `shaft.angle`: worst-case free-run max-abs and rms, and the worst `step-rise` across the step cases.

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

Sweeps over `Inertia` or `Torque` replace `mount.load` per run, and sweeps are crossed. Captured and measured snapshots use the same fixture. A real rig runs the same script by hand (E10). The Nano power-input fixture is the current sweep of that group. The supply is a part in the scene, not a bound in the snapshot.

`sfab/sg90-body` is a body fixture. `mount.load.inertia` is 2.15e-5 kg·m², the flag vane about its hinge in `examples/nano`. The inertia sweep is that flag and 1.4384e-4 kg·m², the arm's upper link about the shoulder in `examples/arm`. Inputs are torque steps at several amplitudes up to the shaft's rated torque, in both directions, and a chirp at that amplitude. The pulse widths reach the rated speed without running far past it. The snapshot bounds are that observed range clipped to `ratings.shaft`. It records `shaft.angle`.

## 8. Run report (D-008)

Each run's report contains:
- a lock summary;
- the level per instance per axis, with the reason (default / type / instance level / path / parent class / fallback from X / capture suggested);
- the nets with their level and the reason;
- the errors and warnings;
- the quality of each snapshot used, and when one ran, its path, axis, and ref, its free-run or static error, envelope warnings (an empty list when the run stayed inside), and provenance for the card: `source`, `from` (`part` and `level` only), `fixture` (the ref), and `tool` (`name` and `version`). Hashes stay in the snapshot file.
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
- **`battery@1`** (supply, ports `+` and `-`): `ocv` is `[soc, volts]`, monotonic, soc from 0 to 1. `rInternal` is ohms. `capacity` is coulombs. `soc0` is the initial state of charge. `vCutoff` is volts, optional. Each 1 ms master step the terminal is `V = ocv(soc)`, `R = rInternal`. After the step, `soc` moves by `−I·dt/capacity`, outside the solve. At `soc = 0`, or when the terminal is at or below `vCutoff`, the next master step stamps `V = ocv(0)` and `R = rInternal`, and the run warns once. The step that first crosses `vCutoff` still reports that crossing voltage. The latch applies from the next master step. The run does not stop. The supply record's `voltage` is the terminal voltage, `current` is the terminal current, and `soc` is on the record. A recorded frame stores that `soc` beside voltage and current when the supply has a state of charge. Omitted: temperature, Peukert, relaxation, and aging.
- **`dc-motor@1`** on the circuit is `R`, `L` (optional, 0 is legal) and `K`, with ω an input held for the master step. `efficiency`, `eSat`, `quiescent` and the torque limit stay in the behaviour law and do not enter the circuit.
- **`averaged-hbridge@1`**: ports are the rail and the motor's electrical port. `V_motor = s·V_rail`, `I_rail = s·I_motor`, plus `quiescent` as a current source on the rail. `s` is the behaviour law's output, not a stored parameter. The engine may fuse the bridge and the winding into one branch.
- **`run.coupling`** on the world, not the part: `scheme` ∈ `explicit | substep | implicit-damping`, `substeps` (default 10), `bemfDamping` ∈ `body | circuit`. Default for a hobby servo is `substep`. A joint with `dt·B/J > 2` selects `implicit-damping`, which puts the derived `B(s) = η·K²/(R + Rs·s²)` on the joint's damping. `B(s)` is derived, never a parameter.
- **Braking current** returns to the rail (`I_rail = s·I` may be negative). The rail clips it at 0; the measured bench (E10) decides which the SG90 part keeps.
- **Pin element `avr-pin@1`** (landed, §3): `roh`, `rol`, `rpu` and `rLeak` on the firmware variant. High is the board node. DDR and PORT select the mode at the master step.
- **ADC** (landed, §3): AVCC is the board node from the end of the previous 1 ms step. The count is `floor(V/Vref·1024)`, clamped to 1023. The sample-and-hold is a closed form, not a live 14 pF node. A channel whose net is a stamped circuit node reads that node's solved voltage, and `rSource` is the node's Thevenin resistance from the same factor. A net outside a stamp keeps the wire rules in §3. INL, DNL, noise, the noise canceller and temperature drift are omitted.
- **Current-limit floor**: a `thevenin-limit@1` rail feeding regenerating motors needs a clamp (the bridge's body diodes) so the terminal voltage cannot go negative.
- **Run report** adds the **passivity sum** at each circuit/body cut (joules injected by the coupling) and flags it when it grows.
- **Board power path:** a supply port with `connector: "usb"` (the catalog `usb-a-port` pin `5V`) wired to an Uno `5V` is the USB cable. `path:uno-usb` is an alias for the Uno class-2 board netlist: the power-input group (PTC fuse, P-channel switch, the +5V capacitors, and the VIN regulator when that pin is driven), the board load (full current down to 1 V, then linear to 0 A at 0 V), and every servo on that node. The cable's Thevenin attaches to the internal `VBUS`. The same connector wired to a Nano `5V` is the cable into the Nano's USB connector. At class 2 the firmware `board` netlist stamps the power-input group (the Schottky from `VBUS` to +5V, the 10 µF capacitor, and the AMS1117 when VIN is driven), the other +5V capacitors, the board load, the D13 LED and the reset network, and servos on `nano.5V` load that node. The cable's Thevenin attaches to `VBUS`. A bench supply on that `5V` attaches to `5V`, and the Schottky is pruned because its anode is open. At class 1 the firmware `board` netlist stamps the power group at behaviour class 1, which is that group's branch snapshot, plus the board load. It has no +5V capacitors, so the stamp is algebraic. A usb feed attaches the cable's Thevenin to `VBUS`, the same as class 2, including a port outside any one capture point. A bench supply on `5V` attaches to `5V`, and the branch is pruned because `VBUS` is open. Circuit parts wired on the board's pins, such as a breadboard LED, still stamp. A bench supply on an Uno `5V` is the header. It attaches at `5V`, leaves `VBUS` unfed, and keeps the capacitors on `5V`. Several boards on one supply are that one rail: one source, and each board's netlist, node, brownout, reset and pins. A supply with circuit parts and no firmware board is its own rail: the supply's Thevenin and those parts, ground at 0 V. The supply record's `current` is the terminal current and its `voltage` is the terminal voltage. The board record's `voltage` is the 5V node, and `minVoltage` is that node's minimum over the frame. `leds` maps each LED instance path on that rail to its forward current in amperes, the time-weighted mean over that frame's circuit steps (a 0.1 ms sub-step and a 1 ms master step each count for their own length). `ledCurrent` is the deprecated alias of `leds["<board>.led"]`, the same frame mean. A part with a power port reports `voltage` as V+ relative to GND. With no cable the board node equals the supply terminal, and both are reported.
- **Brownout** reads the board node: the lowest board-node voltage over that millisecond's sub-steps. With no cable the board node is the supply terminal.

## Open for v2

- The transaction level for buses.
- The checkpoint format (D-003, D-019).
- Registry governance: who publishes parts, and whether they are signed.
- Visual levels beyond box, mesh and cutaway.
- `transfer-fn@1` once a deep level has state (E4).
