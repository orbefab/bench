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
  | "Charge"
  | "Resistance"
  | "Capacitance"
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
  Charge: { A: 1, s: 1 },
  Resistance: { kg: 1, m: 2, s: -3, A: -2 },
  Capacitance: { kg: -1, m: -2, s: 4, A: 2 },
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
  Charge: "C",
  Resistance: "Ω",
  Capacitance: "F",
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

/** One `[soc, volts]` knot of a `battery@1` open-circuit curve. */
export type OcvKnot = readonly [number, number];

/** A form param is one SI number, or a table of pairs. */
export type FormParam = SiNumber | readonly OcvKnot[];
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
  /**
   * Present on the type, absent from wiring lists. The Nano `VBUS`
   * pin is the USB connector's 5 V, reached by a cable on `5V`.
   */
  internal?: boolean;
  /**
   * Cable family. A supply and a board port that both say `usb` are
   * the same connector. Absent, the feed is the header.
   */
  connector?: string;
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

/**
 * Project directory of a root part `parts/<publisher>/<name>@<version>.json`.
 * `parts/sfab/arm@1.0.0.json` is `""`. Anything else is null.
 */
const PART_DOCUMENT_RE =
  /^(?:(.*)\/)?parts\/[^/]+\/[^/]+@\d+\.\d+\.\d+\.json$/i;

export function partDocumentProject(path: string): string | null {
  const match = PART_DOCUMENT_RE.exec(path.replace(/\\/g, "/"));
  if (!match) return null;
  return match[1] ?? "";
}

/** A legacy world import. */
const WORLD_DOCUMENT_RE = /\.world\.json$/i;

export function isPartDocumentPath(path: string): boolean {
  return partDocumentProject(path) !== null;
}

export function isWorldDocumentPath(path: string): boolean {
  return WORLD_DOCUMENT_RE.test(path.replace(/\\/g, "/"));
}

/** A file the run can open: a root part, or a v2 world import. */
export function isRunDocumentPath(path: string): boolean {
  return isPartDocumentPath(path) || isWorldDocumentPath(path);
}
export const LOCK_FORMAT = "sfab.lock@1" as const;
export const RUN_REPORT_FORMAT = "sfab.run-report@1" as const;
export const SNAPSHOT_FORMAT = "sfab.snapshot@1" as const;
export const FIXTURE_FORMAT = "sfab.fixture@1" as const;
export const LEVEL_OVERLAY_FORMAT = "sfab.level-overlay@1" as const;

export type PartTypeFile = {
  format: typeof PART_TYPE_FORMAT;
  id: string;
  ports: Record<string, PortDecl>;
  templates?: PortTemplate[];
  buses?: Record<string, BusDecl>;
  /** D-023.7. Checked by the linter; dimension vectors cannot see a prefix. */
  plausible?: Partial<Record<Quantity, Range>>;
  /**
   * Snapshot outputs this type requires, such as `V+.current`.
   * Absent, the linter does not demand a named output.
   */
  requiredOutputs?: string[];
};

export type Pose = {
  position: Vec3;
  rotation: [number, number, number, number];
};

export type Params = Record<string, number | string | boolean>;

/**
 * A netlist child's param that reads the parent instance's param of that
 * name. The loader resolves it to a scalar before the child is visited.
 * The view records which parent instance and param it came from
 * (`ParamForward`). `optional` leaves the child param out, with no report,
 * when the parent has none: a board that runs bare forwards its firmware
 * this way.
 */
export type ParamRef = { $param: string; optional?: true };

/**
 * A resolved `$param`. The child param's value is the parent's scalar.
 * `from` is the parent instance path (`nano`, `fleet.nano`). `param` is
 * the parent param name.
 */
export type ParamForward = { from: string; param: string };

/** `Params` as a netlist child may write them: values, or references. */
export type NetlistParams = Record<string, Params[string] | ParamRef>;

export function isParamRef(value: unknown): value is ParamRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { $param?: unknown; optional?: unknown };
  const keys = Object.keys(value);
  const shape =
    keys.length === 1 ||
    (keys.length === 2 && keys.includes("optional") && row.optional === true);
  return (
    shape &&
    typeof row.$param === "string" &&
    row.$param.length > 0 &&
    keys.includes("$param")
  );
}

