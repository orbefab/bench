/**
 * Layered simulation types v1 (docs/formats.md, ADR 0010, D-023).
 * Files store SI numbers. This module is types and constants only.
 */

export const AXES = ["behaviour", "body", "visual"] as const;
export type AxisName = (typeof AXES)[number];

export type LevelClass = 0 | 1 | 2 | 3;
export const LEVEL_CLASSES = [0, 1, 2, 3] as const;

export type Domain =
  | "electrical"
  | "rotational"
  | "translational"
  | "thermal"
  | "mount";

export type Quantity =
  | "Voltage"
  | "Current"
  | "Resistance"
  | "Inductance"
  | "Angle"
  | "AngularVelocity"
  | "Torque"
  | "Position"
  | "Velocity"
  | "Force"
  | "Temperature"
  | "HeatFlow"
  | "Mass"
  | "Inertia"
  | "Time"
  | "Frequency"
  | "Pose"
  | "Wrench"
  | "Dimensionless"
  | "TorquePerCurrent"
  | "TorquePerAngularVelocity";

export type DimKey = "kg" | "m" | "s" | "A" | "K" | "mol" | "cd" | "rad";
export type Dim = Partial<Record<DimKey, number>>;

export const DIM_KEYS: readonly DimKey[] = [
  "kg",
  "m",
  "s",
  "A",
  "K",
  "mol",
  "cd",
  "rad",
];

/** Pose and Wrench are composite and match by name only. */
export const QUANTITY_DIM: Record<Quantity, Dim> = {
  Voltage: { kg: 1, m: 2, s: -3, A: -1 },
  Current: { A: 1 },
  Resistance: { kg: 1, m: 2, s: -3, A: -2 },
  Inductance: { kg: 1, m: 2, s: -2, A: -2 },
  Angle: { rad: 1 },
  AngularVelocity: { rad: 1, s: -1 },
  Torque: { kg: 1, m: 2, s: -2 },
  Position: { m: 1 },
  Velocity: { m: 1, s: -1 },
  Force: { kg: 1, m: 1, s: -2 },
  Temperature: { K: 1 },
  HeatFlow: { kg: 1, m: 2, s: -3 },
  Mass: { kg: 1 },
  Inertia: { kg: 1, m: 2 },
  Time: { s: 1 },
  Frequency: { s: -1 },
  Pose: {},
  Wrench: {},
  Dimensionless: {},
  TorquePerCurrent: { kg: 1, m: 2, s: -2, A: -1 },
  TorquePerAngularVelocity: { kg: 1, m: 2, s: -1, rad: -1 },
};

export const SI_UNIT: Record<Quantity, string> = {
  Voltage: "V",
  Current: "A",
  Resistance: "Ω",
  Inductance: "H",
  Angle: "rad",
  AngularVelocity: "rad/s",
  Torque: "N·m",
  Position: "m",
  Velocity: "m/s",
  Force: "N",
  Temperature: "K",
  HeatFlow: "W",
  Mass: "kg",
  Inertia: "kg·m²",
  Time: "s",
  Frequency: "Hz",
  Pose: "pose",
  Wrench: "wrench",
  Dimensionless: "1",
  TorquePerCurrent: "N·m/A",
  TorquePerAngularVelocity: "N·m·s/rad",
};

export const COMPOSITE_QUANTITIES = ["Pose", "Wrench"] as const;

export const DOMAIN_QUANTITIES: Record<
  Domain,
  { across: readonly Quantity[]; through: readonly Quantity[] }
> = {
  electrical: { across: ["Voltage"], through: ["Current"] },
  rotational: {
    across: ["Angle", "AngularVelocity"],
    through: ["Torque"],
  },
  translational: { across: ["Position", "Velocity"], through: ["Force"] },
  thermal: { across: ["Temperature"], through: ["HeatFlow"] },
  mount: { across: ["Pose"], through: ["Wrench"] },
};

export type SiTagged = {
  v: number;
  q: Quantity;
  d: Dim;
  /** Rejected unless it is the SI unit of `q`. */
  unit?: string;
};

export type SiNumber = number | SiTagged;
export type Range = [SiNumber, SiNumber];
export type Vec3 = [number, number, number];
export type Sym6 = [number, number, number, number, number, number];

export type LogicRatings = {
  vil?: SiNumber;
  vih?: SiNumber;
  vol?: SiNumber;
  voh?: SiNumber;
};

export type Ratings = {
  voltage?: Range;
  absMaxVoltage?: Range;
  current?: Range;
  absMaxCurrent?: Range;
  logic?: LogicRatings;
  frequency?: Range;
  torque?: Range;
  speed?: Range;
  temperature?: Range;
  resistance?: Range;
};

export const RATING_FIELD_QUANTITY: Record<string, Quantity> = {
  voltage: "Voltage",
  absMaxVoltage: "Voltage",
  current: "Current",
  absMaxCurrent: "Current",
  frequency: "Frequency",
  torque: "Torque",
  speed: "AngularVelocity",
  temperature: "Temperature",
  resistance: "Resistance",
  vil: "Voltage",
  vih: "Voltage",
  vol: "Voltage",
  voh: "Voltage",
};

