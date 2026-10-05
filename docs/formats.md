# Layered simulation: types and formats v1

**Status:** v1, adopted by [ADR 0010](decisions/0010-layered-simulation.md). `D-nnn` references are the settled decisions listed in that ADR. The nearest open standards (ADR 0010, D-011) are in §9. §10 lists what the circuit experiments proposed and the run does not do yet; each lands with the code that needs it.

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
- a root part may force a net with `play.levels.nets` (a legacy `.world.json` uses `run.levels.nets`).

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
  resolution?: Resolution[];
};

type Ratings = {
  voltage?: Range; absMaxVoltage?: Range;
  current?: Range; absMaxCurrent?: Range;
  logic?: {
    vil?: LogicThreshold; vih?: LogicThreshold;
    vol?: SiNumber; voh?: SiNumber;
    vcc?: SiNumber;                       // the supply these were cited at
  };
  frequency?: Range; torque?: Range; speed?: Range;
  temperature?: Range; resistance?: Range;
};

type LogicThreshold = SiNumber | [number, number];   // volts, or [k, b] = k·vcc + b
type BusDecl = { ports: string[]; protocol: string };   // "uart", "i2c", "spi"; transaction level later
```

**Logic thresholds.** A number is volts. A datasheet row stated against the supply is `[k, b]`, meaning `k·vcc + b`: the 328P's GPIO are `[0.3, 0]` / `[0.6, 0]` (VIL max 0.3·VCC, VIH min 0.6·VCC), its RESET `[0.1, 0]` / `[0.9, 0]` (VIL2 / VIH2), the 32U4's GPIO `[0.2, -0.1]` / `[0.2, 0.9]`. The 32U4's RESET cites no pair and has none. A port with a `[k, b]` threshold cites `vcc`, the supply its absolute values were stated at; without it the check is a `rating` error. One resolver, `logicThresholds(logic, vcc)` in `packages/parts`, serves both readers: the static check resolves at the cited `vcc`, a run at the solved board node. In a run, a GPIO whose net has a circuit (the pin is stamped) reads its solved node before the CPU, the ADC's one-step lag: above VIH high, below VIL low, and between them the last level holds, starting low. There is no hysteresis constant; the VIL–VIH band is the datasheet's guaranteed one. A pin with no circuit on its net keeps the wire walk (another output, then ground, then a supply). Runtime reset stays the chip's `resetFraction`.

**Resolution.** The smallest difference a port tells apart in one field, cited (run 7):

```ts
type Resolution = {
  field: "voltage" | "current" | "angle";              // one the port's domain carries
  kind: "precision" | "reader";
  value: SiNumber;                                      // finite, positive
  reference: { kind: "absolute" } | { kind: "ratio-to"; quantity: string };  // "PORT.field" on the same part
  conditions?: ({ kind: "within-ratings" } | { kind: "steady@1"; window: SiNumber })[];
  source: Citation;                                     // a title and a ref
};
```

A `precision` is how close the part holds a field it drives; it is judged on settled samples only, so it carries `steady@1`, whose `window` W is in seconds. A `reader` is the step of a value the part reads; it is judged at its conversions and never carries `steady@1`. With `absolute`, the value is in the field's unit; with `ratio-to`, it is a fraction of another port's field in the same quantity, so the units cancel. `within-ratings` judges only where the operating `voltage` and `current` ratings of the port and of its ratio port hold. A part states its own by port (`PartFile.resolution`); one for a field and kind the type also states replaces the type's. Library lint refuses anything else: another kind, reference or condition, an unknown key (on a reference too), a reader of a field other than `voltage`, `steady@1` stated twice, a field the domain does not carry, a value that is not finite and positive or is tagged in another quantity, a ratio to a port the part does not have or in another quantity, a precision without `steady@1`, a reader with it, a missing source, a port the type does not have, and two of one field and kind on one port. A resolution is data about a reading, not about how a part runs: it is not in a capture signature.

The catalog states two. `sfab/sg90@1.0.0` `shaft` angle precision is π·10/1856 rad (0.0169), the 10 µs dead band over Servo.h's 544–2400 µs span for half a turn, stricter than the datasheet's band read as π/100; `steady@1` W is 0.06 s, three 20 ms frames. It is on the part, not on `hobby-servo-3wire`, which the MG90S shares. The Uno R3's and Nano's `A{n}` voltage reader is 1/1024 `ratio-to` `5V.voltage` with `within-ratings` (ATmega328P datasheet DS40002061, ADC). A conversion on the internal reference is not a ratio to `5V`.

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
  resolution?: Record<string, Resolution[]>;    // per port; replaces the type's by field and kind
  play?: PlayBlock;                             // read only when this part is the root of a run
  capture?: { behaviour?: CaptureRecipe; body?: CaptureRecipe }; // how to capture that axis of this part
  axes: {
    behaviour?: AxisMap<BehaviourImpl>;
    body?: AxisMap<BodyImpl>;
    visual?: AxisMap<VisualImpl>;
  };
};

// A `table@1` recipe (behaviour). A `hinge@1` recipe (body) has `form`, `fixture`, `baseline`,
// `heldOut: "fixture"`, `sourceLevel` and `into?` instead. A group recipe (behaviour, any other
// form) has `form`, `sourceLevel`, `baseline`, `heldOut: "fixture"`, `scene`, `deep`, `snap`,
// `vNominal` and `into?` (§6 Capture).
type CaptureRecipe = {
  variant: string; instance: string;            // the variant to stamp and the board instance that holds it
  across?: [string, string]; through: string;   // the port pair, and the port the current goes through
  iSense: 1 | -1; fitV: number;
  baseline: { level: string; value: number };
  heldOut: "fixture" | "use-like" | "both";
  staticError?: boolean;
  sweep: { fixture?: string; currentPort?: string; currentQuantity?: string; current?: number[] };
  envelope: { marginA?: number };
  fit?: "diode@1";                              // write this law fitted to the sweep, not a table; its ports bind to `across` in order
  into?: string;                                // level that takes the new variant; absent: the level that holds a snapshot
};

// D-004: classes 0..3, named variants inside each class, one default per class.
type AxisMap<T> = Partial<Record<"0" | "1" | "2" | "3", { default: string; variants: Record<string, T> }>>;

// Read only when this part is the root of a run. A nested part keeps it, and the run ignores it.
type PlayBlock = {
  gravity: Vec3;                                // m/s²
  seed: number;
  timestep: number;                             // seconds; 1 ms / k runs (see play)
  levels: {
    default: LevelSpec;
    types?: Record<string, LevelSpec>;
    paths?: Record<string, LevelSpec>;          // unprefixed, as in a world: "servo"
    nets?: Record<string, "digital" | "analog">;
  };
  air?: { density: number };                    // kept so a world import does not drop it
  primitives?: unknown[];                       // static props; not parts
  stepProps?: unknown[];
};
```

Every implementation carries `omits: string[]`: the effects this level leaves out. It feeds the report's "not simulated" list. For example, the SG90 behaviour class 1 `datasheet` variant omits gear backlash, motor inductance and winding heat, and the `group` snapshot adds the wiper sense lag.

```ts
type BehaviourImpl = { omits: string[] } & (
  | { kind: "form"; form: FormId; params: Record<string, SiNumber>;
      bind?: Record<string, string> }                 // the form's port → this part's port, for a form that lists its ports (the snapshot lint, section 6)
  | { kind: "snapshot"; ref: string }
  | { kind: "composite"; netlist: Netlist }
  | { kind: "firmware"; chip: string; imageParam?: string; params?: Record<string, number>; fuses?: Record<string, string>; resetPort?: string; pinMapFrom?: { class: LevelClass; variant: string; instance: string }; railVoltage?: number; resetFraction?: number; minOperatingVoltage?: number }
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
  instances: Record<string, {
    part: string; pose?: Pose; params?: Record<string, number | string | boolean | { $param: string }>; level?: LevelSpec;
    target?: { shape: "box" | "sphere" | "cylinder"; size: Vec3 | number | { radius: number; length: number }; path?: { t: number; position: Vec3 }[] };
  }>;
  wires: [PortRef, PortRef][];
  expose: Record<string, PortRef>;             // the composite's ports → inner ports
};
```