/** `instance.port` on a composite netlist. */
export type PortRef = string;

/**
 * One child of a netlist. `level` is that child's authored level.
 * A world path rule for the same instance still wins.
 */
/**
 * Shape, size, and scripted path of a target instance. Pose stays on
 * the instance. The run reads these the same way it read a world target.
 */
export type TargetInstance = {
  shape: "box" | "sphere" | "cylinder";
  size: Vec3 | number | { radius: number; length: number };
  path?: { t: number; position: Vec3 }[];
};

export type NetlistInstance = {
  part: string;
  pose?: Pose;
  /** A value is the child's own. `{ "$param": name }` forwards the parent's. */
  params?: NetlistParams;
  level?: LevelSpec;
  /** Set when this instance is a target part. */
  target?: TargetInstance;
};

export type Netlist = {
  instances: Record<string, NetlistInstance>;
  wires: [PortRef, PortRef][];
  expose: Record<string, PortRef>;
};

export type FormId =
  | "slew@1"
  | "position-servo@1"
  | "dc-motor@1"
  | "servo-control@1"
  | "potentiometer@1"
  | "thevenin-limit@1"
  | "ideal-voltage@1"
  | "battery@1"
  | "ldo-regulator@1"
  | "comparator@1"
  | "resistor@1"
  | "capacitor@1"
  | "diode@1"
  | "ptc-fuse@1"
  | "pmos-switch@1"
  | "logic-in@1"
  | "table@1"
  | "transfer-fn@1"
  | "multibody@1"
  | "ranger@1"
  | "hinge@1"
  | "ground-plane@1"
  | "target@1";

/** Forms that belong on the body axis. Anywhere else is a load error. */
export const BODY_FORMS = ["hinge@1"] as const;

export type FormDef = {
  params: Partial<Record<string, Quantity>>;
  optional?: readonly string[];
  /** Param names that hold a table, not one SI number. */
  tables?: readonly string[];
};

/**
 * Param quantities the checker knows. Joint friction, damping and
 * armature are not behaviour params (D-023.1).
 */