export type PortRole = "power" | "ground" | "logic" | "analog";
export type PortDirection = "in" | "out" | "inout" | "passive";

export type PortDecl = {
  domain: Domain;
  role?: PortRole;
  direction?: PortDirection;
  pwm?: boolean;
  adc?: boolean;
  frame?: string;
  ratings?: Ratings;
};

/**
 * Repeated pins. `id` contains `{n}`. `pwm` and `adc` are either every
 * pin or the indices that receive the flag.
 */
export type PortTemplate = {
  id: string;
  n: [number, number];
  domain: Domain;
  role?: PortRole;
  direction?: PortDirection;
  pwm?: boolean | number[];
  adc?: boolean | number[];
  frame?: string;
  ratings?: Ratings;
};

export type BusDecl = {
  ports: string[];
  protocol: string;
};

export const PART_TYPE_FORMAT = "sfab.part-type@1" as const;
export const PART_FORMAT = "sfab.part@1" as const;
export const LOCK_FORMAT = "sfab.lock@1" as const;
export const RUN_REPORT_FORMAT = "sfab.run-report@1" as const;
export const SNAPSHOT_FORMAT = "sfab.snapshot@1" as const;
export const FIXTURE_FORMAT = "sfab.fixture@1" as const;

export type PartTypeFile = {
  format: typeof PART_TYPE_FORMAT;
  id: string;
  ports: Record<string, PortDecl>;
  templates?: PortTemplate[];
  buses?: Record<string, BusDecl>;
  /** D-023.7. Checked by the linter; dimension vectors cannot see a prefix. */
  plausible?: Partial<Record<Quantity, Range>>;
};

export type Pose = {
  position: Vec3;
  rotation: [number, number, number, number];
};

export type Params = Record<string, number | string | boolean>;

/** `instance.port` on a composite netlist. */
export type PortRef = string;

export type Netlist = {
  instances: Record<string, { part: string; pose?: Pose; params?: Params }>;
  wires: [PortRef, PortRef][];
  expose: Record<string, PortRef>;
};

export type FormId =
  | "slew@1"
  | "dc-motor@1"
  | "thevenin-limit@1"
  | "ideal-voltage@1"
  | "resistor@1"
  | "capacitor@1"
  | "diode@1"
  | "logic-in@1"
  | "table@1"
  | "transfer-fn@1"
  | "multibody@1";

export type FormDef = {
  params: Partial<Record<string, Quantity>>;
  optional?: readonly string[];
};

/**
 * Param quantities the checker knows. Joint friction, damping and
 * armature are not behaviour params (D-023.1). `capacitor@1` and
 * `diode@1` are named in the spec without a param table.
 */
export const FORM_PARAMS: Record<FormId, FormDef> = {
  "slew@1": { params: { omega: "AngularVelocity" } },
  "dc-motor@1": {
    params: {
      K: "TorquePerCurrent",
      R: "Resistance",
      L: "Inductance",
      efficiency: "Dimensionless",
      eSat: "Angle",
      quiescent: "Current",
    },
    optional: ["L"],
  },
  "thevenin-limit@1": {
    params: { V: "Voltage", Rs: "Resistance", Ilimit: "Current" },
  },
  "ideal-voltage@1": { params: { V: "Voltage" } },
  "resistor@1": { params: { R: "Resistance" } },
  "capacitor@1": { params: {} },
  "diode@1": { params: {} },
  "logic-in@1": { params: {} },
  "table@1": { params: {} },
  "transfer-fn@1": { params: {} },
  "multibody@1": { params: {} },
};

/** Forms whose `V` param is the supply setpoint (D-023.2). */
export const SUPPLY_FORMS = ["ideal-voltage@1", "thevenin-limit@1"] as const;

export type BehaviourImpl = { omits: string[] } & (
  | { kind: "form"; form: FormId; params: Record<string, SiNumber> }
  | { kind: "snapshot"; ref: string }
  | { kind: "composite"; netlist: Netlist }
  | {
      kind: "firmware";
      chip: string;
      imageParam?: string;
      params?: Record<string, number>;
      fuses?: Record<string, string>;
      /**
       * Onboard circuit for this board's `5V`. Absent means the pin is
       * the supply terminal: no capacitors, D13 LED, or reset network.
       * `nano-usb` inserts the Schottky when a `usb-a-port` feeds `5V`,
       * and the same network without the Schottky from any other supply.
       */
      boardCircuit?: string;
    }
  | { kind: "script"; script: string }
);

export type BodyImpl = { omits: string[] } & (
  | {
      kind: "lumped";
      mass: number;
      com: Vec3;
      inertia: Sym6;
      joint?: { armature?: number; frictionloss?: number; damping?: number };
    }
  | { kind: "urdf"; file: string }
  | { kind: "mjcf"; file: string }
  | { kind: "children" }
  | { kind: "none" }
);