- Instance numeric `params` override form params of the same name. For example, a bench supply takes the world's voltage and current limit.
- A netlist child's param may be `{ "$param": "<name>" }`, meaning the parent instance's param `<name>`. The child sees the plain value: `resolveLevels` resolves the reference against the parent instance's resolved params before it visits the child, so a forward through two composites resolves at each level, and `Params` (the resolved record everything else reads) stays scalar. The parent's params are the ones its own instance carries in the document above it (after that instance's own references resolve). A name the parent instance does not set leaves the child's key out and, unless the reference is `optional`, is an error diagnostic on the child (`param <key> forwards $param <name>, which the parent instance does not set`); it never becomes `undefined`. With `"optional": true` the key is left out when the parent does not set the param, and there is no diagnostic: a board uses this to forward `firmware` and `source` to its chip child when a bare board has no image. The linter checks the part: the value must be `{ "$param": string }` with an optional `"optional": true` and nothing else, and the composite must declare `<name>`. A composite declares a param when a child takes it under a name that child part declares (a firmware `imageParam` or `source`, a form param, a variant param), and it inherits that quantity, so `set-param` on the composite's instance takes it. `set-param` may write or clear a reference, and undo restores the reference as written. Rename and add-instance keep it. The world view records each resolved reference on the child node as `forwards`: the key is the child's param, `from` is the parent instance path, and `param` is the parent param name. The instance card shows those params read-only. A param the instance sets itself is absent from `forwards` and stays editable on that instance.
- A netlist instance may set `level` (`LevelSpec`, defined with the world). A bare number sets behaviour, body and visual. An object sets the named axes. A path rule beats that level, and that level beats a type rule. A parent class replaces a request only while it is still the default. The report reason is `instance level`.
- The chip is a part. `sfab/atmega328p@1.0.0` is the ATmega328P. `sfab/atmega32u4@1.0.0` is the ATmega32U4 (ports `PB0`–`PB7`, `PC6`, `PC7`, `PD0`–`PD7`, `PE2`, `PE6`, `PF0`, `PF1`, `PF4`–`PF7`, plus `VCC`, `AVCC`, `UVCC`, `UCAP`, `AREF`, `VBUS`, `D+`, `D−`, `GND`, `UGND`, `RESET`). XTAL1 and XTAL2 are not ports: the clock is the part's parameter. Unbonded bits (PC0–PC5, PE0, PE1, PE3–PE5, PF2, PF3) are not ports. The 328P's ports are the chip pins (`PB0`.., `PC0`.., `PD0`.., `ADC6`, `ADC7`, `RESET`, `VCC`, `AVCC`, `GND`) and its firmware variant holds the image params. The Nano's non-default class-1 variant `ideal-terminal` is a firmware level with no chip child and no board circuit: the Nano is its own board on an ideal terminal, and it still plans the D0–D13, A0–A5 header from its `pinMapFrom` (see the pin map below). A firmware variant carries the chip's electrical facts as data: `railVoltage` (volts; picks the power input), `resetFraction` (V_RST / VCC) and `minOperatingVoltage` (volts; a running chip above its brownout level and below this is outside its specification at the part's clock). Its `params` carry the brownout levels and `resetHoldS` (below) and the pin drive (`roh`, `rol`, `rpu`, `rLeak`; see `avr-pin@1`). A variant that lacks any of these, or `railVoltage` or `resetFraction`, does not run. The board sits idle with one `degraded` row, code `unsupported`, that names what is missing (`chip "atmega328p" lacks brownoutVoltage, rLeak`). The run does not borrow another chip's numbers. A board-level `quiescent` (amperes) is a param on the chip child. Every board on a supply is stamped into that supply's one circuit, each under its instance path, with its own board node, brownout, reset and pins. `fuseStart: "tripped"` trips every `ptc-fuse@1` stamped on the rail. A header feed has none after the prune.
- A firmware variant may set `resetPort` to the logic port the chip uses as reset (`RESET` on the Nano, the Uno and the 32U4, which the Pro Micro brings out as `RST`). The Uno's class-2 netlist does not carry its reset network yet (the 10 kΩ pull-up and the capacitor from the USB bridge); a RESET the world leaves unwired runs. Each chip's reset threshold is its fraction of its own board node: `atmega328p` is 0.9, and the 32U4 is 0.85 (VRST max, Atmel-7766J Table 29-1). Each board on a shared rail reads its own reset node.
- RESET below that threshold at any point of a master step holds the chip in reset, as a brownout does. A chip that loads or reloads while RESET is low runs no instruction. A held reload is still recorded as a reload, with its marker. The board reads `inReset: true` and `resetCause: "pin"` (`"brownout"` when the rail is what holds it, including before a fresh image runs), and the card says "in reset (RESET pin)". A recorded frame carries `inReset` and `inResetAny` (any step of the frame window). The release waits for both the rail and the pin, then the chip's reset hold, and a RESET that goes low again inside the hold starts it over. The `reset` event carries `cause: "pin"` when the pin asserted it. A brownout reset has no `cause`, so older recordings read the same. The boot that ends a pin hold writes `— external reset —` to the console. One the rail sagged in writes `— brownout reset —`.
- A RESET wired to a GPIO pin follows that pin only when the pin is in the solve. A pin is stamped only when its net also holds a circuit part of its own board, such as the Nano's D13 LED, and at class 1 no pin is. Otherwise the pin's level does not reach RESET: a net with nothing else on it has no voltage, a class-2 RESET pull-up keeps the net high, and either way the chip runs.
- Brownout assert, release, and the reset hold are params on that chip. The Pro Micro's 32U4 is BODLEVEL 011: typical 2.6 V (Table 8-1), hysteresis 50 mV typical (Table 8-2), so assert is 2.575 V and release is 2.625 V. The hold is 65 ms (Table 6-4, the 65 ms term; the 14 CK are omitted). The 328P's assert is 2.675 V and its hold is 66 ms. A running chip above its brownout and below `minOperatingVoltage` is outside its specification. For the 32U4 at 16 MHz that floor is 4.5 V (Figure 29-2). An unknown `chip` degrades that board: severity `degraded`, code `unsupported`. The rest of the document still runs.
- The board's supply input is the non-internal port with `role: "power"`, `direction: "in"`, and a voltage rating that contains the chip rail. The run prefers the candidate a supply is wired to. `VIN` on these boards is rated above the 5 V rail, so it is not the chip's voltage pin, and a supply on `5V` still wins when both are wired. A supply wired only to `VIN` attaches at `VIN`. The regulator input is the one other non-internal, non-connector port with `role: "power"` and `direction: "in"` once the rail is taken: `VIN` on the Nano and the Uno, `RAW` on the Pro Micro. None, or more than one, means the board has no regulator input. A supply wired only to `RAW` attaches at `RAW`. The onboard regulator then feeds the 5 V node. If the chosen level cannot express a port this scene drives — a class-1 branch snapshot does not expose a port that has a supply on its net — that part runs the nearest runnable level on the axis. Nearest is the smallest class distance; on a tie, the more detailed level. The card's reason is `nearest runnable level`, source `fallback`. Ground is the non-internal port with `role: "ground"`. A port's `connector` names the cable family. The catalog `usb-a-port` pin `5V` says `usb`, and so does the internal `VBUS` on the Nano and the Uno, so a usb supply on `5V` lands on `VBUS` when the board is a composite with a netlist, and on `5V` otherwise. A bench supply has no connector, so it attaches to `5V`. On that header feed, `VBUS` is unfed: the fuse and the switch drop, and the capacitors the netlist puts on `5V` stay.
- A board is a composite: its netlist holds the chip part as a child, the board's circuit parts, and an `expose` from the header ports onto them. The expose table is the pin map: a header port exposed onto a chip pin names that pin. A firmware level of the same part has no chip child, so it names its pin map: `pinMapFrom: { class, variant, instance }` is a composite level of that part and the chip child in it, and that composite's expose onto the child is the header (the Nano's `ideal-terminal` names `{ class: 1, variant: "avr8js", instance: "mcu" }`). The child's part id plays no part. The linter refuses a firmware level on a part with a composite level when it names no `pinMapFrom`, when the level is missing or not a composite, when the instance is not in its netlist or no expose reaches it, or when the instance's part has no firmware variant on the same `chip`. Below the root the loader idles a refused part with that row. The loader keeps a refused root part, so when a document unwraps to such a board the planner idles it, with the same row on the root path. Either way the board never runs as a bare chip. A running composite level uses its own expose; the shipped boards list the same header at every class. A bare chip authors no such expose, and each pin in the chip spec is its own name. **Board id:** a firmware chip that is a netlist child of a composite whose `expose` reaches one of its ports runs as that parent's board, and the board id is the parent's path. Any other firmware part is its own board. The world addresses the board as one instance. The clone Nano (`sfab/nano-ch340@1.0.0`), the Uno (`sfab/uno-r3@1.0.0`), and the SparkFun Pro Micro (`sfab/pro-micro@1.0.0`) are this shape. The Pro Micro's header names follow the Nano (Arduino pin numbers, not the silkscreen `TX0`/`RX1`): `D0` is PD2, `D1` is PD3, then `D2`–`D10`, `D14`–`D16`, and `A0`–`A3`. `D11`–`D13` are not broken out. `RAW` is the unregulated input, re-exposed from the power child's `VIN`. Class 0 is `pins`, class 1 (`avr8js`) is the chip and the power input, and class 2 (`circuits`) adds the reset network, the +5V capacitors, a 1 µF UCAP capacitor, and the RX and TX LEDs. Those LEDs are active low on PB0 and PD5. They are internal ports (`RXLED`, `TXLED`), not header pins, and the CPU still drives them. The RX LED instance is `led`, so the card's LED current is that LED. The regulator is `sfab/nano-power-input`: an AMS1117-5.0 standing in for the board's MIC5219, not a new regulator part. Timer 4 and USB CDC are not emulated. After a 32U4 image loads, each is one `degraded` row (codes `timer4` and `usb-cdc`) and one board warning with the same code. A 328P board has neither. On the Nano, class 2 (`circuits`) adds the reset network, the +5V capacitors and the D13 LED to the class 1 (`avr8js`) netlist, which is the chip and the power input and stays algebraic. The chip child takes the board's `firmware` and `source` params through `{ "$param": "firmware", "optional": true }`: `optional` omits the key when the parent has no such param, instead of erroring. The D13 LED, the reset network and the rail capacitance stay in that variant's omits. `VBUS` is an `internal` power port on `arduino-nano`. It is not a wiring target. A part whose only other node is then unconnected, such as the Schottky with an open anode, is pruned. No extra conductance is added. The chip's own ports do not appear on the parent's nets: the header port is the net member.
- The run flattens composites before dispatch, at any depth, including a group inside a board netlist. An instance whose selected behaviour is `composite` is a shell and is not itself a runtime. Leaves are dispatched by behaviour kind and form: `firmware`, a form id, or a `urdf` body with `multibody@1`. A leaf with no runtime sits idle. The diagnostic names the path and the form or kind, with severity `degraded`. A wire endpoint is the instance path, then the port, split at the last `.`, so a world wire can land on a nested exposed port. Poses compose: the run places a robot, board, ranger or drawn box by its own pose taken through every group above it, so an assembly instanced with a pose carries its parts, and one part file can be placed twice. The world root is placed once and the editor may move it, so its pose (or that of the one top-level instance a document unwraps into the root) places nothing. The editor moves only an instance the open part owns directly; a part inside another part file moves with its parent.
- A part's ports come from one model. A typed part keeps its type's ports. Each name is fixed by the type, and `expose` maps it to an inner ref as before. A composite whose type declares no ports (today, `assembly`) bubbles free nets. A free net is one connected component of the composite's child ports: wires join ports, a child port no wire touches is a net of one pin, and a component an `expose` entry already names is not free. Each free net is one outer port, not one port per pin. Names are assigned in lexicographic order of the net's sorted refs. The preferred name is the lexicographically smallest pin name, so pins that agree stay `GND` or `5V`, and `5V` beats `V+`. The first net keeps that name. A collision takes `<instance>_<pin>` from the earliest ref whose pin is the preferred name, then `_2`, `_3`. A `.` in a generated name becomes `_`, because a ref splits at the last `.`. Source is `type`, `expose`, or `auto`. A port is fixed when its source is `type` or `expose`, or when it has a dependent. Dependents are scanned on every call (projects are small): every wire and `expose` entry in another project part that names `<instance of this part>.<port>`, and every project, personal, or catalog snapshot whose `provenance.from.part` is this part. A cache would key on the hashes of `parts/**` and the snapshot files. An edit that would rename an auto port with dependents, or merge or split its net, writes the old name into `expose` in the same undo step, pointing at the first remaining ref. Undo removes that pin with the rest of the step. A parent wire or `expose` that names a port the child no longer has is dropped. The run continues. The warning is `broken-port`: the parent part, the wire or expose, and the missing port. Adding a wire to a port that is not there is still an error.
- A circuit part (`resistor@1`, `capacitor@1`, `diode@1`, `led@1`, `ptc-fuse@1`, `pmos-switch@1`, `ldo-regulator@1`, `comparator@1`) belongs to the rail of the supply its nets reach. There is one rail per connected power island: every supply whose grounds meet, and every board on those supplies. Grounds meet on a net with no pin of another kind; a port with no run pin (a composite shell's) passes the walk, so a ground wire between two assemblies ties their supplies. A single board is that rail with N = 1, the same element ids and node names. A firmware board adds its stamp and pins. A part that reaches that island and shares no net with the board is still stamped on the board. A supply with those parts and no board stamps them against the supply's positive and ground ports. A circuit part that reaches no supply and no board takes the rail of a circuit part it shares a non-ground net with (a winding between a bridge's outputs); one that reaches none sits idle, and the diagnostic names the path, severity `degraded`, code `unpowered`. Supplies whose grounds stay apart are not one circuit. Several boards and several supplies on one island are that one rail: each supply stamps on the node its positive pin reaches, that board's USB, voltage or regulator port (VBUS, 5V or VIN on the shipped boards), or its own net when the wire reaches no board feed. Wires that join pins already share a node. After the stamps are built, every placed part is in exactly one stamp. Ownership ignores ground nets: a part belongs to the board whose non-ground nets it touches. A shared ground is not an owner. A part whose non-ground nets touch two boards is stamped once, on the island rail, and its nodes are those boards' real node names. A part nested under one board stays in that board's stamp. A scene part `realize` drops is a degraded row, `degraded <path>: not connected in this circuit`. A board netlist child the feed drops on purpose is not. A part reached by two supplies on one island is stamped once on that rail. Several firmware boards share one supply: each board netlist is stamped into that one rail. A servo or a ranger draws on, and reads, the node of the board its `V+` or `VCC` reaches. A servo whose `V+` reaches no board uses the board that drives its signal. A part with neither draws on the rail's first board, by id, and reads that node. A part no supply reaches reads 0 V, the same in the live state, the recording, and the sensor's own reading. Pin edges inside a master step are split on every rail, including N = 1. A branch snapshot is stamped like any other circuit part and shares that supply. The supply is always a part. A v1 draft has neither a stamp nor a snapshot, and those pairs still share.
- An instance string param `urdf` replaces the body file of a part whose body is `urdf`. The path is relative to the project folder.
- Children are instantiated when the chosen behaviour is a composite. The lockfile still lists children of every class.
- A `gear-train` stores shaft-side inertia, damping and friction in SI. Teeth are positive integers. `collapse()` reflects them onto the output: armature is Σ n²J, damping is Σ n²B, frictionloss is Σ |n|τ, and n is |ω_shaft / ω_output|, the product of `teethDriven / teethDriver` walking from the output. The run uses that hinge. It does not instance the gear bodies. On the SG90 the same train is the servo's body class 2, for the whole-servo law, and the `gears` child's body class 1, for the class-2 composite; both collapse to one hinge. In the composite the motor's shaft reaches the joint through the `gears` child, so the train is that collapse and its ratio (see `dc-motor@1`).

### Board power path

A supply port with `connector: "usb"` (the catalog `usb-a-port` pin `5V`) wired to an Uno `5V` is the USB cable. The Uno board netlist has the power-input group (PTC fuse, P-channel switch, the +5V capacitors, and the VIN regulator when that pin is driven), the board load (full current down to 1 V, then linear to 0 A at 0 V), and every servo on that node. The cable's Thevenin attaches to the internal `VBUS`. The same connector wired to a Nano `5V` is the cable into the Nano's USB connector. At class 2 the board netlist stamps the power-input group (the Schottky from `VBUS` to +5V, the 10 µF capacitor, and the AMS1117 when VIN is driven), the other +5V capacitors, the board load, the D13 LED and the reset network, and servos on `nano.5V` load that node. The cable's Thevenin attaches to `VBUS`. A bench supply on that `5V` attaches to `5V`, and the Schottky is pruned because its anode is open. At class 1 the board netlist stamps the power group at behaviour class 1, which is that group's branch snapshot, plus the board load. It has no +5V capacitors, so the stamp is algebraic. A usb feed attaches the cable's Thevenin to `VBUS`, the same as class 2, including a port outside any one capture point. A bench supply on `5V` attaches to `5V`, and the branch is pruned because `VBUS` is open. Circuit parts wired on the board's pins, such as a breadboard LED, still stamp. A bench supply on an Uno `5V` is the header. It attaches at `5V`, leaves `VBUS` unfed, and keeps the capacitors on `5V`. Several boards on one supply are that one rail: one source, and each board's netlist, node, brownout, reset and pins. A supply with circuit parts and no firmware board is its own rail: the supply's Thevenin and those parts, ground at 0 V. The supply record's `current` is the terminal current and its `voltage` is the terminal voltage; its `minVoltage` and `maxCurrent` are the extremes over the frame's circuit sub-steps. The board record's `voltage` is the 5V node, and `minVoltage` is that node's lowest over the frame's circuit sub-steps. `leds` maps each LED instance path on that rail to its forward current in amperes, the time-weighted mean over that frame's circuit steps (a 0.1 ms sub-step and a 1 ms master step each count for their own length). `ledCurrent` is the deprecated alias of `leds["<board>.led"]`, the same frame mean. `pinVolts` maps each stamped pin's header port to its solved node over the frame: `v` the time-weighted mean over the circuit steps, `lo` / `hi` the lowest and highest step. Pieces end at pin edges, so a square wave's extremes are steps. A downsampled read widens `lo` / `hi` across the frames it skips. The probe shows a stamped pin from `pinVolts`; a pin with no circuit is its level times the board node. A part with a power port reports `voltage` as V+ relative to GND. With no cable the board node equals the supply terminal, and both are reported. A board with no `VIN` pin, such as the Pro Micro, uses `RAW` as that unregulated input: a bench supply on `RAW` attaches there and the regulator feeds the 5 V node.

Brownout reads the board node: the lowest board-node voltage over that master step's sub-steps. With no cable the board node is the supply terminal. The chip resets at the first sub-step the node is under its assert voltage. The servos it drives on that same rail open there for the rest of the step, so the step's torque and the current charged for them are the share before the crossing. A servo on another supply's rail runs to the end of that step. The CPU still ran the whole step before the solve. At a 1 ms step the board node can undershoot the assert voltage by one 0.1 ms sub-step of slew: arm-stall records 2.557 V where a 0.01 ms run records 2.674 V (`brownout-step.selfcheck.ts`).

### `avr-pin@1` and the ADC

A firmware board carries `avr-pin@1` as numbers on the variant's `params`, not as a `form`. The names are `roh`, `rol`, `rpu` and `rLeak`, in ohms. High is the board's 5V node. Low is 0 V. `rLeak` belongs to the pin element. The rail stamps one pin for every exposed GPIO pin whose net contains a circuit part. Each of those pins follows `driveMode` at the master step. The ADC uses the same numbers.

Live GPIO on a board's state tick is three little-endian lists of 32-bit words, `ddr`, `level`, and `toggled`. Bit `i` in word `i >> 5` (bit `i & 31` of that word) is pin `i` of that board's `WorldViewBoard.pins`. `ddr` is 1 when the pin is an output. `level` is the logic level the CPU reads: an output's own level (PORT, or a timer's compare output while it holds the pin) and PIN for an input. `ddr` and `level` come from the same pin model as the mode below. `toggled` is 1 when that pin's output word changed since the previous state tick (a level edge; a DDR write alone is not one). A recording made before this format has one word per board and reads as a one-word list. `pinBitSet` also accepts a bare number as one word. The words carry only the pins in `pins`: a board whose CPU also drives internal pins (the Pro Micro's `RXLED` and `TXLED`) has those bits cleared, live and recorded (`boardPinState`). Their current still shows through the board's LEDs.

DDR and the port's output word choose the mode, read when the rail solves and when a conversion starts. The output word is PORT with a timer's compare output in place of the bits it holds: `analogWrite` never writes PORT. On an input bit it is PORT.

| DDR | Output word bit | Mode |
| --- | --- | --- |
| 1 | 1 | `high` |
| 1 | 0 | `low` |
| 0 | PORT 1 | `pullup` |
| 0 | PORT 0 | `input` |

Each mode change inside a master step ends a piece of that step's solve: a PORT or timer edge, and a DDR write too (an output released to its pull-up or input, an input driven), each stamped with its CPU cycle. So a PWM pin drives its circuit for its duty, and a released pin stops driving where the CPU released it.

An input with nothing else on the net is 0 V through `rLeak`. A pull-up with nothing else on it is the board node through `rpu`. A pin that is its own output reads that level unloaded: `high` through `roh`, `low` through `rol`.

The ADC keeps avr8js's conversion time. The count is `floor(V / Vref · 1024)`, clamped to 0..1023, after the sample-and-hold. The hold is a closed form, not a live 14 pF circuit node, and it is exact at 0 Ω.

AVCC (REFS = 01) is the board node at the end of the previous master step, latched before the CPU runs, so the conversion lags the rail by at most one master step. A board that starts in the same quantum, after the solve, sees that solve. On the 328P the internal 1.1 V reference (REFS = 11) is the bandgap. AREF (REFS = 00) is 0 V: no shipped board brings AREF out to its header (the 32U4 chip part has an `AREF` port; the Pro Micro does not expose it), and a conversion against it reads 0. A reserved reference (REFS = 10) also reads 0. The AREF pin circuit is omitted.

| MUX | Input |
| --- | --- |
| 0–7 | A0–A7, single-ended, from the net |
| 8 | Temperature, 0.314 V. DS40002061 Table 24-2, typical at 25 °C. A constant. |
| 14 | Bandgap, 1.1 V. DS40002061 ADC Characteristics, internal reference 1.0 V min, 1.1 V typical, 1.2 V max. |
| 15 | 0 V |

That mux table is the ATmega328P (DS40002061). The ATmega32U4 takes the channel's label from the board expose, not from a fixed A0–A7 list. On the Pro Micro, A0 is PF7 (ADC7) and does not set MUX5; D4 is PD4 (ADC8) and does. MUX5 is ADCSRB bit 5, the bit Arduino's `analogRead` sets; avr8js reads bit 3 (ADTS3 on the 32U4), so the chip moves the bit for avr8js during the conversion start and the firmware reads back what it wrote. A channel the header does not bring out reads 0 V. REFS 11 on the 32U4 selects the internal 2.56 V reference (Atmel-7766J Table 29-7, VINT typical), reported as `internal-2v56`. The 328P's REFS 11 stays the 1.1 V bandgap. The 32U4 temperature mux (0x27) is omitted, so that conversion reads 0 V. AREF is still 0 V.

On the 328P boards, A0–A5 follow the table above and A6 and A7 are analog only. On the 32U4, each header label maps through the expose, as above. A net with this board's `5V` reads the board node. `GND` reads 0 V. A power or ground port wins over the pin's own mode. Any other net that is a node of a stamped circuit reads that node's solved voltage at the conversion's master step. The source resistance is the node's Thevenin resistance from the same factor: one extra backsolve with a 1 A injection, and only when a conversion happens. A net that is not in a stamp, including another pin or a part the circuit did not take, reads 0 V through `rLeak`.

Omitted: ADC INL and DNL, ADC noise, the noise canceller, temperature drift, and the AREF pin circuit.

**Model forms** are versioned equations that parts and snapshots fill in:
- `slew@1`
- `position-servo@1` (K, R, L?, efficiency, eSat, quiescent): a whole hobby servo as one law, the lumped model of the servo group. On the circuit it is one fused branch on the board node, `R`, `L` (optional, 0 is legal) and `K`, with ω an input held for the master step. `efficiency`, `eSat`, `quiescent` and the torque limit stay in the behaviour law and do not enter the circuit. Its control loop reads the type's one electrical logic input (`signal` on `hobby-servo-3wire`); a type with no logic input sits idle with a diagnostic. That input binds to a board pin by the GPIO binding rule: the one digital board pin on the port's resolved net, which holds a shell's exposed port and the inner port alike, so an instance name or a transparent shell does not change it. A net with no board pin leaves the port unbound. A net with two or more is not supported: the port stays unbound and the plan has a degraded `wiring` row on that port (`Trig reaches 2 board pins (nano.D7, nano.D9); one is supported`). The pulse input of `servo-control@1` and the ranger's `Trig` and `Echo` bind the same way. `K` is output-side, gearbox included. Braking current is clipped: a negative `s·I` does not return to the rail.
- `dc-motor@1` (K, R, L?, efficiency; ports `A`, `B`): a bare brushed DC winding between two nodes. `K` is the motor's own shaft constant. The branch is `V(A) − V(B) = R·i + K·ω`, plus `L` when it is above 0, with ω held for the master step. The type's one rotational port leads to a URDF joint, straight or through one part whose body is a `gear-train`; that train's ratio `N` makes `ω = N·ω_joint` and the joint torque `N·efficiency·K·Ī`, where `Ī` is the winding current averaged over the master step. The train is not instanced. Its rigid collapse sets the joint's armature, damping and friction. One motor per joint, and not on a joint a `position-servo@1` part already drives. The torque clamp is the torque rating on the joint's net nearest the scene root. The shaft is named after the instance on the joint's net nearest the scene root (the SG90 group, not its motor), and when that instance has one power input a stamped part sits on, it gets a part row like a `position-servo@1` part's: `current` is what its own stamped parts draw from that input's node at the end of the step, `voltage` is that node against its ground port's node, `torqueNm` is the joint torque, the pulse and command come from the one `servo-control@1` under it, and `state` follows the same idle/moving/stall rule from the bridge ratio and the joint speed.
- `servo-control@1` (eSat, quiescent, travel; ports `V+`, `GND`, `M+`, `M-`, `sense`): a generic hobby-servo control, labelled a model; the SG90's own die is closed. An averaged H-bridge drives `M+` or `M−` to `|s|·V(V+)` and holds the other at `GND`, both as ideal sources, and draws its share from `V+` while it is motoring. Braking current is clipped, as in `position-servo@1`. `quiescent` is a current load from `V+`. The command is the pulse width on the type's one logic input, read from the board pin on that net, through the same pulse tracker as `position-servo@1`. The angle is the sense ratio `(V(sense) − V(GND)) / (V(V+) − V(GND))` times `travel`, latched after the previous solve, so the loop runs one master step behind the joint. `s = clamp((command − angle) / eSat, −1, 1)`. With no command yet the bridge is open.
- `potentiometer@1` (R, travel; ports `A`, `W`, `B`): `A`–`W` is `R·(1 − f)` and `W`–`B` is `R·f`, each at least `1e-6·R`. `f` is `ratio·angle / travel`, clamped to 0..1, read from the joint before the solve and held for the master step; `ratio` is the gear ratio between the wiper's rotational port and the joint, 1 when it sits on the joint.
- `thevenin-limit@1` (supply): `V` (open-circuit setpoint, V), `Rs` (Ω), `Ilim` (A, one-sided). While the load current is under `Ilim`, `v = V − Rs·I`; above it the branch holds `I = Ilim` and the terminal voltage follows the load. `supply.voltage` is `V`, never the terminal voltage. When CV or CC would drive the terminal negative it holds at 0 V, and the current is whatever the load draws.
- `battery@1` (supply, ports `+` and `-`). `ocv` is a table of `[soc, volts]` knots, monotonic, with soc running from 0 to 1. `rInternal` is resistance in ohms. `capacity` is charge in coulombs. `soc0` is the initial state of charge. `vCutoff` is volts, and it is optional. Each master step the terminal is a Thevenin source inside the rail, `V = ocv(soc)` and `R = rInternal`. After the step, `soc` moves by `−I·dt/capacity`, outside the solve. The state is per instance. At `soc = 0`, or when the terminal voltage is at or below `vCutoff`, the next master step stamps `V = ocv(0)` and `R = rInternal`, and the run warns once. The step that first crosses `vCutoff` still reports that crossing voltage. The latch applies from the next master step. The run does not stop. The supply record's `voltage` is the terminal voltage, its `current` is the terminal current, and the record also has `soc`. A recorded frame stores that `soc` beside voltage and current when the supply has a state of charge. Omitted: temperature, Peukert rate capacity, relaxation, and aging. `sfab/battery-3xaa-alkaline@1.0.0` and `sfab/battery-2s-lipo@1.0.0` fill this form.
- `ideal-voltage@1` (`V`, volts). The rail stamps an ideal voltage source on the supply terminal. There is no series resistance and no current limit.
- `resistor@1` (`R`, resistance, ohms)
- `capacitor@1` (`C`, capacitance, farads; `esr`, resistance, ohms, optional). `esr` of 0 is legal and adds no node. `esr` above 0 is a series resistor and an internal node.
- `diode@1` (ports `A`, the anode, and `K`, the cathode; `Is`, current, amperes; `N`, dimensionless; `Rs`, resistance, ohms, optional). A part with other port names takes the form through a snapshot's `bind` (section 6).
- `led@1` (ports `A` and `K`; the `diode@1` law and quantities). A diode that emits light: the run records its forward current under its path (`leds`, and `ledCurrent` for the board's `<board>.led`). `sfab/led-red@1.0.0` runs it.
- `ptc-fuse@1` (ports `A`, `B`). `rCold` and `rHot` are resistance in ohms, and `rHot` must be greater than `rCold`. `iHold` and `iTrip` are current in amperes. `tripPower` is heat flow in watts. `tau` is time in seconds. `uReset` is dimensionless. The branch stamps `rCold` until the thermal state `u` reaches 1, then `rHot`, and it returns to `rCold` once `u` falls to `uReset`. One step of `u` runs per master step, from the current that step solved, outside the solve. Power in that step is `I²` times the resistance the solve stamped. `u` moves toward `I²R / tripPower` with time constant `tau`. The state is per instance, in any stamped circuit. A resistance change drops the factored matrix. `iHold` and `iTrip` are the part's declared currents; the step uses `tripPower`. A static table cannot hold `u`. `sfab/mf-msmf050@1.0.0` fills this form. On the Uno it is F1, between `VBUS` and the P-channel switch.
- `pmos-switch@1` (ports `S`, `D`, `G`). `rds` is resistance in ohms. `vth` is the gate threshold in volts. The body diode uses `Is`, `N` and `Rs`, the same quantities as `diode@1`, and `Rs` is optional. The diode's anode is `D` and its cathode is `S`. The gate is decided once per master step from the previous solve: the channel is on when `V(G) − V(S) ≤ vth`, and on means `rds` in parallel with the body diode. Off leaves the body diode alone. The channel starts on, because the first solve has no previous gate. A state change drops the factored matrix. A missing gate net is an error. `sfab/fdn340p@1.0.0` fills this form. On the Uno, U5A drives the gate. With VIN open, U5A (fed from +5V) compares VIN/2 at 0 V with U2's 3.3 V and holds the gate low, and the USB path stays on. With VIN driven the gate goes to the comparator's positive rail and the channel turns off.
- `ldo-regulator@1` (ports `IN`, `OUT`, `GND`). `vOut` is the regulated output in volts. `dropout` is a table of `[amps, volts]` knots, current rising, dropout not falling; outside the first and last knots the voltage is flat. `iGround` is the ground-pin current in amperes. `iLimit` is the output current limit in amperes. `rOut` is an optional output resistance in ohms. In regulation `OUT = vOut − rOut·I`. In dropout `OUT = IN − dropout(I)`. The two meet in a softmin. Past `iLimit`, and below 0 A, a smooth wall holds the pass current. `iGround` flows `IN → GND` while `IN` is above the bias knee. The law is the solve; there is no per-step state. `IN` is the supply port: the regulator runs only when that node is powered (see below); unpowered, its output is open and it is not stamped. Omitted: line and load transients, PSRR, thermal shutdown and temperature, noise. A reverse path is in the part's omits unless that datasheet gives a DC law. `sfab/ams1117-5v0@1.0.0`, `sfab/ncp1117-5v0@1.0.0`, and `sfab/lp2985-3v3@1.0.0` fill this form.
- `comparator@1` (ports `P`, `N`, `OUT`, `VP`, `VN`). `vHyst` is optional hysteresis in volts. The output is an ideal source to `VP` or `VN`, chosen once per master step from the previous solve, so the read is one master step late. High when `V(P) − V(N)` is above the hysteresis. It starts low. A change drops the factored matrix. `VP` is the supply port: unpowered, both output rails are `VN`, so the output sits at its negative rail whatever the inputs. `sfab/lmv358@1.0.0` fills this form. On the Uno it is U5A.
- `logic-in@1`
- `table@1`
- `transfer-fn@1`
- `multibody@1` (a URDF/MJCF body run by MuJoCo; the arm's class-1 behaviour)
- `hinge@1` (body axis only: `armature` Inertia, `damping` TorquePerAngularVelocity, `frictionloss` Torque). On the behaviour axis it is a load error. A behaviour form on the body axis is a load error.
- `mlp@1` (later)
- `ranger@1` (c, rangeMin, rangeMax, beamHalf, trigMin, echoDelay, echoTimeout, working, quiescent, vMin, face)
- `ground-plane@1` (no params). The catalog part is `sfab/ground-plane@1.0.0`. An instance of it in the root part is the ground plane. No such instance means no ground.
- `target@1` (no params). The catalog part is `sfab/target@1.0.0`. Shape, size, and the scripted `path` sit on the instance as `target`, and the pose sits on the instance. The run places and ray-casts that target the same way it did a world target.

**Powered, open and pruned.** Each realization decides from connections, never from a form or part name. A node is powered when it is a fed node (the feed, the board node, a pin, a node another supply drives) or is reached from one through a part: a form with a supply port passes power only from that port to its output (`ldo-regulator@1` `IN → OUT`, `comparator@1` `VP → OUT`); any other part passes it between all of its ports; ground carries none. A form whose supply port is unpowered becomes its unpowered contribution above. Then a part with a node nothing else drives is pruned, except an output it drives from its own supply. With the Uno's VIN open, the NCP1117 (fed from VIN) goes; the LP2985 and U5A run from +5V, so U2's 65 µA ground current is on the board node.

Catalog supplies on these forms: `sfab/usb2-host-port@1.0.0`, `sfab/usb3-host-port@1.0.0`, `sfab/usb-charger-1a@1.0.0`, and `sfab/bench-supply-2a@1.0.0` (`thevenin-limit@1`); `sfab/battery-3xaa-alkaline@1.0.0` and `sfab/battery-2s-lipo@1.0.0` (`battery@1`). `sfab/usb-port-500ma@1.0.0` and `sfab/bench-supply@1.0.0` are unchanged. Fixed regulators: `sfab/ams1117-5v0@1.0.0`, `sfab/ncp1117-5v0@1.0.0`, and `sfab/lp2985-3v3@1.0.0` (`ldo-regulator@1`). `sfab/lmv358@1.0.0` (`comparator@1`).

Each form declares its params with quantities, its ports, its engine contributions (D-014) and, where one exists, its energy function.

`ranger@1` is the HC-SR04. The part `sfab/hc-sr04@1.0.0` fills the same form twice. The form finds its ports by role on the part's type: the trigger is the first electrical logic input, the echo the first electrical logic output, and power and ground are the `power` and `ground` ports. On `ultrasonic-ranger-4pin` they are `Trig`, `Echo`, `VCC` and `GND`, the names below. Class 0 (`ideal`) casts one ray on the sensor axis. Echo rises 200 µs after Trig falls, the same protocol delay as class 1, so firmware that calls `pulseIn` after the trigger still sees the pin low. The width is exactly `2d/c`. No hit means no pulse. It draws nothing. That delay is part of the module's protocol, not an imperfection, and it is assumed until M3. Class 1 (`datasheet`) casts 41 rays: the axis, then five radial steps out to the 7.5° half-angle and eight azimuths, so the outer ring sits on the cone and two azimuths are horizontal. The nearest hit wins. A hit closer than 2 cm or past 4 m is no echo. Trig must be high for at least 10 µs, and a trigger during a measurement is ignored. Echo rises 200 µs after the falling edge (one 8-cycle 40 kHz burst; assumed until M3) and stays high for `2d/c`, or for 38 ms when nothing returns (assumed until M4). The working current is on the node that feeds `VCC` while a measurement is in progress, and the idle current while powered. Below `vMin`, or with `VCC` unwired, there is no echo and no draw. `c` is 343 m/s. The sheet uses 340 m/s, and the 58 µs/cm rule is 344.8 m/s.

The ray is cast once per accepted trigger, on the physics of the previous master step. The CPU runs before `mj_step`, the same lag as the AVCC latch above. It starts at the transducer plane (`face` metres along the part's local +Y) and goes along +Y, from the part's pose in the scene. That pose is fixed for the run. A sensor on a moving link is not supported yet. When a form that casts rays is in the run (its adapter says `rays`; today `ranger@1`), rays see targets and static primitives only. Every other geom, including robots and the ground, is geom group 1, and the ray includes group 0 only, with `flg_static` set and `bodyexclude` −1. A world with no such form does not change geom groups.

## 4. The part document

The part is the only document ([ADR 0011](decisions/0011-one-document-kind.md)). A run opens a root part: `parts/<publisher>/<name>@<version>.json`, id `publisher/name@version`. The arm example is `examples/arm/parts/sfab/arm-bench@1.0.0.json` because `sfab/arm@1.0.0` is already the robot. Every other example uses `sfab/<world-stem>@1.0.0`. The lock sits beside that file as `<name>@<version>.lock.json`, and `world` in the lock and in the run report is that stem (`arm-bench@1.0.0`).

The root part instances the scene, a ground part when the run stands on a plane, and one target part per target. It carries `play`. Path and net level choices live on `play.levels.paths` and `play.levels.nets`, not on the shared scene: `nano-servo-usb` and `nano-servo-collapsed` both instance `sfab/nano-servo-scene@1.0.0` and choose different levels. The loader unwraps that single scene instance back to `$root`, so a path stays `servo`. An instance `level` still exists and a path rule still beats it.

`play` is read only when that part is the root of the run. A nested part's `play` is kept and ignored. Gravity, seed, and `timestep` (seconds) come from the root. The run steps `timestep` when it is 1 ms divided by a whole number from 1 to 1000 (`0.001`, `0.0005`, `0.0001`, …, `0.000001`). MuJoCo, the circuit (its grid is the step over the same sub-step count), the CPU (`hz·timestep` cycles) and the fuse and battery state all advance one step at a time, and exchange values once per step. Every millisecond is a step boundary: events, serial lines and recorded frames stay on whole milliseconds, and `step(n)` is n milliseconds. Any other `play.timestep`, including one above 1 ms, warns (`timestep-unsupported`) and the run steps 1 ms. The joint-limit stiffness floor stays at the 1 ms value at every step, so a finer step does not stiffen an authored limit. `timestep.selfcheck.ts` runs one scene at 1, 0.5 and 0.1 ms. `play.levels.default` and `types` are the level defaults. `air`, `primitives`, and `stepProps` are optional so a world import does not drop them.

No ground part means no ground. A target instance keeps the same shape, size, pose, and scripted path.

`sfab-bench convert <world.json>` writes the root part and its lock under the project's `parts/` and prints the two project-relative paths.

### Legacy import

A `.world.json` is an import, not a document. The loader converts it in memory on read, then the run reads the run root below, not `WorldFileV2`. That type stays in the contract for the importer, `convert`, and the legacy level-text edit. `bench run` and the server still open a world file. A v1 file is still the hard stop: **World v1 is no longer supported**.

Opening a `.world.json` leaves `report.world` as the file stem (`arm.world`). The in-memory conversion does not pin the synthetic import part, the ground part, or the target part into that lock, so an existing report stays byte-identical. Opening the root part names `report.world` and `report.lock` for that part; those are the fields that differ.

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
    timestep?: number;                                  // omitted on the examples; 1 ms / k runs (see play)
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

### Run root

The loader keeps what a run reads:

```ts
type RunRoot = {
  document: string;                                    // part id; an import uses sfab/import@1.0.0
  play: {
    gravity: Vec3;
    seed: number;
    timestep?: number;                                 // absent when an imported world omitted the step
    levels: PlayBlock["levels"];
    air?: { density: number };
    primitives?: unknown[];
    stepProps?: unknown[];
  };
  stage: { id: string; part: string | PartFile; pose?: Pose; params?: Params };
  unwrapped: boolean;
  slots: { id: string; part: string; kind: "scene" | "ground" | "target" | "other"; pose?: Pose; type?: string }[];
  ground: boolean;
  targets: { id: string; shape: string; size: unknown; pose: Pose; path?: unknown[] }[];
};
```

`play` is the open part's block. `slots` is that part's netlist, in file order. One other instance becomes the stage (`unwrapped`), so `$root` is that scene part and paths stay scene-relative. Any other shape is itself the stage. Ground and targets are taken only from that document's netlist. A pose is the instance pose.

`timestep` is absent only when the import flag says the world file did not name `run.timestep`. A part document always records a step, using `0.001` when `play` omits it. `RunPlan.timestep` is set only when the recorded step divides 1 ms (see `play`). Any other named step warns `timestep-unsupported` and the run steps 1 ms.

### World view

`GET /api/world/view` adds `tree` beside `robots`, `boards`, `supplies`, `parts`, `boxes`, `wires`, and `feeds`. Those fields stay: the stage still draws the robots' URDF, the boards, the boxes, and the environment from them. `boards` is `WorldViewBoard[]`. `pins` is that board's exposed GPIO names, in the order the live pin words use. A later state tick does not repeat the list. `minOperatingVoltage` is the chip part's minimum operating voltage in volts, or null when the chip does not publish one. `clock` is the chip's datasheet name and CPU clock from the chip registry (`{ label: "ATmega32U4", hz: 16000000 }`), or null for a chip the registry does not know; the SOA sentence names that chip and clock. The scrubbed SOA line reads it, `minOperatingVoltage` and `brownoutVoltage` from this view. `ledPin` is the pin the onboard LED (`<board>.led`) hangs on, directly or through one resistor (`D13` on the Nano, `RXLED` on the Pro Micro), or null when the running level stamps no onboard LED. The Uno's netlist has no LED child at either class, so its `ledPin` is null. The card labels the LED current with it. Every live board warning shows on its own line under the status: the SOA band and each gap the chip names.

```ts
type WorldViewBoard = {
  id: string;
  chip: string;
  firmware: string;
  source?: string;
  pose: Pose;
  size: [number, number, number];
  brownoutVoltage: number;                          // volts; the card's brownout line
  minOperatingVoltage: number | null;               // volts; chip SOA floor, or null
  clock: { label: string; hz: number } | null;      // chip name and clock, or null
  pins: readonly string[];                          // exposed GPIO, live pin-word order
  ledPin: string | null;                            // pin the onboard LED hangs on
};
type WorldViewTree = {
  part: string;                                        // document part id
  stage: string;                                       // stage part id
  play: { gravity: Vec3; seed: number; timestep?: number };
  nodes: WorldViewNode[];
};
type WorldViewNode = {
  id: string;                                          // run path: nano, fleet.rig2.servo, $root
  name: string;                                        // instance id; $root uses the stage id
  part: string;
  type: string;
  role: "robot" | "board" | "supply" | "part" | "leaf" | "ground" | "target" | "assembly";
  pose: Pose;                                          // flat instance pose
  ports: { name: string; source: "type" | "expose" | "auto"; fixed: boolean }[];
  params: Params;                                      // instance params, SI
  forwards?: Record<string, { from: string; param: string }>; // $param source
  wires?: { a: string; b: string }[];                  // assembly netlist, file order
  levels: {
    axis: AxisName;
    options: WorldViewLevelOption[];
    chosen: { class: LevelClass; variant: string } | null;
    capture?: { ready: true } | { ready: false; reason: string };
  }[];
  children: WorldViewNode[];
};
type WorldViewLevelOption = {
  class: LevelClass;
  variant: string;
  label: string;
  runnable: boolean;                                   // loader static check
  reason?: string;
  source?: "part" | "snapshot" | "overlay";
  ref?: string;                                        // snapshot id, when the variant is a snapshot
  stale?: string;                                      // why the snapshot no longer matches its part
  deletable?: true;                                    // a capture the card may delete
};
```

`capture` is on the `behaviour` and `body` axes of a placed part, and absent on `visual`, ground and targets. `ready` uses the same lookup and `into` rule as the capture job (the part document's recipe, else the catalog's, then the level that takes the result), so a button that reads `ready: true` does not fail for a missing recipe. `reason` is the sentence to show when it is not ready. `source` says where the option is defined: `part` is the part document and not a snapshot, `snapshot` is a snapshot variant in the part document, and `overlay` is a variant the project's level overlay added (the loader records which variants the merge added). `ref` is the snapshot id of a `snapshot` or `overlay` snapshot variant. `stale` is set only on a snapshot this run loaded, when its recorded hash no longer matches the part. `deletable` is `true` on an `overlay` variant, and on a `snapshot` variant of a project part whose snapshot file is in the project's `snapshots/`; the card shows Delete from it and never from the variant's name.

Children follow the resolved instances, in netlist order, so `fleet.rig2.servo` is a child of `fleet.rig2`. `wires` is that assembly's authored wires, in the same order, and is absent on a leaf. `levels` is one entry per axis the part authors. `runnable` is the loader's static check (a known kind, form, or chip). A composite that names a declared-only part is not runnable, and its `reason` lists those instances (`declared-only parts: <instances>`). It does not re-plan this scene. `play` is the open document's block. Every id in the old fields is a node id with that role. A box whose id is not in `parts` or `supplies` is a `leaf`. Ground and targets are nodes from the document netlist. Their ids are instance ids; they are not rows in `report.levels`.

**Level resolution** (D-005, amended by D-023.3):
1. Per axis, a path rule beats a type rule, which beats the default.
2. Children of the world root use the world default. The scene composite is a container, not a parent. Below that, a nested instance whose request is still the default takes its parent's resolved behaviour class when the parent has that class, whether the parent is a firmware board or a composite. A parent that only reached its class by fallback does not pass it down. The report source is `parent`. A leaf that lacks the parent's class falls back, and the report says so. A part with no behaviour class stays on the world default.
3. A missing class falls back to the nearest **cheaper** class.
4. If there is none, it uses the nearest **deeper** class and reports "capture suggested".
5. A bare class runs that class's default variant. `{ class, variant }` selects that named variant in that class. A variant the part does not have is a plan error naming the path, axis, class and variant. It does not fall back. The level row shows the variant, and the reason says the rule chose it. A named variant does not inherit a parent class.
6. Levels are fixed for a run (D-017).

`world_set_level` writes a class number onto one axis. When that axis held a variant rule, the write replaces the rule with the class alone. An optional `variant` with that axis writes `{ class, variant }` instead. The other axes keep their variant objects.

## 4.1 Edit operations

Tools, the socket, and a script change the open document by sending an `EditOp`. Each one names that document by path. The operation is plain JSON. The part file is not written any other way.

```ts
type EditOp =
  | { kind: "add-instance"; document: string; id: string; part: string;
      pose?: Pose; params?: Params; level?: LevelSpec }
  | { kind: "remove-instance"; document: string; id: string }
  | { kind: "set-pose"; document: string; id: string; pose?: Pose }
  | { kind: "set-param"; document: string; id: string; name: string;
      value?: number | string | boolean }
  | { kind: "set-level"; document: string;
      scope: "default" | "type" | "path"; key?: string;
      axis?: "behaviour" | "body" | "visual"; class: 0 | 1 | 2 | 3 | null;
      variant?: string }
  | { kind: "wire"; document: string; a: PortRef; b: PortRef }
  | { kind: "unwire"; document: string; a: PortRef; b: PortRef }
  | { kind: "rename-instance"; document: string; id: string; to: string }
  | { kind: "rename-part"; document: string; to: string }
  | { kind: "set-play"; document: string;
      gravity?: [number, number, number]; seed?: number; timestep?: number }
  | { kind: "batch"; document: string; label: string; ops: EditOp[] };
```

Every operation may set `confirm: "break"`. Without it, an edit that would drop a fixed port returns needs-confirm and writes nothing: each port, its dependents, and the count N. Stay is not sending it again. Break sends the same edit with `confirm: "break"`. The edit applies. Parents' wires are not rewritten; they become broken ports. `world_edit` takes an optional `part` (a part id; the root is the default) and an optional `break: true`. The socket `edit`, `undo`, and `redo` take the same `part`, and `edit` takes `confirm: "break"`. One history per open part. A catalog part stays read-only.

A port ref is `instance.port`, split at the last dot. `add-instance` adds a child of the document part's composite netlist. `remove-instance` also drops the wires, `expose` entries, and `play.levels.paths` rules that name that instance. `set-param` is SI and is checked against the part's param quantities. `set-level` is the same table edit as `world_set_level`: a class number, or `null` to remove a type or path rule. With `axis` and `variant` it writes `{ class, variant }`. A path variant is checked against that part's variants on the axis. A type does not own variants; the check uses the expanded parts of that type, and refuses when none were expanded. The default cannot be removed. `rename-instance` rewrites wires, `expose`, and path keys in this document. It does not rename the part file. `rename-part` changes the part's name only. Its inverse is a `rename-part` back to the previous name. One step moves the part file, rewrites parents' instance `part` fields, re-pins root locks, and rewrites project snapshots that name the old id. `set-play` may store any positive timestep; one that does not divide 1 ms runs at 1 ms and warns. `batch` is one undo step.

The inverse is an `EditOp` that restores the previous part. `remove-instance` inverts to `add-instance` carrying the instance, its wires, its expose entries, and its path rules, including their order. `wire` inverts to `unwire`, and `unwire` remembers the wire's index. `rename-instance` inverts to the swap. `set-pose`, `set-param`, and `set-play` invert to the previous value, or to a clear when the field was absent. `set-level` inverts to the previous `play.levels` table, because a class number cannot restore a variant rule. A batch inverts to its inverses in reverse order, with the same label.

History is two stacks of `{ label, op, inverse, before, after }`. `before` and `after` are the SHA-256 of the part file text. A new edit clears redo. The stack keeps 200 steps. Each open part has its own history. The step also stores the exact text of every file it wrote, so undo and redo put those bytes back.

An edit is applied in memory, serialized, and loaded through an overlay store that serves the new text for that path. The validation writes no temp file. It loads the open part and every project root that uses it. An edit that makes any of them unreadable is rejected. The load builds the lock. The open part is re-pinned when it has a lock, new parts gain rows, and rows nothing resolves any more are dropped. Any other hash drift is refused. A nested edit re-pins only that part's row in the lock of every project root that uses it, in the same step. It does not create a lock for a nested part that has none while a parent lock exists.

When the step is only the part and its own lock, both are written to `*.edit-tmp`. The part marker is renamed onto the part, then the lock marker onto the lock. A crash between those renames leaves the lock marker. The next open of an edit or a run finishes it, before the loader reads the lock. An empty lock marker deletes the lock. A part marker without a lock marker is an edit that never committed: it is removed, and the part on disk stays. When the step also re-pins other locks, each file gets a `*.edit-set` manifest listing the set. Temps are written, the manifests are rewritten with `committed: true` (the commit point), temps are renamed onto their targets, then the manifests are removed. A crash before the commit point deletes the temps and the manifests. A crash after it finishes the remaining renames. Opening any file in the set heals the whole set. Undo and redo restore every file in the step. If any of those files changed outside the session, undo and redo refuse: `the document changed outside this session`. The next open, or the next apply that can read the new file, clears that history. A catalog part is read-only.

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
  overlays?: { id: string; sha256: string; path: string }[];   // present when a level overlay adds variants to a library part
};
```

The lock sits beside the document. A root part `parts/sfab/arm-bench@1.0.0.json` has `parts/sfab/arm-bench@1.0.0.lock.json`, and `world` is the stem `arm-bench@1.0.0`. A legacy import `arm.world.json` still uses `arm.world.lock.json`, and `world` is `arm.world`.

A part file whose hash no longer matches the lock is an error that names the part. After a deliberate part or type edit, `sfab-bench repin` re-stamps every stale lock row, an assembly check's `fixture.lock`, `children[].hash` and `children[].fromHash`, and a catalog snapshot's `provenance.from.hash`. A new signature is accepted only when a dry capture into a temp catalog reproduces every other byte of the snapshot. It writes nothing and exits 1 when an id set changed, a world does not load, a measured document changed, or a snapshot's numbers would move (re-capture it and review them); `--dry` lists the moves. A path with a `broken` segment is never read. A project's own snapshots (a level overlay capture) are not re-signed; an assembly check that pins one stays red until it is re-captured or remeasured. A snapshot file is pinned the same way, and only when the resolved variant actually runs it. The key is omitted when the run uses none.

Snapshot files are looked up like parts, in `snapshots/<publisher>/<name>@<version>.json` under the world, the personal library, then the catalog (`apps/server/catalog/snapshots/`).

### Level overlay

A catalog or library part is read-only, so a capture of one lands in the project as a level overlay: `overlays/<publisher>/<name>@<version>.levels.json`.

```ts
type LevelOverlay = {
  format: "sfab.level-overlay@1";
  part: string;                                          // the library part's id
  axes: { behaviour?: Record<string, { variants: Record<string, BehaviourImpl> }>;
          body?:      Record<string, { variants: Record<string, BodyImpl> }>;
          visual?:    Record<string, { variants: Record<string, VisualImpl> }> };  // keyed by level "0".."3"
};
```

The loader adds the overlay's variants to the part before it plans. An overlay never removes a variant and never changes a default, except that a level the library lacks takes its first variant, by name, as the default. A variant name the library already has is an error, not an override. The library file is unchanged and keeps its own `sha256`. The lock pins the overlay in `overlays`, keyed by the part id, and a changed overlay is reported like a changed part. A part in the project needs no overlay: its own file holds the variants.

Captures made from the world socket are numbered per part and axis. The next ref is `snapshots/<publisher>/<name>-<axis>-<n>@<version>.json`, the variant is `capture-<n>`, and `snapshots/.captures.json` keeps the counter so a removed capture's number is not reused. The counter file is not pinned in the lock, so copy it with the project. Without it the next number comes from the snapshot files on disk, and the number of a removed capture can be reused.

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
  bind?: Record<string, string>;                         // the form's port → the part's port, when they differ
  params: Record<string, number | string | (number | string)[]>; // behaviour: no joint terms (D-023.1). hinge@1: the joint terms.
  envelope: {
    bounds: Record<string, Range>;                       // "port.quantity": [lo, hi] (D-023.2); no other field
  };
  error: "none-available" | { metric: "static-max-abs" | "free-run-max-abs" | "free-run-rms" | "step-rise"; quantity: string; value: number;
                              corner?: "typ" | "min" | "max"; heldOut: "fixture" | "use-like" | "both";
                              baseline?: { level: string; value: number } }[];
  quality: "Q0" | "Q1" | "Q2a" | "Q2b" | "Q3";           // set by the linter, never by hand
  provenance: {
    source: "captured" | "authored" | "measured" | "imported";
    from?: { part: string; level: string; hash: string };   // level = class string
    variant?: string; instance?: string;                    // plain branch: the behaviour variant and board instance the hash stamped
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

During a run, every key in `envelope.bounds` whose quantity is observed on the rail is checked. There is at most one warning per path and ref. The warning names the port and the bound. The run continues. It does not fall back mid-run. Below the first knot a branch extrapolates its first segment, so a diode branch conducts backwards: the Nano power input carries an LED's current from `5V` back into `VBUS`, where the SS14 blocks, and warns below the 0 A bound (`snapshot-envelope.selfcheck.ts`).

### `hinge@1`

A body-axis form. The axis must be `body`, and a body snapshot must be this form. `armature` (Inertia) is finite and greater than 0. `damping` (TorquePerAngularVelocity) and `frictionloss` (Torque) are finite and non-negative. Port quantities come from the type's declarations and are a rotational port's angle, speed or torque. Envelope keys are on that same port. The type's plausible ranges apply. `hobby-servo-3wire` allows Inertia from 1e-9 to 0.01 kg·m² and TorquePerAngularVelocity from 0 to 1 N·m·s/rad, wide enough for a fitted armature and a reflected one, and tight enough to catch a missing prefix.

`step-rise` is |t₁₀₋₉₀(snapshot) − t₁₀₋₉₀(baseline)| in seconds, on the named quantity. Each side's rise is 10% to 90% of that trace's own start-to-end span. A captured free-run row with a baseline earns Q2a, the same rule as `table@1`. `step-rise` does not grant Q2a by itself.

Each master step compares the driven joint's speed and the applied actuator torque with the snapshot's speed and torque bounds. At most one warning per path and ref. The warning names the port and the bound. The run continues.

The servo adapter takes its joint from the selected body: a lumped joint, a `hinge@1` snapshot, or `collapse()` of a gear train. Anything else is a plan error.

### A behaviour snapshot in another form

A behaviour snapshot whose form is not `table@1` runs as that form, with the file's numeric params (a number or a tagged SI value), as if the variant were `{ kind: "form", form, params }` with the variant's own `omits`. The run dispatches on the form, not on where the numbers came from. When the form's port names are not the part's, the file's `bind` maps each form port to a part port, and the form is stamped on those: a `diode@1` with `bind` `{ "A": "IN", "K": "GND" }` is a diode from the module's `IN` to its `GND`. Without `bind` the form's ports are the part's own. The file must be on the behaviour axis and of the instance's part type, else the instance does not run and the load says why. Its error rows and provenance reach the report like any snapshot's. The run checks the part's own row against the envelope each step, and the first exit warns once (`envelope`) and the run continues. A snapshot that runs as a circuit form is read at the part's own ports: a port's current is what the part's elements draw from that port's node, and its voltage is that node against ground. A port on ground has no reading.

### Quality and the linter

| Quality | Meaning |
| --- | --- |
| Q0 | parses and lints |
| Q1 | plausibility checks pass |
| Q2a | captured, with a measured free-run error against the source |
| Q2b | measured against a real rig |
| Q3 | reserved: no evidence earns it yet, so a claim of Q3 is an error |

Foreign parts are capped (D-009).

The linter is per form. It rejects, and a snapshot that fails cannot run:
- missing provenance (a captured snapshot also needs `from`, `fixture`, and `tool`);
- an envelope with any field besides `bounds` (a statistical envelope such as `data` is not read by the run, so it is refused rather than ignored);
- an `across` port that is not on the type, in any form (the stale check stamps that pair);
- for `table@1`: an axis that is not monotone; a table that does not cover its envelope (the current knots span the current bound); an envelope that bounds a supply quantity or a port the part does not declare, or a `supplyPort`, `supplyRef`, or `supplyAffine` param (a snapshot must not carry its fixture's supply); a listed port quantity the declarations do not match;
- a `bind` key that is not a port the form stamps, a value that is not a port on the type, or a port bound twice. Only forms that list their ports read a `bind`: `diode@1` and `led@1` (`A`, `K`), `dc-motor@1` (`A`, `B`), `servo-control@1` (`V+`, `GND`, `M+`, `M-`, `sense`), `potentiometer@1` (`A`, `W`, `B`). Any other form stamps the part's own ports, so a `bind` on it is an error. The library lint applies the same rule to a part's own `form` level;
- for `hinge@1`: an axis other than body; a body snapshot that is not `hinge@1`; a param that is missing, non-finite or negative; `armature` that is not greater than 0; a port quantity that is not angle, speed or torque on a declared rotational port; an envelope key that is not on that port;
- a missing output that the part type lists in `requiredOutputs` (no such list means no extra output is required);
- values outside the part type's plausible ranges (a current of 10 A or more is also shown in mA);
- non-physical output: voltage at a **0 V setpoint**, checked only inside the envelope, and only when that envelope includes 0 V.

Quality in the file is a claim. The linter grants Q0, Q1, Q2a, or Q2b from the provenance and the error rows, and a claim above that grant is an error. The loader uses the grant only when the file is clean. A captured free-run row with a baseline earns Q2a. A `static-max-abs` row alone stays Q1.

### Capture

`apps/server/catalog/fixtures/capture.config.json` is a list of entries. Capture dispatches on `form`. A `table@1` entry names the part, the variant, the instance, the `across` pair, the port the current goes through, the sweep, the envelope, the baseline level, and an optional free-run case list. A `hinge@1` entry names the part, the fixture, the baseline and the source class. A group entry names a behaviour form, the part, the composite class it is reduced from, a scene world in `examples/` with the part at `scene.instance`, the level rule for that instance on the deep side and on the snapshot side, and the volts a resistive draw inside the group is counted at. The runner reads those fields from the entry. It has no part-specific numbers.

Every runner reads its source through one capture source (`packages/sim/src/capture-source.ts`): the project's parts, types and fixtures, then the catalog's, the order a world load uses. A card capture passes its project; `pnpm capture` reads the catalog alone. Freshness recomputes the signature through the same source, so a capture is fresh in the project it was taken from. The group capture copies the scene project and stages into the copy every part and type its signature read, so the run measures what was signed: a project file is written over the copy's; a catalog part is read from the catalog, with the project's level overlay for it copied in when there is one. When the captured part is not the scene instance's own part, it takes that instance's place, at every level, in the composite that declares it, if its type is the same. Refused: another type, an inline instance, a path whose levels name different parts, and a declaring part the scene holds more than once. The card's capture readiness runs the same source check as the runner (`captureProblem` in `capture-recipe.ts`: the part and its type load; a group has a reduction, one power and one rotational port, and its composite; a hinge has its gear train, a rotational output and shaft ratings; a fixture exists and parses; a sweep has its port pair and a current sweep), so the card and the run refuse with the same reason.

A group capture reduces the composite to the form's params from the deep side's run plan, by form. For `position-servo@1` that is the shaft named after the instance: its one `dc-motor@1` (`K` is the train ratio times the motor's own K, `R`, `efficiency`), the one `servo-control@1` under the instance (`eSat`, and `quiescent` plus `vNominal / R` for each `potentiometer@1` on the shaft), and every travel must be the pulse map's π. It then runs the scene twice, the deep side and the snapshot side with these params, and compares the instance at its own ports: the angle of its rotational output's joint and the current into its power input (the shaft's part row). Those are the free-run max-abs and rms rows. The envelope bounds the power input's current over both runs: the frame values below, the worst step in each frame's window above, widened by the stated max-abs error on that current, since a run nearer than that is inside what the snapshot claims. The voltage is sampled only at the frame, so it is not bounded. `provenance.from.hash` is the group's capture-source signature: the composite at `from.level` and `provenance.variant`, the part's type and own body axis (the snapshot side runs it), and every part the netlist reaches with its type (each part's type, flags, behaviour and body axes; not its visual axis, citations or capture recipe).

A plain-branch capture drives an ideal current source through `p` into `m` on the assembly's stamp and reads `V(p) − V(m)`, with `m` pinned at 0. A converged point is not always an answer: when more than half the driven current flows through the diodes' gmin conductances, no part carries it (a reverse LED at 1 µA reads about −1 MV), and the read fails, naming the leak. So does a drop that is not finite. The sweep's drop must move one way; a sweep that turns back fails the capture. An entry with `fit: "diode@1"` writes that form instead of a table: `V = N·Vt·ln(I/Is) + Rs·I` is linear in `N·Vt`, `−N·Vt·ln Is` and `Rs`, so `Is`, `N` and `Rs` are least squares over the sweep points above 0 A, at 25 °C, to 12 significant figures. A fit with `N` below 0.5 (no knee: a resistor fits with `N` near 0) or `Rs` negative fails. The file keeps `across` in its params and binds `A` and `K` to it in order. Its `static-max-abs` row is the fitted law, solved by the run's engine, against the baseline. `provenance.from` holds the part id and the stamp's capture-source signature: every stamped part with its form, the numbers that form parsed, its nodes and any table or regulator law, before any engine element is built. `provenance.variant` and `provenance.instance` record the behaviour variant and the board instance that were stamped. The stale check reads them from the snapshot; a snapshot that lacks them is unchecked. An entry that asks records `static-max-abs` against its baseline level: the max-abs error over the swept range, between knots included. Capture samples each sweep interval at 32 steps (with a halving ladder into an interval that starts at 0 A) and refines each local peak among the samples; from 0 A that search stays above the ladder's last point, `hi/4096`, since a few nA into a class-2 diode has no solved drop to compare; `snapshot-holdout.selfcheck.ts` checks the stated value on currents capture never evaluated. Free-run rows are written when the entry has cases.

Rebuild with `pnpm --filter @sfab-bench/server capture`. The timestamp comes from the config, not the wall clock.

A capture from the world socket picks the recipe the same way: the part's own `capture` field first, else the catalog entry for that part and axis. A project part is stamped from the project (`parts/<publisher>/<name>@<version>.json`) and its capture lands in that part's own document, whether or not the part is the open document. The recipe's `sweep.fixture` is read from `<project>/fixtures/<sweep.fixture>.fixture.json` when that file exists, else from the catalog's `fixtures/`. A part-document recipe has no free-run `cases`, so it writes the table and the static row only.

### Worked examples

**Branch, Nano power input.** `sfab/nano-power-input@1.0.0` is the SS14 from `VBUS` to `5V` and the 10 µF capacitor, as one group. Class 2 is that composite. Class 1 is the snapshot, a branch between two of the part's own ports: `across` `["VBUS", "5V"]`, current into `VBUS`, swept 0 to 0.9 A. The envelope bounds `VBUS.current`. The supply is not in the table. The Nano class-2 netlist instances the group as `power` and wires through `power.5V` and `power.GND`. A path rule can run that child at the snapshot while the rest of the board stays the circuit. The class-1 Nano board netlist instances the same group with `level: { behaviour: 1 }`, so the branch runs even when a type rule would pick class 2. `baseline.level` is the level the error was measured against, and `value` is that level's own error on the same metric, which is 0 for the capture source. The static-max-abs row is the table's interpolation error against that class-2 group.

**Plain branch, Uno power input.** `sfab/uno-power-input@1.0.0` is the USB front end: a `ptc-fuse@1`, a `pmos-switch@1`, the +5V capacitors, and, in the class-2 netlist, the VIN regulator. The class-1 snapshot is that USB path with VIN open: the VIN regulator is unpowered and not in the stamp, and U5A holds the gate low. The capture holds `5V`, so U2's ground current is not in the `VBUS → 5V` drop. Class 2 is that composite. Class 1 is the snapshot: `across` `["VBUS", "5V"]`, current into `VBUS`, swept from 0 to the fuse's `iHold` (0.5 A). The table cannot hold the fuse's thermal state, so the variant omits fuse trip, thermal state, rail capacitance and temperature, and the envelope stops at that current. Above it the run warns once and continues. `sfab/uno-r3@1.0.0` class 2 instances the group as `power`. The Uno's class 1 (`avr8js`) is its own composite of the chip and this power input.

**Plain branch, any assembly.** `sfab/led-module-red@1.0.0` is 220 Ω and a red LED. Class 1 is the snapshot, a `diode@1` fitted to the sweep `across` `["IN", "GND"]`, 0 to 20 mA, and bound `A` → `IN`, `K` → `GND`. One diode with series resistance is that circuit's own law, so the fit's stated `static-max-abs` against class 2 is 2 nV, where the table stated 1.26 V at the knee. The envelope is the forward sweep, `IN.current` 0 to 20 mA. Backwards the fitted law blocks as class 2 does, to a few pA, so the run reads nothing outside it there; above 20 mA the run warns. `examples/nano/parts/sfab/nano-led-module@1.0.0.json` holds D9 high into that module. At class 1 the record has no inner LED channel.

**Body.** `sfab/sg90@1.0.0` body class 1 default `lumped` is the fitted joint: armature 5e-5 kg·m², damping 0.0025 N·m·s/rad, frictionloss 0.002 N·m. The armature is fitted to the datasheet speed and is 7.4× below the class-2 collapse; the variant's `omits` says so, and a bench measurement decides it. Variant `collapsed` is the snapshot `sfab/sg90-hinge@1.0.0`, the class-2 collapse, so the armature is reflected rather than fitted. Class 2 is the gear train: a 9-tooth pinion, compounds 47:10, 38:8 and 32:7, and a 23-tooth output. Tooth counts are the published brochure figures. Shaft inertias are estimates (a copper rotor cup, POM gear disks). Damping is 70% on the rotor and 30% on the output. Friction is split evenly. The snapshot's ports are `shaft.torque` in and `shaft.angle` out. Its envelope is the speed and torque the fixture reached, clipped to the shaft ratings, so the box covers normal use. `examples/nano/parts/sfab/nano-servo-collapsed@1.0.0.json` selects `{ class: 1, variant: "collapsed" }` on `servo`. Behaviour class 2 is the servo as its four children: `sg90-motor` (`dc-motor@1`, K = 0.458·315/82156 on the rotor, R 7.1 Ω, efficiency 0.57 carrying the gear loss), `sg90-gears` (the train above), `sg90-pot` (`potentiometer@1`, 5 kΩ, an estimate, over 180°) and `sg90-control` (`servo-control@1`, a model of the closed die: eSat 0.3 rad, quiescent 9 mA, which with the pot's 1 mA is the law's 10 mA). On the arm sweep it tracks the law on the class-2 body within 0.31° at a 1 ms step, the one-step sense lag, and differs from the lumped class-1 body by about 9°, the armature gap (`servo-group.selfcheck`). At the servo's own ports it draws within 13.1 mA of the law on the class-2 body, from the same lag, and held still within 0.1 mA (the pot draws V/R where the law draws a fixed 1 mA).

**Group, SG90.** Behaviour class 1 default `group` is the snapshot `sfab/sg90-servo@1.0.0`, captured from class 2 on `examples/arm`'s bench world: the deep side is `{ behaviour: 2 }` on `servo`, the snapshot side `{ behaviour: { class: 1, variant: "group" }, body: 2 }`, so both run the same train. The reduction gives K 0.458, R 7.1, efficiency 0.57, eSat 0.3 and quiescent 0.01, the authored `datasheet` law, which stays as a variant; the snapshot runs bit for bit as it. The stated error is the sense lag: `shaft.angle` within 0.0054 rad (0.31°) and `V+.current` within 13.1 mA (`servo-group.selfcheck`).

A `hinge@1` capture runs the gear train and the collapsed hinge on the same fixture. The deep side is one MuJoCo hinge per shaft and one joint equality per mesh, with the load inertia on the output, at the 1 ms master step. The snapshot side is one hinge from `collapse()`, with the same load. The error rows compare `shaft.angle`: worst-case free-run max-abs and rms, and the worst `step-rise` across the step cases.

### Assembly check

```ts
type AssemblyCheck = {
  format: "sfab.assembly-check@2";
  document: string;                                  // project-relative assembly part
  fixture: { ms: number; hash: string; lock: string };
  detailed: { default: LevelSpec; paths?: Record<string, LevelSpec> };
  snapshot: { default: LevelSpec; paths?: Record<string, LevelSpec> };
  children: { path: string; axis: string; ref: string; hash: string; fromHash: string }[];
  context: string;                                   // the run the snapshot side is (`runContext`)
  quantities: string[];                              // "instance.path.port.field"
  observations: { quantity: string; cadence: "frame" | "step" | "events";
                  phase: "rail" | "body" | "conversion";
                  reference: { kind: "absolute" } | { kind: "ratio-to"; quantity: string };
                  with?: string[] }[];
  identity: string;                                  // the observations, metrics and observer code
  policy: string;                                    // the criteria and the settle predicate
  rows: {
    quantity: string;
    metrics: Metric[];                               // every pair, each cadence
    criteria: {
      kind: "precision" | "reader"; from: string; threshold: number;
      reference: Resolution["reference"]; conditions: Resolution["conditions"]; source: Citation;
      metrics: Metric[];                             // the qualified pairs
      coverage: { qualified: number; ms?: number; excluded: Record<string, number> };
      verdict: "within" | "over" | "none"; by?: number; reason?: string;
    }[];
    verdict?: "none"; reason?: "no resolution";      // no criterion covers the quantity
    inDomain: boolean;
  }[];
  domain: { detailed: Validity; snapshot: Validity };
  inDomain: boolean;
};
type Metric = { metric: string; value: number; pairs: number; unmatched?: number;
                at?: { ms: number; detailed: number; snapshot: number } };
type Validity = {
  envelope: { path: string; ref: string; port: string; quantity: string; range: string }[];
  stale: { path: string; ref: string }[];
  unchecked: { path: string; ref: string; reason: string }[];
  degraded: { path: string; code: string; port: string }[];
};
```

An assembly check lives under `<project>/checks/` and records one assembly run twice on its own fixture: the document as it is (its firmware, supplies and play), with `detailed` as its play levels (side a, the source) and then with `snapshot` (side b). `fixture.hash` and `fixture.lock` are the content hashes of the document and its lockfile. `children` are the snapshots the snapshot side runs, each with the content hash of its snapshot file and its capture-source signature, so a child that is edited or goes stale makes the record stale. The lockfile is hashed as a file; its pins are not re-resolved. Each quantity is `Sim.portReading` at an instance's port.

`observations` names how each quantity is observed (`packages/sim/src/observe.ts`). The cadence is `frame` (t = 0 and the end of every 10 ms frame), `step` (t = 0 and the end of every master step) or `events` (a reader's conversions: the quantity is the reader's own port, `board.port.voltage`, and the value is the held sample at the instant the conversion started, with the reference it latched: its mode, volts and the board port it was read on, or none for an internal one). The phase is what that cadence and field read: a voltage or current is the master step's rail solve, an angle its body step, an event its conversion start; a stored phase that differs is refused. A `ratio-to` reference names another port's field of the same instance: a step value is divided by that port's reading, a conversion by the reference it latched, and only when it was latched on that port; otherwise, or when the reference is zero or not finite, the value is kept and excluded with the reason, and never paired. `with` names quantities read at the same instant, for `within-ratings`. The two runs pair at the same instant, never by order: a frame or step by its master step count, a conversion by the master step in which its board's current CPU ran its first cycle and the CPU cycle it started on. A board runs at most once per master step, so two of its CPUs never start in the same step. Each metric is named (`packages/sim/src/compare.ts`):

| Metric | Over | Definition |
| --- | --- | --- |
| `frame-max`, `frame-rms` | every frame pair | the largest gap and the arithmetic RMS; `@1`'s `free-run-max-abs` and `free-run-rms` |
| `step-max` | every step pair | the largest gap, with its time and both values in `at` |
| `step-rms` | every step pair | the arithmetic RMS over master steps, not time-integrated |
| `settled-max`, `settled-rms` | a precision's qualified step pairs | the largest gap with its `at`, and the arithmetic RMS with no integration across the gaps between them |
| `event-max` (v2) | a reader's qualified conversions | the largest gap |

Two independent bands are never subtracted: a series and its reverse have the same band and a paired gap of the whole range. A row's `metrics` state their `pairs` and `unmatched` count; every frame and step pairs, since both runs are one document.

**Criteria.** Each resolution the quantity's instance states for that field at that port (type and part, the part's replacing) is one criterion, read from those fields alone: no part, type or form name decides one. `from` is the part id when the part states it, else the type id, and the port. A pair is excluded for the first reason that applies, and counted under it in `coverage.excluded`:

| Reason | When |
| --- | --- |
| `start or end of run` | `steady@1`: [t − W, t + W] is not inside [0, the fixture's ms] |
| `moving` | `steady@1`: side a's max − min over every master step in [t − W, t + W] is above the resolution's value. A turning point is moving although its speed is zero; a slow drift below the value qualifies. Side b is not consulted, so a slow candidate is judged, not excused |
| `ratings not observed: …` | `within-ratings`: a rated quantity has no reading at that instant, or the port has an operating rating no observation reads |
| `out of ratings: PORT.rating` | `within-ratings`: a reading is outside the port's operating range (the instance's effective ratings; abs-max is not read) |
| `a: …`, `b: …` | the observation on that side is excluded (another reference, or a zero one) |
| `no counterpart` | the observation is on one side only |

The settle predicate is `steady@1` as written in `STEADY`. A precision is judged by `settled-max` over the qualified pairs, a reader by `event-max`. The verdict is `within` when that is at most `threshold` (equal is within), `over` by how much, or `none`: `no settled samples` (a precision with none qualified), `not read` (a reader with no conversion on either side), `no qualified conversions`. A quantity with no criterion says `none`, `no resolution`, and keeps its metrics. `policy` is the content hash of each criterion's quantity, `from` and resolution as cited, and `STEADY`. `identity` is the content hash of the observations, the definitions of the metrics they reduce to, and a fingerprint of the code that takes, stamps and reduces them (`OBSERVER_SOURCES`: the observe and compare modules, `portReading`, the master step that calls the listener, and the conversion's stamp down to the ADC hook). The fingerprint hashes that code's syntax tree, so a format pass or a comment is the same comparison and any other change is a different one. The engines that compute a value are not in it: the remeasure catches what they move. `domain` is each run's validity from its report, with no observed numbers in it; `inDomain` is true when neither side ran a snapshot outside its envelope, stale or unchecked. A verdict on a run out of domain is still stated, beside it.

`examples/arm/checks/sfab/arm-bench@1.0.0.json` is the arm bench with the servo group and the Uno power input as snapshots. Its `servo.shaft.angle` precision from `sfab/sg90@1.0.0 shaft` is within: `settled-max` 0.00139 rad over 2010 settled master steps of 3001 (120 at the start or end, 871 moving). `servo.V+.current`, `uno.5V.voltage` and `uno.VBUS.voltage` have no resolution. It is out of domain: the snapshot side records the Uno power input's `VBUS` current outside its 0..0.5 A envelope. A child's stated errors are measured on its own fixture and do not add up at a shared port: the servo's current error crosses the USB port's resistance into `uno.VBUS.voltage`.

`assembly.selfcheck.ts` finds every record and is green only when four independent checks pass; a `none` verdict never exempts a row from any of them:

| Check | Red when |
| --- | --- |
| Identity | the document, the lock, a child's snapshot file or its source changed; the detailed side runs a snapshot or the snapshot side a different set than `children`; the snapshot side's run is not `context`; `identity` or `policy` differs (remeasure and state why) |
| Reproduction | any metric of a row or criterion is more than 1e-4 relative from its re-measure, a pair or unmatched count moved, or a max is set at another master step or between other values |
| Domain | either side's validity is not the recorded set: a known excursion stays green, a new or vanished one is red; or `inDomain` moved |
| Applicability and verdict | a criterion's threshold, `from`, reference, conditions, source, coverage or verdict differs: within to over, over to within, either to `none` and back, or `over` by more than 1e-4 relative, the reproduction rule |

Any other world, supply, firmware, seed or step is unchecked. Engine code is checked only through the remeasure. `--write` remeasures and rewrites the hashes, `children`, `context`, the observations (each quantity at `frame` and `step`, and each criterion's own), the identity, the policy, the rows, `domain` and `inDomain`, reading an `@1` record's levels and quantities. `budget.selfcheck.ts` bites the lint, the settle predicate, `within-ratings`, the reader's reference binding, the gate on a stored row, and a renamed and wrapped reader and servo, which judge the same as the originals.

**On a live run.** A stored verdict belongs to the comparison it came from: this parent, these replacements, this observation. `context` is the content hash of the run the snapshot side is (`runContext`, `packages/sim/src/accuracy.ts`): the document without its `id` and `play.levels`; the lock's parts other than the root, its types and its snapshots, each as `{ id, sha256 }`; the report's realized `levels` (`path`, `axis`, `class`, `variant`, `impl`), `nets` (`id`, `domain`, `level`) and `snapshots` (`path`, `axis`, `ref`); and the content hash of every file the run reads, by its project path: each board's firmware image, each robot's URDF and every mesh it names, and each level overlay merged into a part. Each list is sorted. `assembly.selfcheck` takes it from the planner (`planWorld(…, { context: true })`), so the record and the live run hash the same inputs. Loading a document reads `checks/<publisher>/<name>@<version>.json` for its root part id; a record of another format or another `document` is not its check. The record applies to the run only when the run's context is the stored one. Any other run, including the document at other levels or with a part edited, carries the record as not applying, with no rows, and a verdict never moves to the nearest part. A record missing what the card reads (its `children`, `domain`, `context` or a row's criteria) is not its check either. When it applies, each `over` criterion is an `over-budget` warning at the quantity's path and port, naming the snapshots and the record; it says out of domain when the record's `inDomain` is false, with one line per row of its `domain`, or when a snapshot this run loads is stale or unchecked. `within` and `none` show on the card only. `accuracy.selfcheck.ts` bites this on a copy of the arm bench.

### World

A world is a root part that instances more than one assembly. It needs no new document kind. With more than one non-environment instance the root does not unwrap, so every path keeps its instance prefix (`detailed.servo`, `snapshot.uno.power`), and so do board, robot and supply ids. An instance's pose places its assembly: the same part file can be instanced twice, side by side. Mixed levels are path rules on the root's `play.levels` under one instance's prefix; a nested part's `play` is ignored. Assemblies wired to nothing are separate islands; a wire between their `GND` ports joins the islands, and one between their `5V` ports puts both supplies on one rail.

`examples/arm/parts/sfab/arm-world@1.0.0.json` instances the arm scene twice: `detailed` at the origin, at the detailed levels, and `snapshot` 0.35 m along x, with the assembly check's snapshot-side rules under its prefix. `world.selfcheck.ts` reads the assemblies from the plan's tree (role `assembly`) and checks that each, on its own supply, reads exactly what it reads run alone at the same levels; that only the second runs snapshots; that wired `GND`–`GND` and `5V`–`5V` the two supplies are one island and both carry current; and the run's cost. Cost is wall time per simulated second, printed with the machine and asserted only as ratios: the world against its two assemblies run alone, and four detailed copies against one. The gap each assembly carries is its assembly check's; a world states no error budget of its own.

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
- the errors, warnings, and degraded parts. A degraded diagnostic is `{ severity: "degraded", code, path, port, quantity, left, right, message }`. `message` is the human sentence: the detail, without the `port … quantity …:` prefix or the trailing `(… vs …)`. `code` is one of the diagnostic codes below; a load error that leaves the part idle keeps its own code (`missing-file`, `bad-params`, `schema`, …). The list is omitted when nothing degraded, so a clean report stays byte-identical. `bench run` prints each one before the serial lines as `degraded <path>: <message>`. The live state carries `severity`, `code`, `path`, and `message`. A board's warning list shows the ones that name that board, each with its own code, after any 16 MHz supply warning;
- the quality of each snapshot used, and when one ran, its path, axis, and ref, its free-run or static error, envelope warnings (an empty list when the run stayed inside), and provenance for the card: `source`, `from` (`part`, `level`, and `hash`), `fixture` (the ref), and `tool` (`name` and `version`). `snapshots[].stale` is `true` when that hash no longer matches its source, recomputed with the capture runner's own signature (`packages/sim/src/capture-signature.ts`, versioned `sfab.capture-source@3`): the stamp for a plain-branch capture, one whose params name `across`, a table or a law fitted to its sweep; the gear train at `from.level` and `provenance.variant`, and the part's ratings (the capture bounds the envelope by the shaft's), for a `hinge@1`; the group's composite, the root's type, body axis and ratings, and the reached parts with their types and ratings, for any other behaviour snapshot. Ratings are signed because a run reads them: the reduced servo's torque clamp and supply, a motor's net torque. Each signature names its level and variant. The capture still runs and its frames stay. A capture that cannot be checked (a measured snapshot, a provenance with no variant, a source that no longer builds, a group that reaches a child with a snapshot variant, whose file the signature does not cover) is not marked stale: `snapshots[].unchecked` says why, and the run card shows it under the snapshot. A row with a hash and neither field is fresh. The warning is `stale-capture`, naming the part, the level, and the snapshot file. `bench run` prints `broken-port` and `stale-capture` warnings before the serial lines. A pose-only edit, a visual axis, a citation or a resolution does not change a signature: none is part of how the source runs.
- the document's assembly check, when it has one (`accuracy`): `{ record, applies, inDomain, domain, snapshots, rows }`. `domain` words each row of the record's `domain` (empty when in domain). `applies` is the rule under Assembly check › On a live run; `snapshots` are the replacements it compares as `path ref`; `rows` is empty unless it applies. A row is `{ quantity, path, port, field, gap: { max, rms }, criteria }`, the gap being the record's `step-max` and `step-rms`, and each criterion `{ kind, from, threshold, ratioTo?, window?, metric, value?, coverage }` with its verdict (`by` when over, `reason` when none). The field is omitted when the document has no check, so that report stays byte-identical;
- **not simulated**: the `omits` of each chosen level, one row per instance per axis so each keeps its path;
- the seed and the number of random draws;
- the cost per engine: not written yet (`engines` is `[]`). `world.selfcheck.ts` measures a world's wall time per simulated second;
- the energy at each engine seam, when the run has one. The list is omitted when the run has no seam, so that report stays byte-identical. A row is `{ path, kind, sent, received, declared, residual, flagged }`, in joules. `kind` is `motor` for the circuit-to-body cut of a `position-servo@1` servo, or of a `dc-motor@1` shaft, whose row is the shaft id and whose `k` is `ratio·K`, priced at the joint speed. `sent` is `k·ω·I·dt` with the ω and the winding current the rail used. `dt` is the body's timestep, and a 250 ms window is `round(0.25 / dt)` of those steps. `received` is `ctrl·ω̄·dt`, where `ω̄` is the average of the joint speed before the body step and after it: the actuator torque is held for the step and the speed moves from one to the other, so the trapezoid is the work that arrived. `declared` is `(k·I − ctrl)·ω·dt`, the gearbox efficiency and the torque clamp, priced at the rail's ω. `residual` is `sent − received − declared`, which is the coupling lag `ctrl·(ω − ω̄)·dt`. It is not a conservation check of the run. A pin's drive mode is not a seam: the MCU sets the mode and the circuit carries the energy. A `hinge@1` body snapshot replaces the joint's armature, damping, and friction; it does not open a second cut. The battery's state of charge moves inside the circuit engine.
- A seam is **flagged** when the absolute residual in the latest full 250 ms window exceeds both 1 mJ and 5 % of the absolute energy sent in that window, and exceeds the absolute residual of the first full window. The flag is a warning, code `seam-residual-growing`, path the instance, port `shaft`, quantity `Energy`. It is not a degraded row and it does not stop the run. The message is `<path>: the motor seam residual grew to <mJ> in the last 250 ms (<percent> % of <mJ> sent)`, with millijoules shown to 1 decimal under 10 mJ and as an integer at 10 mJ and above. `bench run` prints one line per seam after the serial lines and before the summary, from the ledger after the last step, so an open window is included: `seam <path> <kind>: sent <6 decimals> J, received <6 decimals> J, declared <6 decimals> J, residual <1 significant figure, exponential> J`, with ` flagged` appended when the seam is flagged. The live state's `seams` array is rebuilt only when a window closes.

Its `format` is `sfab.run-report@1`. It is byte-identical across runs with the same inputs. The run keeps it and sends it on the state message: the first snapshot after load, again when an envelope warning is added, and at most once per 250 ms seam window. A world that ran no snapshot still has `snapshots: []` and `snapshotQuality` of `no snapshot used; selected levels are authored forms, firmware, or composites`, and its lock summary omits `snapshots`.

### Diagnostic codes

Every error, warning and degraded row carries a `code`. The list is closed (`DIAG_CODES` in the contract): a new kind of failure adds a code, and a reader keys on the code, never on the message text. A load error becomes a world error with the same code when it is `schema`, `missing-file` or `mesh-format`, and `schema` otherwise.

| Code | Meaning |
| --- | --- |
| `schema` | A file or field is the wrong shape: format, id, port, level or form declaration. |
| `missing-file` | A part, part type, snapshot, mesh, body or firmware image that does not exist. A missing child part sits idle; a missing root refuses the document. |
| `mesh-format` | A mesh the loader cannot read. |
| `bad-params` | A param that is missing, unknown, out of its plausible range, or tagged with the wrong quantity, or a variant that is not on the part. |
| `lock` | The lockfile does not match what the world resolves. |
| `snapshot` | A snapshot the linter refuses, or one that does not fit the part that names it. |
| `stale-capture` | A snapshot whose source part changed since the capture. |
| `unchecked-capture` | A snapshot whose freshness the run cannot check: its provenance names no variant, or the group reaches a part with a snapshot variant. The tree marks the path; the card gives the reason. |
| `shadowed-part` | A project part shadows a catalog part of the same id. |
| `level-ports` | Two composite behaviour levels of one part expose different port sets. |
| `broken-port` | A wire or `expose` names a port or instance that is not there. |
| `wiring` | A connection the run cannot use as wired: a wire joins ports of different domains; a GPIO consumer's net reaches more than one board pin (the port is unbound); a motor shaft reaches no joint, or crosses more than one gear train; a gear train couples no motor to a joint. |
| `rating` | A driver and receiver are logic-incompatible, or a source is outside a power input's rating. |
| `idle` | A part that cannot run at its level for a reason no other code names. |
| `unpowered` | A part no supply reaches. |
| `unsupported` | A chip the run cannot run: its part lacks a fact the run needs. |
| `no-runtime` | A behaviour the run has no runtime for. |
| `timestep-unsupported` | `play.timestep` is not 1 ms divided by a whole number. |
| `battery` | A battery ran empty; the cell keeps its internal resistance and the run continues. |
| `envelope` | A snapshot ran outside its envelope. |
| `over-budget` | The document's assembly check applies to this run, and a quantity's gap is over a resolution there (Assembly check). |
| `seam-residual-growing` | A flagged energy seam (below). |
| `below-16mhz-soa` | A running chip below its minimum operating voltage at its clock. |
| `timer4`, `usb-cdc` | A chip feature the emulator names once and does not emulate. |

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

## 10. Proposed, not built (from the circuit experiments)

These came out of the motor and rail experiments and are not in the run yet. What landed from the same experiments is in §3 (`thevenin-limit@1`, `battery@1`, `position-servo@1`, the board power path, `avr-pin@1` and the ADC) and §8 (`seams`).

- **`averaged-hbridge@1`**: ports are the rail and the motor's electrical port. `V_motor = s·V_rail`, `I_rail = s·I_motor`, plus `quiescent` as a current source on the rail. `s` is the behaviour law's output, not a stored parameter. The engine may fuse the bridge and the winding into one branch.
- **`run.coupling`** on the world, not the part: `scheme` ∈ `explicit | substep | implicit-damping`, `substeps` (default 10), `bemfDamping` ∈ `body | circuit`. Default for a hobby servo is `substep`. A joint with `dt·B/J > 2` selects `implicit-damping`, which puts the derived `B(s) = η·K²/(R + Rs·s²)` on the joint's damping. `B(s)` is derived, never a parameter.
- **Braking current back to the rail** (`I_rail = s·I` may be negative). The engine has this `return` mode, but no part selects it; the run clips (§3). The measured bench (E10) decides which the SG90 part keeps.

## Open for v2

- The transaction level for buses.
- The checkpoint format (D-003, D-019).
- Registry governance: who publishes parts, and whether they are signed.
- Visual levels beyond box, mesh and cutaway.
- `transfer-fn@1` once a deep level has state (E4).