export const FORM_PARAMS: Record<FormId, FormDef> = {
  "slew@1": { params: { omega: "AngularVelocity" } },
  "position-servo@1": {
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
  "dc-motor@1": {
    params: {
      K: "TorquePerCurrent",
      R: "Resistance",
      L: "Inductance",
      efficiency: "Dimensionless",
    },
    optional: ["L"],
  },
  "servo-control@1": {
    params: { eSat: "Angle", quiescent: "Current", travel: "Angle" },
  },
  "potentiometer@1": { params: { R: "Resistance", travel: "Angle" } },
  "thevenin-limit@1": {
    params: { V: "Voltage", Rs: "Resistance", Ilimit: "Current" },
  },
  "ideal-voltage@1": { params: { V: "Voltage" } },
  "battery@1": {
    params: {
      rInternal: "Resistance",
      capacity: "Charge",
      soc0: "Dimensionless",
      vCutoff: "Voltage",
    },
    optional: ["vCutoff"],
    tables: ["ocv"],
  },
  "ldo-regulator@1": {
    params: {
      vOut: "Voltage",
      iGround: "Current",
      iLimit: "Current",
      rOut: "Resistance",
    },
    optional: ["rOut"],
    tables: ["dropout"],
  },
  "comparator@1": {
    params: { vHyst: "Voltage" },
    optional: ["vHyst"],
  },
  "resistor@1": { params: { R: "Resistance" } },
  "capacitor@1": {
    params: { C: "Capacitance", esr: "Resistance" },
    optional: ["esr"],
  },
  "diode@1": {
    params: { Is: "Current", N: "Dimensionless", Rs: "Resistance" },
    optional: ["Rs"],
  },
  "ptc-fuse@1": {
    params: {
      rCold: "Resistance",
      rHot: "Resistance",
      iHold: "Current",
      iTrip: "Current",
      tripPower: "HeatFlow",
      tau: "Time",
      uReset: "Dimensionless",
    },
  },
  "pmos-switch@1": {
    params: {
      rds: "Resistance",
      vth: "Voltage",
      Is: "Current",
      N: "Dimensionless",
      Rs: "Resistance",
    },
    optional: ["Rs"],
  },
  "logic-in@1": { params: {} },
  "table@1": { params: {} },
  "transfer-fn@1": { params: {} },
  "multibody@1": { params: {} },
  "ranger@1": {
    params: {
      c: "Velocity",
      rangeMin: "Position",
      rangeMax: "Position",
      beamHalf: "Angle",
      trigMin: "Time",
      echoDelay: "Time",
      echoTimeout: "Time",
      working: "Current",
      quiescent: "Current",
      vMin: "Voltage",
      face: "Position",
    },
  },
  "hinge@1": {
    params: {
      armature: "Inertia",
      damping: "TorquePerAngularVelocity",
      frictionloss: "Torque",
    },
  },
  /** An infinite plane at z = 0. No params. Absence of the part is no plane. */
  "ground-plane@1": { params: {} },
  /** A mocap body. Shape, size, and path live on the instance, not here. */
  "target@1": { params: {} },
};

/** Forms the plan treats as a supply. */
export const SUPPLY_FORMS = [
  "ideal-voltage@1",
  "thevenin-limit@1",
  "battery@1",
] as const;

export type BehaviourImpl = { omits: string[] } & (
  | {
      kind: "form";
      form: FormId;
      params: Record<string, FormParam>;
      /**
       * The form's port → this part's port, when the names differ (a
       * snapshot in another form). Absent: the form's ports are the part's.
       */
      bind?: Record<string, string>;
    }
  | { kind: "snapshot"; ref: string }
  | { kind: "composite"; netlist: Netlist }
  | {
      kind: "firmware";
      chip: string;
      imageParam?: string;
      params?: Record<string, number>;
      fuses?: Record<string, string>;
      /** Logic port the chip uses as reset. Absent, the rail has no reset node. */
      resetPort?: string;
      /**
       * The chip's electrical facts, as data on the chip part. The run reads
       * them from the firmware variant it resolved. The variant's `params`
       * carry the brownout levels (`brownoutVoltage`,
       * `brownoutAssertVoltage`, `brownoutReleaseVoltage`), `resetHoldS`,
       * and the pin drive (`roh`, `rol`, `rpu`, `rLeak`). A variant that
       * lacks any of these, or `railVoltage` or `resetFraction`, does not
       * run: the board sits idle with an `unsupported` row naming them.
       * `railVoltage`: volts, picks the board's power input.
       * `resetFraction`: V_RST / VCC.
       * `minOperatingVoltage`: volts. A running chip above its brownout level
       * and below this is outside its specification at the part's clock.
       */
      railVoltage?: number;
      resetFraction?: number;
      minOperatingVoltage?: number;
    }
  | { kind: "script"; script: string }
);

/** One shaft of a `gear-train` body. Inertia, damping and friction are shaft-side. */
export type GearShaft = {
  name: string;
  /** Spin inertia about the shaft, kg·m². */
  inertia: number;
  /** Viscous coefficient on this shaft, N·m·s/rad. */
  damping: number;
  /** Coulomb torque on this shaft, N·m. */
  frictionloss: number;
  /** Mass, kg. Absent, a capture body uses a trace mass. */
  mass?: number;
};

/** One spur mesh. `teethDriven / teethDriver` is |ω_driver / ω_driven|. */
export type GearMesh = {
  driver: string;
  driven: string;
  teethDriver: number;
  teethDriven: number;
};

export type GearTrain = {
  input: string;
  output: string;
  shafts: GearShaft[];
  meshes: GearMesh[];
};

export type BodyImpl = { omits: string[] } & (
  | {
      kind: "lumped";
      mass: number;
      com: Vec3;
      inertia: Sym6;
      joint?: { armature?: number; frictionloss?: number; damping?: number };
    }
  | ({ kind: "gear-train" } & GearTrain)
  | { kind: "snapshot"; ref: string }
  | { kind: "urdf"; file: string }
  | { kind: "mjcf"; file: string }
  | { kind: "children" }
  | { kind: "none" }
);

/** A visual form param: a scalar, or one of the part's own params by name. */
export type VisualParam = number | string | boolean | ParamRef;

/** A form a composite draws inside its own box, centred at `at`. */
export type VisualInner = {
  form: string;
  size: Vec3;
  at: Vec3;
  params?: Record<string, VisualParam>;
};

export type VisualImpl = { omits: string[] } & (
  | { kind: "mesh"; files: string[]; placeholder?: boolean }
  | { kind: "box"; size: Vec3 }
  /**
   * A procedural visual: the client's builder for `form` draws it in the
   * box `size` (small features such as tabs and leads may stand out of
   * it), from `params`. A client with no builder for the form draws the
   * box. The run places and picks it as a box. `inner` is what a
   * composite draws inside itself, whatever level its children run at:
   * each sits at `at` in this box's frame.
   */
  | {
      kind: "form";
      form: string;
      size: Vec3;
      params?: Record<string, VisualParam>;
      inner?: VisualInner[];
    }
  | { kind: "children" }
  | { kind: "none" }
);

export type ClassSlot<T> = {
  default: string;
  variants: Record<string, T>;
};

export type AxisMap<T> = Partial<Record<"0" | "1" | "2" | "3", ClassSlot<T>>>;

export type Citation = { title: string; ref: string };

/**
 * Master step when a document does not name one. Matches the body
 * engine's historical 1 ms step.
 */
export const DEFAULT_TIMESTEP_S = 0.001;

/** Most master steps in one millisecond: the finest step is 1 µs. */
export const MAX_STEPS_PER_MS = 1000;

/**
 * Master steps per millisecond for a step of `seconds`, or null when the
 * step is not 1 ms divided by a whole number up to `MAX_STEPS_PER_MS`.
 * Every millisecond is then a step boundary, which the recorder's frame
 * grid and the integer-millisecond clock rely on.
 */
export function stepsPerMs(seconds: number): number | null {
  if (!(seconds > 0)) return null;
  const k = Math.round(DEFAULT_TIMESTEP_S / seconds);
  if (k < 1 || k > MAX_STEPS_PER_MS) return null;
  return Math.abs(k * seconds - DEFAULT_TIMESTEP_S) <= 1e-12 ? k : null;
}

/** Instance path of the document opened as the root part. */
export const ROOT_PATH = "$root";

/** Swap the `$root` prefix of an instance path for the root part's name. */
export function nameRootPath(path: string, rootName?: string | null): string {
  if (
    rootName &&
    (path === ROOT_PATH ||
      path.startsWith(`${ROOT_PATH}/`) ||
      path.startsWith(`${ROOT_PATH}.`))
  ) {
    return rootName + path.slice(ROOT_PATH.length);
  }
  return path;
}

/** Catalog part instanced wherever a run stands on a plane. */
export const GROUND_PART_ID = "sfab/ground-plane@1.0.0";

/** Catalog part instanced for each scripted target. */
export const TARGET_PART_ID = "sfab/target@1.0.0";

/**
 * Gravity, seed, time step, and level defaults. Read only when this
 * part is the root of a run. A nested part keeps the block and the
 * run ignores it.
 */
export type PlayBlock = {
  /** Metres per second squared. */
  gravity: Vec3;
  seed: number;
  /** Master step, seconds. */
  timestep: number;
  levels: {
    default: LevelSpec;
    types?: Record<string, LevelSpec>;
    paths?: Record<string, LevelSpec>;
    nets?: Record<string, "digital" | "analog">;
  };
  air?: { density: number };
  /**
   * Static props a world import still draws. They are not parts.
   * Absent on a part authored in the library.
   */
  primitives?: unknown[];
  stepProps?: unknown[];
};

/** How to capture one axis of a part. The part's id names the capture. */
export type CaptureRecipe =
  | {
      variant: string;
      instance: string;
      across?: [string, string];
      through: string;
      iSense: 1 | -1;
      fitV: number;
      baseline: { level: string; value: number };
      heldOut: "fixture" | "use-like" | "both";
      staticError?: boolean;
      sweep: {
        fixture?: string;
        currentPort?: string;
        currentQuantity?: string;
        current?: number[];
      };
      envelope: { marginA?: number };
      /**
       * Write this two-port law, fitted to the sweep, instead of a table.
       * Its ports bind to `across` in order.
       */
      fit?: "diode@1";
      /** Level id that takes the new variant. Absent: the level that already holds a snapshot. */
      into?: string;
    }
  | {
      form: "hinge@1";
      fixture: string;
      baseline: { level: string; value: number };
      heldOut: "fixture";
      sourceLevel: "0" | "1" | "2" | "3";
      into?: string;
    }
  | GroupCaptureRecipe;

/**
 * A behaviour snapshot in `form`, reduced from the composite at
 * `sourceLevel`. Both levels run on one scene world and are compared at
 * the instance's own ports.
 */
export type GroupCaptureRecipe = {
  form: Exclude<FormId, "hinge@1" | "table@1">;
  sourceLevel: "0" | "1" | "2" | "3";
  baseline: { level: string; value: number };
  heldOut: "fixture";
  /** A world in the bench's `examples/<project>` holding the part at `instance`. */
  scene: { project: string; world: string; instance: string; ms: number };
  /** `play.levels.paths[instance]` on the deep side and the snapshot side. */
  deep: LevelSpec;
  snap: LevelSpec;
  /** Volts a resistive draw inside the group is counted at. */
  vNominal: number;
  into?: string;
};

export type PartFile = {
  format: typeof PART_FORMAT;
  id: string;
  type: string | PartTypeFile;
  foreign?: boolean;
  declaredOnly?: boolean;
  sources?: Citation[];
  ratings?: Record<string, Ratings>;
  /** Capture recipes for a project part. A catalog entry is the fallback. */
  capture?: { behaviour?: CaptureRecipe; body?: CaptureRecipe };
  /** Present on a root document. Ignored when this part is nested. */
  play?: PlayBlock;
  axes?: {
    behaviour?: AxisMap<BehaviourImpl>;
    body?: AxisMap<BodyImpl>;
    visual?: AxisMap<VisualImpl>;
  };
};

/**
 * A class, or one class and the variant that rule selects.
 * A bare class on an axis that had a variant replaces that rule.
 */
export type AxisLevel = LevelClass | { class: LevelClass; variant: string };

export type LevelSpec = LevelClass | Partial<Record<AxisName, AxisLevel>>;

/**
 * Import-only. A `.world.json` the loader converts into a part. A run
 * reads the part, not this type. `convert` and the legacy level-text
 * edit are the other readers.
 */
export type WorldFileV2 = {
  version: 2;
  environment: {
    ground: { plane: boolean };
    gravity: Vec3;
    air?: { density: number };
    primitives?: unknown[];
    stepProps?: unknown[];
    /** Mocap primitives. Rays hit them. They do not push robots. */
    targets?: unknown[];
  };
  run: {
    seed: number;
    /** Seconds. Absent means `DEFAULT_TIMESTEP_S`. */
    timestep?: number;
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

export type LockSnapshot = {
  id: string;
  sha256: string;
  source: LockSource;
  path: string;
};

/** A project's level overlay for a library part. `id` is the part id. */
export type LockOverlay = {
  id: string;
  sha256: string;
  path: string;
};

export type LockFile = {
  format: typeof LOCK_FORMAT;
  world: string;
  parts: LockPart[];
  types: LockType[];
  /** Present when the resolved levels name a snapshot. */
  snapshots?: LockSnapshot[];
  /** Present when a project overlay adds variants to a library part. */
  overlays?: LockOverlay[];
};

/**
 * Variants a project adds to a library part's levels. It never changes a
 * default and never removes a variant. `overlays/<pub>/<name>@<ver>.levels.json`.
 */
export type LevelOverlayFile = {
  format: typeof LEVEL_OVERLAY_FORMAT;
  part: string;
  axes: {
    behaviour?: Record<string, { variants: Record<string, BehaviourImpl> }>;
    body?: Record<string, { variants: Record<string, BodyImpl> }>;
    visual?: Record<string, { variants: Record<string, VisualImpl> }>;
  };
};

/**
 * Every code a diagnostic carries. The list is closed: a new kind of
 * failure adds its code here, and readers key on the code, never on the
 * message text. docs/formats.md § Diagnostic codes says what each means.
 */
export const DIAG_CODES = [
  // A file or its contents.
  "schema",
  "missing-file",
  "mesh-format",
  "bad-params",
  "lock",
  "snapshot",
  "stale-capture",
  "shadowed-part",
  "level-ports",
  // Wiring and ratings.
  "broken-port",
  "wiring",
  "rating",
  // A part that runs at a lower level, or not at all.
  "idle",
  "unpowered",
  "unsupported",
  "no-runtime",
  // The run.
  "timestep-unsupported",
  "battery",
  "envelope",
  "seam-residual-growing",
  "below-16mhz-soa",
  // A chip feature the emulator names and does not emulate.
  "timer4",
  "usb-cdc",
] as const;
export type DiagCode = (typeof DIAG_CODES)[number];

export type Diagnostic = {
  severity: "warning" | "error" | "degraded";
  /** What went wrong. Readers key on this, never on `message`. */
  code: DiagCode;
  path: string;
  port: string;
  quantity: string;
  left: string;
  right: string;
  message: string;
};

/**
 * What a refused edit is made of. A `Diagnostic.message` is these fields
 * worded as `<path> port <port> quantity <quantity>: <detail> (<left> vs
 * <right>)`; the wire and the card read the fields, not that sentence.
 */
export type EditRefusal = {
  path: string;
  port: string;
  quantity: string;
  left: string;
  right: string;
  detail: string;
  /** Set on the refusals whose `detail` is the whole sentence to show. */
  code?: EditRefusalCode;
};

/** A wire joining a port to itself, or ports of two domains. */
export type EditRefusalCode = "wire-self" | "wire-domain";

/** Circuit-to-body cut of a `position-servo@1` servo or a `dc-motor@1` shaft. */
export type SeamKind = "motor";

/**
 * Joules at one engine seam for the run so far. `residual` is
 * `sent − received − declared`.
 */
export type SeamEnergy = {
  path: string;
  kind: SeamKind;
  sent: number;
  received: number;
  declared: number;
  residual: number;
  flagged: boolean;
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
    snapshots?: { id: string; sha256: string; source: LockSource }[];
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
    source: "default" | "type" | "path" | "instance" | "fallback" | "parent";
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
  /**
   * Parts that run idle or at a fallback. Absent when nothing degraded,
   * so a clean report stays byte-identical.
   */
  degraded?: Diagnostic[];
  snapshots: {
    path: string;
    axis: AxisName;
    ref: string;
    quality: string;
    /** Free-run error rows from the snapshot file. Absent when none ran. */
    error?: SnapshotFile["error"];
    /**
     * The line the card shows. Hashes stay in the snapshot file.
     * Absent when the row was not loaded from a snapshot file.
     */
    provenance?: {
      source: SnapshotFile["provenance"]["source"];
      from?: { part: string; level: string; hash?: string };
      fixture?: string;
      tool?: { name: string; version: string };
    };
    /**
     * The snapshot's valid range: its envelope bounds, by `PORT.field`.
     * Absent when the row was not loaded from a snapshot file or states none.
     */
    bounds?: Record<string, Range>;
    /** Envelope warnings for this instance. Absent when the row has none. */
    envelope?: string[];
    /**
     * The capture's `from.hash` no longer matches the part at `from.level`.
     * Absent when the capture is fresh or the hash was not checked.
     */
    stale?: true;
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
  /**
   * Energy at each engine seam. Absent when the run has no seam, so a
   * report without one stays byte-identical.
   */
  seams?: SeamEnergy[];
};

export type SnapshotQuality = "Q0" | "Q1" | "Q2a" | "Q2b" | "Q3";

export type SnapshotFile = {
  format: typeof SNAPSHOT_FORMAT;
  partType: string;
  part: string;
  axis: "behaviour" | "body";
  form: FormId;
  ports: { inputs: string[]; outputs: string[] };
  /**
   * The form's port → the part's port, for a form whose port names are not
   * the part's (a `diode@1` law on a module's `IN` and `GND`).
   */
  bind?: Record<string, string>;
  /**
   * Numbers, port names, and short lists. `across` is two port names.
   * `iSense` is 1 (current into the first port) or -1 (current out of it).
   */
  params: Record<string, number | string | (number | string)[]>;
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
        metric:
          | "static-max-abs"
          | "free-run-max-abs"
          | "free-run-rms"
          | "step-rise";
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
    /** The behaviour variant and board instance a table capture stamped. */
    variant?: string;
    instance?: string;
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