export type VisualImpl = { omits: string[] } & (
  | { kind: "mesh"; files: string[]; placeholder?: boolean }
  | { kind: "box"; size: Vec3 }
  | { kind: "children" }
  | { kind: "none" }
);

export type ClassSlot<T> = {
  default: string;
  variants: Record<string, T>;
};

export type AxisMap<T> = Partial<Record<"0" | "1" | "2" | "3", ClassSlot<T>>>;

export type Citation = { title: string; ref: string };

export type PartFile = {
  format: typeof PART_FORMAT;
  id: string;
  type: string | PartTypeFile;
  foreign?: boolean;
  declaredOnly?: boolean;
  sources?: Citation[];
  ratings?: Record<string, Ratings>;
  axes?: {
    behaviour?: AxisMap<BehaviourImpl>;
    body?: AxisMap<BodyImpl>;
    visual?: AxisMap<VisualImpl>;
  };
};

export type LevelSpec = LevelClass | Partial<Record<AxisName, LevelClass>>;

export type WorldFileV2 = {
  version: 2;
  environment: {
    ground: { plane: boolean };
    gravity: Vec3;
    air?: { density: number };
    primitives?: unknown[];
    stepProps?: unknown[];
  };
  run: {
    seed: number;
    levels: {
      default: LevelSpec;
      types?: Record<string, LevelSpec>;
      paths?: Record<string, LevelSpec>;
      nets?: Record<string, "digital" | "analog">;
    };
  };
  root: {
    id: string;
    part: string | PartFile;
    pose?: Pose;
    params?: Params;
  };
};

export type LockSource = "world" | "library" | "catalog" | "inline";

export type LockPart = {
  id: string;
  version: string;
  sha256: string;
  source: LockSource;
  path: string;
};

export type LockType = {
  id: string;
  sha256: string;
  source: LockSource;
  path: string;
};

export type LockFile = {
  format: typeof LOCK_FORMAT;
  world: string;
  parts: LockPart[];
  types: LockType[];
};

export type Diagnostic = {
  severity: "warning" | "error";
  path: string;
  port: string;
  quantity: string;
  left: string;
  right: string;
  message: string;
};

export type RunReport = {
  format: typeof RUN_REPORT_FORMAT;
  world: string;
  seed: number;
  rngDraws: number;
  lock: {
    parts: {
      id: string;
      version: string;
      sha256: string;
      source: LockSource;
    }[];
    types: { id: string; sha256: string; source: LockSource }[];
  };
  levels: {
    path: string;
    part: string;
    type: string;
    axis: AxisName;
    class: LevelClass | null;
    variant: string | null;
    impl: string;
    reason: string;
    source: "default" | "type" | "path" | "fallback";
  }[];
  nets: {
    id: string;
    domain: string;
    ports: string[];
    level: string;
    reason: string;
  }[];
  buses: { path: string; name: string; protocol: string; ports: string[] }[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
  snapshots: {
    path: string;
    axis: AxisName;
    ref: string;
    quality: string;
  }[];
  snapshotQuality: string;
  notSimulated: {
    path: string;
    axis: AxisName;
    class: LevelClass | null;
    effects: string[];
  }[];
  foreign: { path: string; part: string; qualityCap: "Q1" }[];
  /** Empty when the loader did not start a run. */
  engines: { name: string; cost: string }[];
};

export type SnapshotQuality = "Q0" | "Q1" | "Q2a" | "Q2b" | "Q3";

export type SnapshotFile = {
  format: typeof SNAPSHOT_FORMAT;
  partType: string;
  part: string;
  axis: "behaviour" | "body";
  form: FormId;
  ports: { inputs: string[]; outputs: string[] };
  params: Record<string, number | number[]>;
  envelope: {
    bounds: Record<string, Range>;
    data?: {
      kind: "mahalanobis";
      mean: number[];
      cov: number[][];
      limit: number;
    };
  };
  error:
    | "none-available"
    | {
        metric: "free-run-max-abs" | "free-run-rms";
        quantity: string;
        value: number;
        corner?: "typ" | "min" | "max";
        heldOut: "fixture" | "use-like" | "both";
        baseline?: { level: string; value: number };
      }[];
  quality: SnapshotQuality;
  provenance: {
    source: "captured" | "authored" | "measured" | "imported";
    from?: { part: string; level: string; hash: string };
    fixture?: { ref: string; hash: string; seed: number };
    data?: { file: string; sha256: string; rig?: string };
    tool?: { name: string; version: string; file?: string };
    citations?: Citation[];
    bench: { version: string; mujoco?: string; avr8js?: string };
    created: string;
  };
};

export type FixtureFile = {
  format: typeof FIXTURE_FORMAT;
  partType: string;
  mount: "clamped" | { load: { inertia: number; torque?: number } };
  sweeps: { port: string; quantity: Quantity; values: number[] }[];
  inputs: {
    port: string;
    signal: "step" | "chirp" | "prbs";
    params: Record<string, number>;
  }[];
  record: string[];
  duration: number;
  seed: number;
};
