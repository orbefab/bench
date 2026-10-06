/** The run's plan, built from loadWorldV2 (layered-sim E7, 318b899). */

import {
  type BehaviourImpl,
  type BodyImpl,
  type ChipClock,
  composePose,
  DEFAULT_TIMESTEP_S,
  type DiagCode,
  type Diagnostic,
  isParamRef,
  type LogicRatings,
  type PortDecl,
  type Pose,
  pinIndex,
  ROOT_PATH,
  type RunReport,
  SUPPLY_FORMS,
  stepsPerMs,
  type VisualImpl,
  type VisualParam,
  WORLD_ERROR_CODES,
  type WorldError,
  type WorldErrorCode,
  type WorldPrimitive,
  type WorldStepProp,
  type WorldTarget,
  type WorldViewForm,
  type WorldViewNode,
  type WorldViewTree,
} from "@sfab-bench/contract";
import { collapse } from "@sfab-bench/engine-body";
import type { AvrPinParams } from "@sfab-bench/engine-circuit";
import {
  assetDir,
  type BatteryParams,
  gearTrainErrors,
  type LiveInstance,
  type LiveNet,
  type LoadedSnapshot,
  type LoadResult,
  loadWorldV2,
  makeDiag,
  mergeFormParams,
  pinMapRefused,
  sha256Bytes,
  siValue,
  type Wire,
  type WireEnd,
} from "@sfab-bench/parts";
import {
  noteAccuracy,
  type RunInput,
  recordPathFor,
  runContext,
} from "./accuracy";
import {
  adcHeaderLabels,
  boardGpio,
  boardHostOf,
  boardResetPort,
  chipClock,
  chipExposure,
  chipFactsOf,
  missingChipFacts,
} from "./chip-host";
import {
  type AssignedPart,
  assignNodes,
  type BoardStamp,
  boundPairs,
  type CircuitInst,
  circuitInstOf,
  circuitNumbers,
  connectorPort,
  formGapSentence,
  groundPorts,
  isCircuitForm,
  ldoLaw,
  liveNets,
  railPowerPorts,
  regulatorInputPort,
  stampBoard,
  tableInstOf,
  withWatch,
} from "./circuit-stamp";
import type { PlanEnv, StampEnv } from "./env";
import { formAdapter } from "./forms";
import { provenanceHash } from "./freshness";
import { gpioIndex } from "./gpio-binding";
import type { PlacedRanger, RunRanger } from "./ranger";
import { coupleShafts, type RunControl, type RunShaft } from "./shafts";
import { readTargets } from "./targets";
import { runTree } from "./tree";
import { type PowerWiring, suppliesOnPort } from "./wiring";

/** Shown where a world fails to load, in the UI and in the agent tools. */
export const WORLD_V1_MESSAGE = "World v1 is no longer supported";

const IDENTITY: Pose = {
  position: [0, 0, 0],
  rotation: [1, 0, 0, 0],
};

/**
 * Pin the run's wiring already understands. Taken from the part type's
 * ports, not from the old catalog tables.
 */
export type RunPin = {
  kind: "gpio" | "power" | "ground" | "signal";
  output: boolean;
  digital: boolean;
  pwm: boolean;
  /** The port's input thresholds. A stamped GPIO reads its node against them. */
  logic?: LogicRatings;
};

export type RunMotor = {
  /** V·s/rad. */
  k: number;
  /** Ohms. */
  resistance: number;
  efficiency: number;
  /** Radians of angle error that saturates the drive. */
  eSat: number;
  /** Amperes drawn by the electronics, added to the bridge draw. */
  quiescent: number;
  /** kg·m² on the driven joint. */
  armature: number;
  /** N·m Coulomb friction on the driven joint. */
  frictionloss: number;
  /** N·m·s/rad viscous damping on the driven joint. */
  damping: number;
};

export type RunRobot = {
  id: string;
  /** Path relative to the world file. */
  urdf: string;
  pose: Pose;
};

export type RunBoard = {
  id: string;
  /** Part type id, for example `arduino-uno-r3`. */
  type: string;
  chip: string;
  /** Path relative to the world file. */
  firmware: string;
  source?: string;
  pose: Pose;
  size: [number, number, number];
  /** A `form` visual, drawn inside the box. Absent: a plain box. */
  form?: WorldViewForm;
  pins: Record<string, RunPin>;
  /** Pins a supply may power. On the Uno that is `5V`, not `VIN`. */
  powerInputs: readonly string[];
  /**
   * The supply that powers this board is on `VIN`, and not on the 5V
   * rail. The worker attaches there so the onboard regulator runs.
   */
  vinFeed: boolean;
  voltagePin: string;
  /**
   * The regulator input (`VIN` on the Nano and Uno, `RAW` on the Pro Micro),
   * from `regulatorInputPort`. Null when the board has none.
   */
  regulatorPin: string | null;
  /**
   * The USB connector's power port (`VBUS` on the Nano and Uno), the port
   * the type marks `connector: "usb"`. Null when the board has none.
   */
  usbPin: string | null;
  groundPin: string;
  /** Amperes drawn by the board, independent of voltage. */
  current: number;
  /** The selected variant has a board netlist. */
  hasNetlist: boolean;
  /** Logic port the chip uses as reset. Null when the chip names none. */
  resetPort: string | null;
  /** V_RST / VCC, from the chip part. */
  resetFraction: number;
  /**
   * Exposed GPIO header names, in pin-state order. Empty when this board
   * exposes no chip pin the emulator knows. Internal pins (an onboard
   * LED) are not in this list; they are appended on `driveOrder`.
   */
  pinOrder: readonly string[];
  /**
   * Header names in CPU pin-state order, including internal pins the
   * stamp drives. `pinOrder` is the prefix. Absent when the two match.
   */
  driveOrder?: readonly string[];
  /** Chip pin name for each drive-order entry. Same length, same order. */
  wire: readonly string[];
  /**
   * ADC channel to the header label from this board's expose. Absent on a
   * hand-built plan, which keeps the `A` plus channel-index names.
   */
  adcLabels?: Readonly<Record<number, string>>;
  /**
   * Volts. A running chip above its brownout level and below this is outside
   * its specification. Null when the chip part gives no such band.
   */
  minOperatingVoltage: number | null;
  /** The chip's name and clock for warning text. Null: not in the registry. */
  clock: ChipClock | null;
  /**
   * Circuit parts on this board's nets, including its board netlist.
   * Absent when there are none.
   */
  stamp?: BoardStamp;
  brownoutVoltage: number;
  brownoutAssertVoltage: number;
  brownoutReleaseVoltage: number;
  /** Milliseconds reset stays after the rail releases. From `resetHoldS`. */
  resetHoldMs: number;
  operatingVoltage: number;
  supply: { min: number; max: number };
  /** `avr-pin@1`. High is the board node. The ADC and the Nano D13 stamp use it. */
  pin: AvrPinParams;
};

export type RunLevel = {
  path: string;
  axis: "behaviour" | "body" | "visual";
  class: number | null;
  variant: string | null;
  reason: string;
};

export type RunSupply = {
  id: string;
  /** `usb-a-port` or `bench-supply-cv-cc`. */
  type: string;
  voltage: number;
  currentLimit: number;
  rSeries: number;
  positivePin: string;
  groundPin: string;
  /** Cable family on the positive port. Null is the header. */
  connector: string | null;
  /** `ideal-voltage@1`. The rail stamps a voltage source, not a Thevenin. */
  ideal?: boolean;
  /** Set when this supply is `battery@1`. The rail stamps this, not `voltage`. */
  battery?: BatteryParams;
  /**
   * Circuit parts on this supply when no firmware board feeds it.
   * Absent when a board stamp already holds those parts, or there are none.
   */
  stamp?: BoardStamp;
  pins: Record<string, RunPin>;
};

/**
 * A part visual `{ kind: "box", size }` drawn at the instance pose.
 * A URDF body is not here: those meshes are already the robot. A board
 * is not here either: its box is `RunBoard.size`.
 */
export type RunBox = {
  id: string;
  pose: Pose;
  size: [number, number, number];
  /** A `form` visual, drawn inside the box. Absent: a plain box. */
  form?: WorldViewForm;
  pick: "part" | "supply";
};

export type RunPart = {
  id: string;
  /** Short name the cards and the recording already use, for example `sg90`. */
  model: string;
  /** Part type id, for example `hobby-servo-3wire`. */
  type: string;
  pins: Record<string, RunPin>;
  /**
   * `pin` is the type's one logic input. `gpio` is the board pin on its
   * net (`gpio-binding.ts`); absent when none or more than one is.
   */
  drive: {
    kind: "servo";
    pin: string;
    gpio?: { boardId: string; pin: string };
  };
  supply?: { nominal: number; min: number; max: number };
  torqueNm?: number;
  motor?: RunMotor;
  drives?: { robot: string; joint: string };
  /**
   * Set when the body is a `hinge@1` snapshot. The run checks joint
   * speed and actuator torque against these bounds.
   */
  bodySnapshot?: {
    ref: string;
    bounds: Record<string, [number, number]>;
  };
  /**
   * Set when the behaviour is a snapshot run as its form. The run checks
   * the part's own current and voltage against these bounds.
   */
  behaviourSnapshot?: {
    ref: string;
    bounds: Record<string, [number, number]>;
  };
};

export type { RunControl, RunRanger, RunShaft };

/**
 * What one run executes. Not a file format. Instance ids are the ones
 * written in the scene (`arm`, `uno`, `servo`), so wires stay `uno.D9`.
 */
export type RunPlan = {
  /**
   * Master step, seconds. Absent means the body engine's 1 ms default,
   * so a world that does not name a step stays on that step.
   */
  timestep?: number;
  environment: {
    ground: { plane: boolean };
    /** Metres per second squared. Passed to the MuJoCo model. */
    gravity: [number, number, number];
    primitives?: WorldPrimitive[];
    stepProps?: WorldStepProp[];
    /** Mocap bodies. Empty when the world names none. */
    targets: WorldTarget[];
  };
  robots: RunRobot[];
  boards: RunBoard[];
  supplies: RunSupply[];
  parts: RunPart[];
  /**
   * Circuit and snapshot leaves that sit on the scene, listed with the
   * servos and sensors. Nested board parts stay on the board card.
   */
  leaves?: { id: string; model: string }[];
  /**
   * Visual boxes for parts and supplies. Absent on a hand-built plan.
   * A body that is a URDF is omitted so the robot meshes are not drawn twice.
   */
  boxes?: RunBox[];
  /**
   * Ultrasonic rangers. Absent on a plan built by hand for a pin test.
   * `build` always sets this, possibly empty.
   */
  rangers?: RunRanger[];
  /**
   * A placed form casts rays into the body world (`FormAdapter.rays`).
   * The body model then keeps only targets and static primitives in the
   * ray group. Absent: no form casts.
   */
  rays?: boolean;
  /** Electrical pairs only. Mechanical links are `parts[].drives`. */
  wires: [string, string][];
  /** The scene's own electrical wires as authored, for the cards. */
  shownWires: [string, string][];
  /** Resolved level per instance per axis. Absent on a hand-built plan. */
  levels?: RunLevel[];
  /** Run report from the loader. The worker keeps it and amends envelope warnings. */
  report?: RunReport | null;
  /**
   * The run's context (`runContext` in `accuracy.ts`), the run an assembly
   * check's record names. Present only when the caller asked for it.
   */
  context?: string;
  /**
   * A part whose non-ground nets touch two boards. Stamped once on the
   * island rail, with both boards' node names. Absent when there are none.
   */
  spans?: { part: AssignedPart; boards: string[] }[];
  /** Joints that circuit parts turn or read. Absent when there are none. */
  shafts?: RunShaft[];
  /** `servo-control@1` parts. Absent when there are none. */
  controls?: RunControl[];
  /**
   * Parts that sit idle or fell back. The run still starts. Absent when
   * every part placed.
   */
  degraded?: Diagnostic[];
  /**
   * Instance tree for the view. Absent on a plan built by hand.
   * The run does not read it.
   */
  tree?: WorldViewTree;
};

export type PlanResult =
  | { ok: true; plan: RunPlan }
  | { ok: false; errors: WorldError[] };

function schema(message: string, filePath = ""): WorldError {
  return { code: "schema", path: filePath, message };
}

function fromDiag(diag: Diagnostic): WorldError {
  const code = (WORLD_ERROR_CODES as readonly string[]).includes(diag.code)
    ? (diag.code as WorldErrorCode)
    : "schema";
  return { code, path: diag.path, message: diag.message };
}

function opened(
  project: string,
  worldRel: string,
  env: PlanEnv
): { root: string; abs: string } | { error: string } {
  let root: string;
  try {
    root = env.realpath(env.resolve(project));
  } catch {
    return {
      error: "The project folder is gone. Hint: open the folder again.",
    };
  }
  const rel = worldRel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..") || env.isAbsolute(rel)) {
    return { error: "path escapes the project" };
  }
  const abs = env.resolve(root, rel);
  if (!env.exists(abs)) {
    return {
      error: `World "${worldRel}" does not exist. Hint: the path is relative to the project.`,
    };
  }
  let real: string;
  try {
    real = env.realpath(abs);
  } catch {
    return {
      error: `World "${worldRel}" does not exist. Hint: the path is relative to the project.`,
    };
  }
  const back = env.relative(root, real);
  if (back.startsWith("..") || env.isAbsolute(back)) {
    return { error: "path escapes the project" };
  }
  return { root, abs: real };
}

function worldRelative(
  assetRoot: string,
  worldDir: string,
  file: string,
  env: PlanEnv
): string {
  const abs = env.resolve(assetRoot, file);
  const rel = env.relative(worldDir, abs).split(env.sep).join("/");
  if (!rel || rel.startsWith("..") || env.isAbsolute(rel)) {
    return file.split(env.sep).join("/");
  }
  return rel;
}

function shortName(partId: string): string {
  const slash = partId.lastIndexOf("/");
  const at = partId.indexOf("@");
  const name = partId.slice(slash + 1, at === -1 ? undefined : at);
  return name || partId;
}

function pinOf(decl: PortDecl): RunPin | null {
  if (decl.domain !== "electrical") return null;
  if (decl.role === "ground") {
    return { kind: "ground", output: false, digital: false, pwm: false };
  }
  if (decl.role === "power") {
    return {
      kind: "power",
      output: decl.direction === "out",
      digital: false,
      pwm: false,
    };
  }
  if (decl.role === "logic" && decl.direction === "inout") {
    const logic = decl.ratings?.logic;
    return {
      kind: "gpio",
      output: true,
      digital: true,
      pwm: decl.pwm === true,
      ...(logic ? { logic } : {}),
    };
  }
  if (decl.role === "logic" && decl.direction === "in") {
    return { kind: "signal", output: false, digital: false, pwm: false };
  }
  return { kind: "signal", output: false, digital: false, pwm: false };
}

/** Electrical logic inputs of a type, in port order. */
function logicInputs(ports: Record<string, PortDecl>): string[] {
  return Object.entries(ports)
    .filter(
      ([, port]) =>
        port.domain === "electrical" &&
        port.role === "logic" &&
        port.direction === "in"
    )
    .map(([name]) => name);
}

function pinsOf(ports: Record<string, PortDecl>): Record<string, RunPin> {
  const pins: Record<string, RunPin> = {};
  for (const [name, decl] of Object.entries(ports)) {
    if (decl.internal) continue;
    const pin = pinOf(decl);
    if (pin) pins[name] = pin;
  }
  return pins;
}

function formNumbers(inst: LiveInstance): Record<string, number> | null {
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (!behaviour || behaviour.kind !== "form") return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(
    mergeFormParams(behaviour.params, inst.params)
  )) {
    out[key] = siValue(value);
  }
  return out;
}

/**
 * A lumped servo wired to another part's URDF still gets this box: the
 * robot meshes belong to that other part. When this part's own body is
 * a URDF, the meshes are already drawn, so the visual box is skipped.
 * A placeholder mesh uses the nearest lower class whose visual is a box.
 * A mesh file is left undrawn.
 */
function pushBox(
  boxes: RunBox[],
  inst: LiveInstance,
  pose: Pose,
  pick: RunBox["pick"]
) {
  const drawn = drawnBox(inst);
  if (!drawn) return;
  boxes.push({
    id: inst.path,
    pose,
    size: drawn.size,
    ...(drawn.form ? { form: drawn.form } : {}),
    pick,
  });
  if (drawn.fallbackClass !== null) {
    inst.axes.visual.reason = `placeholder mesh; drawn as the class-${drawn.fallbackClass} box`;
  }
}

/**
 * The box a `box` or `form` visual fills, and the form with its params
 * resolved: a `$param` reads the instance's param, then the selected
 * behaviour form's (a resistor's `R`). Null for any other visual.
 */
function visualBox(
  inst: LiveInstance,
  visual: VisualImpl | null
): { size: [number, number, number]; form?: WorldViewForm } | null {
  if (visual?.kind !== "box" && visual?.kind !== "form") return null;
  if (!finiteSize(visual.size)) return null;
  const size: [number, number, number] = [
    visual.size[0],
    visual.size[1],
    visual.size[2],
  ];
  if (visual.kind === "box") return { size };
  const numbers = formNumbers(inst);
  const resolveParams = (
    raw: Record<string, VisualParam> | undefined
  ): WorldViewForm["params"] => {
    const params: WorldViewForm["params"] = {};
    for (const [name, value] of Object.entries(raw ?? {})) {
      const read = isParamRef(value)
        ? (inst.params[value.$param] ?? numbers?.[value.$param])
        : value;
      if (read !== undefined) params[name] = read;
    }
    return params;
  };
  const inner = (visual.inner ?? [])
    .filter((row) => finiteSize(row.size) && finiteSize(row.at))
    .map((row) => ({
      form: row.form,
      size: [row.size[0], row.size[1], row.size[2]] as [number, number, number],
      at: [row.at[0], row.at[1], row.at[2]] as [number, number, number],
      params: resolveParams(row.params),
    }));
  return {
    size,
    form: {
      form: visual.form,
      params: resolveParams(visual.params),
      ...(inner.length > 0 ? { inner } : {}),
    },
  };
}

function finiteSize(size: readonly number[]): boolean {
  return (
    size.length >= 3 &&
    size.slice(0, 3).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * The box this part draws. A resolved box is itself. A placeholder mesh
 * is the nearest lower class that is a box. Anything else, including a
 * mesh file and a URDF body, draws nothing.
 */
function drawnBox(inst: LiveInstance): {
  size: [number, number, number];
  form?: WorldViewForm;
  fallbackClass: number | null;
} | null {
  const body = inst.axes.body.impl as BodyImpl | null;
  if (body?.kind === "urdf") return null;
  const visual = inst.axes.visual.impl as VisualImpl | null;
  const own = visualBox(inst, visual);
  if (own) return { ...own, fallbackClass: null };
  if (visual?.kind !== "mesh" || visual.placeholder !== true) return null;
  const resolved = inst.axes.visual.class;
  if (resolved === null) return null;
  const map = inst.part.axes?.visual;
  for (let cls = resolved - 1; cls >= 0; cls--) {
    const slot = map?.[String(cls) as "0"];
    if (!slot) continue;
    const variant = slot.variants[slot.default];
    if (variant?.kind !== "box" || !finiteSize(variant.size)) continue;
    return {
      size: [variant.size[0], variant.size[1], variant.size[2]],
      fallbackClass: cls,
    };
  }
  return null;
}

/** Copy a placeholder draw note onto the report. The plan reads the axis. */
function notePlaceholderBoxes(loaded: LoadResult): void {
  for (const inst of loaded.resolved) {
    const reason = inst.axes.visual.reason;
    if (!reason.startsWith("placeholder mesh;")) continue;
    const row = loaded.report?.levels.find(
      (item) => item.path === inst.path && item.axis === "visual"
    );
    if (row) row.reason = reason;
  }
}

/**
 * Each instance's pose in the document frame: its own pose taken through
 * every posed group above it, so an assembly placed with a pose carries
 * its parts. The world root is placed once and the editor may move it,
 * so its pose places nothing.
 */
function scenePoses(resolved: LiveInstance[]): Map<string, Pose> {
  const byPath = new Map(resolved.map((inst) => [inst.path, inst]));
  const poses = new Map<string, Pose>();
  const at = (path: string): Pose => {
    const done = poses.get(path);
    if (done) return done;
    const own = byPath.get(path)?.pose ?? IDENTITY;
    const cut = path.lastIndexOf(".");
    const local: Pose = {
      position: [...own.position] as Pose["position"],
      rotation: [...own.rotation] as Pose["rotation"],
    };
    const pose =
      path === ROOT_PATH
        ? IDENTITY
        : cut < 0
          ? local
          : composePose(at(path.slice(0, cut)), local);
    poses.set(path, pose);
    return pose;
  };
  for (const inst of resolved) at(inst.path);
  return poses;
}

function cannot(
  inst: LiveInstance,
  detail: string,
  code: DiagCode = "idle"
): Diagnostic {
  const named =
    inst.path === ROOT_PATH
      ? `${shortName(inst.part.id)} sits idle: ${detail}`
      : detail;
  return {
    severity: "degraded",
    code,
    path: inst.path,
    port: "behaviour",
    quantity: "Level",
    left: inst.axes.behaviour.label,
    right: "runnable",
    message: `${inst.path} port behaviour quantity Level: ${named} (${inst.axes.behaviour.label} vs runnable)`,
  };
}

function degrade(diag: Diagnostic): Diagnostic {
  return { ...diag, severity: "degraded" };
}

/** The sentence a person reads. The report's port, quantity, and comparison stay on the fields. */
function humanText(message: string): string {
  const hit =
    /^(?:.* )?port .+? quantity .+?: (.*) \([^()\n]* vs [^()\n]*\)$/.exec(
      message
    );
  return hit?.[1] ?? message;
}

function present(diag: Diagnostic): Diagnostic {
  const next = diag.severity === "degraded" ? diag : degrade(diag);
  const message = humanText(next.message);
  return message === next.message ? next : { ...next, message };
}

function electricalWires(nets: LiveNet[]): [string, string][] {
  const wires: [string, string][] = [];
  for (const net of nets) {
    if (net.domain !== "electrical" || net.ports.length < 2) continue;
    const first = net.ports[0];
    if (!first) continue;
    for (let i = 1; i < net.ports.length; i++) {
      const other = net.ports[i];
      if (!other) continue;
      wires.push([
        `${first.path}.${first.port}`,
        `${other.path}.${other.port}`,
      ]);
    }
  }
  return wires;
}

function authoredWires(nets: LiveNet[], wires: Wire[]): [string, string][] {
  const electrical = new Set<string>();
  for (const net of nets) {
    if (net.domain !== "electrical") continue;
    for (const port of net.ports) electrical.add(`${port.path}.${port.port}`);
  }
  const shown = (end: WireEnd) =>
    !end.path.includes(".") && electrical.has(end.full);
  return wires
    .filter((wire) => shown(wire.a) && shown(wire.b))
    .map((wire) => [wire.a.full, wire.b.full]);
}

function drivesFor(
  inst: LiveInstance,
  nets: LiveNet[],
  instances: LiveInstance[]
): { robot: string; joint: string } | undefined {
  for (const net of nets) {
    if (net.domain !== "rotational") continue;
    const shaft = net.ports.find(
      (port) => port.path === inst.path && port.port === "shaft"
    );
    if (!shaft) continue;
    const joint = net.ports.find((port) => port.path !== inst.path);
    if (!joint) continue;
    const robot = instances.find((item) => item.path === joint.path);
    if (!robot) continue;
    const robotBody = robot.axes.body.impl as BodyImpl | null;
    if (robotBody?.kind !== "urdf") continue;
    return { robot: robot.path, joint: joint.port };
  }
  return undefined;
}

function rangePair(
  range: readonly [unknown, unknown] | undefined
): [number, number] | null {
  if (!range) return null;
  const low = range[0];
  const high = range[1];
  if (typeof low === "number" && typeof high === "number") return [low, high];
  if (
    low &&
    high &&
    typeof low === "object" &&
    typeof high === "object" &&
    "v" in low &&
    "v" in high &&
    typeof low.v === "number" &&
    typeof high.v === "number"
  ) {
    return [low.v, high.v];
  }
  return null;
}

/** A logic port left unbound: its net reaches more than one board pin. */
function unbound(inst: LiveInstance, port: string, detail: string): Diagnostic {
  return {
    severity: "degraded",
    code: "wiring",
    path: inst.path,
    port,
    quantity: "Net",
    left: "several board pins",
    right: "one",
    message: `${inst.path} port ${port} quantity Net: ${detail} (several board pins vs one)`,
  };
}

function supplyGround(
  board: RunBoard,
  supplies: RunSupply[],
  nets: LiveNet[]
): string {
  const net = nets.find((item) =>
    item.ports.some(
      (port) => port.path === board.id && port.port === board.voltagePin
    )
  );
  if (net) {
    for (const supply of supplies) {
      const hit = net.ports.some(
        (port) => port.path === supply.id && port.port === supply.positivePin
      );
      if (!hit) continue;
      return `${supply.id}.${supply.groundPin}`;
    }
  }
  return `${board.id}.${board.groundPin}`;
}

/**
 * The power input the supply is wired to, when that port's rating holds
 * the chip rail. `VIN` is 7–12 V, so it is not a 5 V rail. With nothing
 * wired, the matching port is still the input (today, `5V`).
 */
function chosenPowerPort(
  inst: LiveInstance,
  loaded: LoadResult,
  railVoltage: number
): string | null {
  const candidates = railPowerPorts(inst.type.ports, railVoltage);
  for (const name of candidates) {
    const net = loaded.nets.find((item) =>
      item.ports.some((port) => port.path === inst.path && port.port === name)
    );
    if (!net) continue;
    const fed = net.ports.some((port) => {
      if (port.path === inst.path) return false;
      const other = loaded.resolved.find((item) => item.path === port.path);
      const behaviour = other ? selectedBehaviour(other) : null;
      return (
        behaviour?.kind === "form" &&
        (SUPPLY_FORMS as readonly string[]).includes(behaviour.form)
      );
    });
    if (fed) return name;
  }
  return candidates[0] ?? null;
}

type JointTerms = {
  armature: number;
  damping: number;
  frictionloss: number;
  bodySnapshot?: RunPart["bodySnapshot"];
};

/** Lumped joint, hinge@1 snapshot, or the rigid collapse of a gear train. */
function jointOf(inst: LiveInstance, loaded: LoadResult): JointTerms | null {
  const body = inst.axes.body.impl as BodyImpl | null;
  if (!body) return null;
  if (body.kind === "lumped" && body.joint) {
    return {
      armature: body.joint.armature ?? 0,
      damping: body.joint.damping ?? 0,
      frictionloss: body.joint.frictionloss ?? 0,
    };
  }
  if (body.kind === "gear-train") {
    if (gearTrainErrors(inst.part.id, body).length > 0) return null;
    const lumped = collapse(body);
    return {
      armature: lumped.armature,
      damping: lumped.damping,
      frictionloss: lumped.frictionloss,
    };
  }
  if (body.kind !== "snapshot") return null;
  const found = loaded.snapshots.find((row) => row.id === body.ref);
  const ran = loaded.snapshotRuns.some(
    (row) =>
      row.path === inst.path && row.axis === "body" && row.ref === body.ref
  );
  if (!found || !ran || found.file.form !== "hinge@1") return null;
  const armature = numberParam(found.file.params.armature);
  const damping = numberParam(found.file.params.damping);
  const frictionloss = numberParam(found.file.params.frictionloss);
  if (armature === null || damping === null || frictionloss === null) {
    return null;
  }
  return {
    armature,
    damping,
    frictionloss,
    bodySnapshot: {
      ref: body.ref,
      bounds: boundPairs(found.file.envelope.bounds),
    },
  };
}

function numberParam(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The behaviour snapshot file an instance runs, when the load ran one. */
function behaviourSnapshotFile(
  inst: LiveInstance,
  loaded: LoadResult
): LoadedSnapshot | undefined {
  const ran = loaded.snapshotRuns.find(
    (row) => row.path === inst.path && row.axis === "behaviour"
  );
  return ran ? loaded.snapshots.find((row) => row.id === ran.ref) : undefined;
}

/** The behaviour snapshot an instance runs as its form, with its bounds. */
function behaviourSnapshotOf(
  inst: LiveInstance,
  loaded: LoadResult
): Pick<RunPart, "behaviourSnapshot"> {
  const found = behaviourSnapshotFile(inst, loaded);
  if (!found) return {};
  return {
    behaviourSnapshot: {
      ref: found.id,
      bounds: boundPairs(found.file.envelope.bounds),
    },
  };
}

function selectedBehaviour(inst: LiveInstance): BehaviourImpl | null {
  const behaviour = inst.axes.behaviour.impl;
  if (!behaviour || typeof behaviour !== "object") return null;
  return behaviour as BehaviourImpl;
}

/** Why a leaf cannot run. The path is already on the diagnostic. */
function runtimeGap(inst: LiveInstance): string {
  if (inst.declaredOnly) return "no runtime for a declared-only part";
  const behaviour = selectedBehaviour(inst);
  if (!behaviour) return "no runtime";
  if (behaviour.kind === "form") {
    return formGapSentence(inst) ?? `no runtime for form ${behaviour.form}`;
  }
  return `no runtime for ${behaviour.kind}`;
}

/** Ports on a ground net. A shared ground does not make a board an owner. */
function groundFulls(
  nets: { ports: { full: string; path: string; port: string }[] }[],
  boards: RunBoard[],
  supplies: RunSupply[]
): Set<string> {
  const isGround = (path: string, port: string) => {
    for (const board of boards) {
      if (
        (path === board.id || path.startsWith(`${board.id}.`)) &&
        port === board.groundPin
      ) {
        return true;
      }
    }
    return supplies.some(
      (supply) => supply.id === path && port === supply.groundPin
    );
  };
  const full = new Set<string>();
  for (const net of nets) {
    if (!net.ports.some((port) => isGround(port.path, port.port))) continue;
    for (const port of net.ports) full.add(port.full);
  }
  return full;
}

function suppliesReached(
  part: CircuitInst,
  supplies: RunSupply[],
  nets: { ports: { full: string; path: string; port: string }[] }[]
): string[] {
  const fulls = new Set(Object.values(part.ports));
  const ids = new Set<string>();
  for (const net of nets) {
    if (!net.ports.some((port) => fulls.has(port.full))) continue;
    for (const supply of supplies) {
      const hit = net.ports.some(
        (port) =>
          port.path === supply.id &&
          (port.port === supply.positivePin || port.port === supply.groundPin)
      );
      if (hit) ids.add(supply.id);
    }
  }
  return [...ids].sort();
}

/** A supply with circuit parts and no firmware board. Ground is `"0"`. */
function stampSupply(
  supply: RunSupply,
  parts: readonly CircuitInst[],
  nets: Parameters<typeof stampBoard>[0]["nets"]
): BoardStamp | null {
  const ports: Record<string, PortDecl> = {
    [supply.positivePin]: {
      domain: "electrical",
      role: "power",
      direction: "out",
    },
    [supply.groundPin]: {
      domain: "electrical",
      role: "ground",
      direction: "passive",
    },
  };
  return stampBoard({
    boardId: supply.id,
    netlist: false,
    ports,
    supplyGround: `${supply.id}.${supply.groundPin}`,
    powerPort: supply.positivePin,
    resetPort: null,
    usbPort: null,
    regulatorPort: null,
    resetFraction: null,
    parts,
    nets,
  });
}

function build(
  loaded: LoadResult,
  assetRoot: string,
  worldDir: string,
  env: PlanEnv
): { plan: RunPlan | null; diags: Diagnostic[] } {
  const run = loaded.run;
  if (!run) return { plan: null, diags: loaded.diagnostics };
  const diags: Diagnostic[] = [];
  const robots: RunRobot[] = [];
  const boards: RunBoard[] = [];
  const supplies: RunSupply[] = [];
  const parts: RunPart[] = [];
  const leaves: { id: string; model: string }[] = [];
  const placedRangers: PlacedRanger[] = [];
  // A placed form that casts rays into the body world.
  let rays = false;
  const boxes: RunBox[] = [];
  const circuits: CircuitInst[] = [];
  const trainParts: LiveInstance[] = [];

  // An if-chain on the selected behaviour. A composite is a shell and
  // is skipped. What runs: firmware; form resistor@1, capacitor@1,
  // diode@1 and led@1; form multibody@1 with a urdf body; form thevenin-limit@1;
  // form position-servo@1 on a type with one logic input, with a lumped
  // joint, a hinge@1 snapshot, or the collapse of a gear train; forms
  // dc-motor@1, servo-control@1 and potentiometer@1, coupled to a joint
  // after the loop; a gear-train body with no behaviour, the collapse a
  // motor reaches through it; a form whose adapter places it (the
  // supplies, ranger@1). Anything else is a plan error that names the path.
  const byPath = new Map(loaded.resolved.map((item) => [item.path, item]));
  const scene = scenePoses(loaded.resolved);
  const poseOf = (inst: LiveInstance): Pose => scene.get(inst.path) ?? IDENTITY;
  for (const inst of loaded.resolved) {
    // A composite root is a shell. A leaf opened as the root is the
    // instance: its body is planned, or it sits idle with a diagnostic.
    if (
      inst.path === ROOT_PATH &&
      selectedBehaviour(inst)?.kind === "composite"
    ) {
      continue;
    }
    const behaviour = selectedBehaviour(inst);
    if (behaviour?.kind === "composite") continue;
    const circuit = circuitInstOf(inst);
    if (circuit) {
      circuits.push(withWatch(circuit, behaviourSnapshotFile(inst, loaded)));
      if (!inst.path.includes(".")) {
        leaves.push({ id: inst.path, model: shortName(inst.part.id) });
      }
      if (inst.pose) pushBox(boxes, inst, poseOf(inst), "part");
      continue;
    }
    const typeId = inst.type.id;
    const bodyImpl = inst.axes.body.impl as BodyImpl | null;
    if (behaviour?.kind === "form" && behaviour.form === "multibody@1") {
      if (bodyImpl?.kind !== "urdf") {
        diags.push(cannot(inst, "the run needs a URDF body"));
        continue;
      }
      const override = inst.params.urdf;
      const file = typeof override === "string" ? override : bodyImpl.file;
      if (!file) {
        diags.push(cannot(inst, "the run needs a URDF body"));
        continue;
      }
      robots.push({
        id: inst.path,
        urdf: worldRelative(assetRoot, worldDir, file, env),
        pose: poseOf(inst),
      });
      continue;
    }
    if (behaviour?.kind === "firmware") {
      // `inst` is the chip that holds the image. `host` is the board it runs
      // as: the parent composite when this chip is a child of one, else itself.
      const host = boardHostOf(inst, byPath, ROOT_PATH);
      // A board whose pin map the lint refused does not run as a bare chip.
      // The loader idles such a part below the root, its row on the
      // instance path; this is the root, the same row on the root path.
      const refused =
        host === inst
          ? pinMapRefused(loaded.diagnostics, inst.part)
          : undefined;
      if (refused) {
        diags.push(degrade({ ...refused, path: host.path }));
        continue;
      }
      const exposure = chipExposure(inst, host);
      // One board per host: a second chip exposed by the same parent does not
      // run, and the first one does.
      if (boards.some((board) => board.id === host.path)) {
        diags.push(
          cannot(
            host,
            `more than one firmware chip runs as this board (${inst.path} does not run)`
          )
        );
        continue;
      }
      const facts = chipFactsOf(behaviour);
      if (!facts) {
        const missing = missingChipFacts(behaviour).join(", ");
        diags.push(
          cannot(
            host,
            `chip "${behaviour.chip}" lacks ${missing}`,
            "unsupported"
          )
        );
        continue;
      }
      const params = behaviour.params ?? {};
      const image = behaviour.imageParam
        ? inst.params[behaviour.imageParam]
        : undefined;
      if (typeof image !== "string") {
        diags.push(
          cannot(host, "the board has no firmware image", "missing-file")
        );
        continue;
      }
      const drawn = visualBox(host, host.axes.visual.impl as VisualImpl | null);
      const size = drawn?.size ?? ([0, 0, 0] as [number, number, number]);
      const powerName = chosenPowerPort(host, loaded, facts.railVoltage);
      if (!powerName) {
        diags.push(cannot(host, "the board has no power input"));
        continue;
      }
      const groundName = groundPorts(host.type.ports)[0];
      if (!groundName) {
        diags.push(cannot(host, "the board has no ground port"));
        continue;
      }
      const rail = rangePair(host.type.ports[powerName]?.ratings?.voltage) ?? [
        facts.railVoltage,
        facts.railVoltage,
      ];
      const source = inst.params.source;
      const gpio = boardGpio(behaviour.chip, inst, host);
      const internalPin = (name: string) =>
        host.type.ports[name]?.internal === true;
      const header = gpio.filter((pin) => !internalPin(pin.name));
      const driven = [
        ...header,
        ...gpio.filter((pin) => internalPin(pin.name)),
      ];
      // The board's own load rides on the chip instance: it counts the parts
      // the chip part does not carry (the USB bridge, the power LED).
      const quiescent =
        typeof inst.params.quiescent === "number"
          ? inst.params.quiescent
          : params.quiescent;
      boards.push({
        id: host.path,
        type: host.type.id,
        chip: behaviour.chip,
        firmware: worldRelative(assetRoot, worldDir, image, env),
        ...(typeof source === "string"
          ? { source: worldRelative(assetRoot, worldDir, source, env) }
          : {}),
        pose: poseOf(host),
        size,
        ...(drawn?.form ? { form: drawn.form } : {}),
        pins: pinsOf(host.type.ports),
        powerInputs: [powerName],
        vinFeed: false,
        voltagePin: powerName,
        regulatorPin: regulatorInputPort(host.type.ports, [powerName]),
        usbPin: connectorPort(host.type.ports, "usb"),
        groundPin: groundName,
        current: quiescent ?? 0,
        hasNetlist: host.path !== inst.path,
        resetPort: boardResetPort(behaviour.resetPort, inst, host, exposure),
        resetFraction: facts.resetFraction,
        pinOrder: header.map((pin) => pin.name),
        ...(driven.length === header.length
          ? {}
          : { driveOrder: driven.map((pin) => pin.name) }),
        wire: driven.map((pin) => pin.chip),
        adcLabels: adcHeaderLabels(behaviour.chip, exposure),
        minOperatingVoltage: facts.minOperatingVoltage,
        clock: chipClock(behaviour.chip),
        brownoutVoltage: facts.brownoutVoltage,
        brownoutAssertVoltage: facts.brownoutAssertVoltage,
        brownoutReleaseVoltage: facts.brownoutReleaseVoltage,
        resetHoldMs: Math.round(facts.resetHoldS * 1000),
        operatingVoltage: rail[0],
        supply: { min: rail[0], max: rail[1] },
        pin: facts.pin,
      });
      continue;
    }
    const adapter =
      behaviour?.kind === "form" ? formAdapter(behaviour.form) : undefined;
    if (adapter?.place && behaviour?.kind === "form") {
      if (adapter.rays) rays = true;
      adapter.place({
        inst,
        behaviour,
        typeId,
        model: shortName(inst.part.id),
        numbers: () => formNumbers(inst),
        pins: () => pinsOf(inst.type.ports),
        pose: () => poseOf(inst),
        reject: (detail, code = "bad-params") => {
          diags.push(cannot(inst, detail, code));
        },
        addSupply: (supply) => {
          supplies.push(supply);
        },
        addRanger: (ranger) => {
          placedRangers.push(ranger);
        },
        box: (pick) => {
          pushBox(boxes, inst, poseOf(inst), pick);
        },
      });
      continue;
    }
    if (behaviour?.kind === "form" && behaviour.form === "position-servo@1") {
      const numbers = formNumbers(inst);
      const hinge = jointOf(inst, loaded);
      if (!numbers || !hinge) {
        diags.push(
          cannot(
            inst,
            "the run needs position-servo@1 and a lumped joint or a hinge"
          )
        );
        continue;
      }
      // The whole servo as one law: its control loop reads the type's one
      // logic input. A bare winding is `dc-motor@1`, driven by its nets.
      const [signal, ...extra] = logicInputs(inst.type.ports);
      if (!signal || extra.length > 0) {
        diags.push(
          cannot(
            inst,
            signal
              ? `position-servo@1 reads one pulse, and this type has ${extra.length + 1} logic inputs`
              : "position-servo@1 reads one pulse, and this type has no logic input for it"
          )
        );
        continue;
      }
      const torque = rangePair(inst.part.ratings?.shaft?.torque);
      const supply = rangePair(inst.part.ratings?.["V+"]?.voltage);
      const drives = drivesFor(inst, loaded.nets, loaded.resolved);
      parts.push({
        id: inst.path,
        model: shortName(inst.part.id),
        type: typeId,
        pins: pinsOf(inst.type.ports),
        drive: { kind: "servo", pin: signal },
        ...(supply
          ? {
              supply: {
                nominal: supply[0],
                min: supply[0],
                max: supply[1],
              },
            }
          : {}),
        ...(torque ? { torqueNm: torque[1] } : {}),
        motor: {
          k: numbers.K ?? 0,
          resistance: numbers.R ?? 0,
          efficiency: numbers.efficiency ?? 0,
          eSat: numbers.eSat ?? 0,
          quiescent: numbers.quiescent ?? 0,
          armature: hinge.armature,
          frictionloss: hinge.frictionloss,
          damping: hinge.damping,
        },
        ...(hinge.bodySnapshot ? { bodySnapshot: hinge.bodySnapshot } : {}),
        ...behaviourSnapshotOf(inst, loaded),
        ...(drives ? { drives } : {}),
      });
      pushBox(boxes, inst, poseOf(inst), "part");
      continue;
    }
    if (behaviour?.kind === "snapshot") {
      const found = behaviourSnapshotFile(inst, loaded);
      if (!found) {
        // The load's own row (missing, unreadable, refused by the lint)
        // is on this instance already and says why it idles.
        if (!loaded.diagnostics.some((diag) => diag.path === inst.path)) {
          diags.push(cannot(inst, `snapshot ${behaviour.ref} did not load`));
        }
        continue;
      }
      const table = tableInstOf(inst, found);
      if (typeof table === "string") {
        diags.push(cannot(inst, table));
        continue;
      }
      circuits.push(table);
      if (!inst.path.includes(".")) {
        leaves.push({ id: inst.path, model: shortName(inst.part.id) });
      }
      if (inst.pose) pushBox(boxes, inst, poseOf(inst), "part");
      continue;
    }
    if (bodyImpl?.kind === "gear-train" && !behaviour) {
      // Runs as the collapse of the joint a motor reaches through it.
      trainParts.push(inst);
      continue;
    }
    diags.push(cannot(inst, runtimeGap(inst), "no-runtime"));
  }

  // Every board is planned: bind each consumer's logic port to the board
  // pin on its resolved net.
  const gpio = gpioIndex(loaded.nets, boards);
  const bindPort = (path: string, port: string | null) => {
    if (port === null) return null;
    const reach = gpio(path, port);
    const inst = byPath.get(path);
    if (reach.detail && inst) diags.push(unbound(inst, port, reach.detail));
    return reach.pin;
  };
  const rangers: RunRanger[] = placedRangers.map((ranger) => {
    const trig = bindPort(ranger.id, ranger.ports.trig);
    const echo = bindPort(ranger.id, ranger.ports.echo);
    return {
      ...ranger,
      trig: trig ? { boardId: trig.boardId, bit: trig.bit } : null,
      echo: echo ? { boardId: echo.boardId, bit: echo.bit } : null,
    };
  });
  for (const part of parts) {
    const pin = bindPort(part.id, part.drive.pin);
    if (pin) part.drive.gpio = { boardId: pin.boardId, pin: pin.pin };
  }

  const coupled = coupleShafts({
    circuits,
    resolved: loaded.resolved,
    nets: loaded.nets,
    gpio: bindPort,
    drivenJoints: new Set(
      parts.flatMap((part) =>
        part.drives ? [`${part.drives.robot}/${part.drives.joint}`] : []
      )
    ),
  });
  for (const row of coupled.idle) {
    const inst = byPath.get(row.path);
    if (inst) diags.push(cannot(inst, row.detail, "wiring"));
  }
  const idleShafts = new Set(coupled.idle.map((row) => row.path));
  for (let i = circuits.length - 1; i >= 0; i--) {
    if (idleShafts.has(circuits[i]?.path ?? "")) circuits.splice(i, 1);
  }
  for (const inst of trainParts) {
    if (coupled.trains.has(inst.path)) continue;
    diags.push(
      cannot(inst, "the gear train couples no motor to a joint", "wiring")
    );
  }

  const nets = liveNets(loaded.nets);
  const crowded = new Set<string>();
  const loose = new Map<string, CircuitInst[]>();
  const ground = groundFulls(nets, boards, supplies);
  const spans: { part: AssignedPart; boards: string[] }[] = [];
  const ownersOf = (part: CircuitInst): RunBoard[] => {
    const nested = boards.filter(
      (board) => part.path === board.id || part.path.startsWith(`${board.id}.`)
    );
    if (nested.length > 0) return nested;
    const found = new Set<string>();
    for (const full of Object.values(part.ports)) {
      if (ground.has(full)) continue;
      const net = nets.find((item) =>
        item.ports.some((port) => port.full === full)
      );
      if (!net) continue;
      for (const port of net.ports) {
        const board = boards.find(
          (item) => port.path === item.id || port.path.startsWith(`${item.id}.`)
        );
        if (board) found.add(board.id);
      }
    }
    return boards.filter((board) => found.has(board.id));
  };
  // A part whose nets reach no board and no supply (a winding between a
  // bridge's outputs) takes the home of the circuit parts it shares a
  // non-ground net with.
  const homes = new Map(
    circuits.map((part) => [
      part.path,
      {
        hit: ownersOf(part),
        reached: suppliesReached(part, supplies, nets),
      },
    ])
  );
  const netsOf = (part: CircuitInst): Set<string> => {
    const ids = new Set<string>();
    for (const full of Object.values(part.ports)) {
      if (ground.has(full)) continue;
      const net = nets.find((item) =>
        item.ports.some((port) => port.full === full)
      );
      if (net) ids.add(net.ports.map((port) => port.full).sort()[0] ?? full);
    }
    return ids;
  };
  const homeless = (path: string) => {
    const home = homes.get(path);
    return !home || (home.hit.length === 0 && home.reached.length === 0);
  };
  // Homed through a neighbour, so it touches no board: the board takes it
  // as an extra part.
  const inherited = new Set<string>();
  for (const part of circuits) {
    if (!homeless(part.path)) continue;
    const seen = new Set([part.path]);
    const queue = [part];
    let found: { hit: RunBoard[]; reached: string[] } | null = null;
    while (queue.length > 0 && !found) {
      const at = queue.shift();
      if (!at) break;
      const mine = netsOf(at);
      for (const other of circuits) {
        if (seen.has(other.path)) continue;
        if (![...netsOf(other)].some((id) => mine.has(id))) continue;
        seen.add(other.path);
        if (!homeless(other.path)) {
          found = homes.get(other.path) ?? null;
          break;
        }
        queue.push(other);
      }
    }
    if (found) {
      homes.set(part.path, found);
      inherited.add(part.path);
    }
  }
  const owners = new Map<string, RunBoard[]>();
  for (const part of circuits) {
    const hit = homes.get(part.path)?.hit ?? [];
    owners.set(part.path, hit);
    if (hit.length >= 2) {
      spans.push({
        part: assignNodes(part, nets, ground),
        boards: hit.map((board) => board.id),
      });
      continue;
    }
    const reached = homes.get(part.path)?.reached ?? [];
    if (reached.length >= 2) {
      if (hit.length >= 1) continue;
      const homeSupply = reached[0];
      if (!homeSupply) continue;
      const list = loose.get(homeSupply) ?? [];
      list.push(part);
      loose.set(homeSupply, list);
      continue;
    }
    if (reached.length === 0 && hit.length === 0) {
      crowded.add(part.path);
      diags.push({
        severity: "degraded",
        code: "unpowered",
        path: part.path,
        port: "nets",
        quantity: "Part",
        left: part.path,
        right: "a supply",
        message: `${part.path} reaches no supply`,
      });
      continue;
    }
    if (hit.length === 0 && reached[0]) {
      const list = loose.get(reached[0]) ?? [];
      list.push(part);
      loose.set(reached[0], list);
    }
  }
  const wiring: PowerWiring = {
    boards,
    parts,
    rangers,
    supplies,
    wires: electricalWires(loaded.nets),
  };
  const supplyOnPort = (board: RunBoard, port: string): string | null =>
    suppliesOnPort(wiring, board.id, port)[0] ?? null;
  for (const board of boards) {
    const onRail = supplyOnPort(board, board.voltagePin);
    const onVin = board.regulatorPin
      ? supplyOnPort(board, board.regulatorPin)
      : null;
    // The regulator input (VIN, or the Pro Micro's RAW) feeds the regulator.
    // Parts on the regulated port take this supply in the feed walk; their
    // load sits on the regulated node.
    board.vinFeed = onRail === null && onVin !== null;
  }
  const boardsOn = new Map<string, RunBoard[]>();
  for (const board of boards) {
    const supplyId =
      supplyOnPort(board, board.voltagePin) ??
      (board.regulatorPin ? supplyOnPort(board, board.regulatorPin) : null);
    if (!supplyId) continue;
    const list = boardsOn.get(supplyId) ?? [];
    list.push(board);
    boardsOn.set(supplyId, list);
  }
  const stampParts = circuits.filter((part) => !crowded.has(part.path));
  const alsoByBoard = new Map<string, CircuitInst[]>();
  for (const supply of supplies) {
    const group = boardsOn.get(supply.id) ?? [];
    const mine = loose.get(supply.id) ?? [];
    if (mine.length === 0) continue;
    if (group.length === 1) {
      const only = group[0];
      if (only) alsoByBoard.set(only.id, mine);
      continue;
    }
    // A part that reaches no board still joins one stamp. Several boards
    // on this supply share the rail, so the lex-first board holds it.
    // A pair with no netlist and no snapshot still stamps them on the
    // supply, as a v1 draft does.
    if (group.some((board) => board.hasNetlist)) {
      const home = [...group].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (home) alsoByBoard.set(home.id, mine);
      continue;
    }
    const stamp = stampSupply(supply, mine, nets);
    if (stamp) supply.stamp = stamp;
  }
  for (const board of boards) {
    const inst = loaded.resolved.find((item) => item.path === board.id);
    if (!inst) continue;
    const stamp = stampBoard({
      boardId: board.id,
      netlist: board.hasNetlist,
      ports: inst.type.ports,
      supplyGround: supplyGround(board, supplies, loaded.nets),
      powerPort: board.voltagePin,
      resetPort: board.resetPort,
      usbPort: connectorPort(inst.type.ports, "usb"),
      regulatorPort: board.regulatorPin,
      resetFraction: board.resetFraction,
      pins: board.driveOrder ?? board.pinOrder,
      parts: stampParts.filter((part) => {
        const hit = owners.get(part.path) ?? [];
        if (hit.length >= 2) return false;
        if (hit.length === 1) return hit[0]?.id === board.id;
        return !boards.some(
          (other) =>
            other.id !== board.id &&
            (part.path === other.id || part.path.startsWith(`${other.id}.`))
        );
      }),
      also: [
        ...(alsoByBoard.get(board.id) ?? []),
        ...stampParts.filter((part) => {
          const hit = owners.get(part.path) ?? [];
          return (
            inherited.has(part.path) &&
            hit.length === 1 &&
            hit[0]?.id === board.id
          );
        }),
      ],
      nets,
    });
    if (stamp) board.stamp = stamp;
  }
  // realize prunes a dangling part later. It still counts as placed
  // while its path is in exactly one stamp.
  const placed = new Map<string, number>();
  const note = (parts: { path: string }[] | undefined) => {
    if (!parts) return;
    for (const part of parts) {
      placed.set(part.path, (placed.get(part.path) ?? 0) + 1);
    }
  };
  for (const board of boards) note(board.stamp?.parts);
  for (const supply of supplies) note(supply.stamp?.parts);
  for (const span of spans) note([span.part]);
  for (const part of stampParts) {
    const count = placed.get(part.path) ?? 0;
    if (count === 1) continue;
    diags.push({
      severity: "degraded",
      code: "idle",
      path: part.path,
      port: "nets",
      quantity: "Part",
      left: part.path,
      right: "one stamp",
      message:
        count === 0
          ? `${part.path} is not in a stamp`
          : `${part.path} is in ${count} stamps`,
    });
  }

  const targets = readTargets(run.targets);
  if (!targets.ok) {
    diags.push({
      severity: "degraded",
      code: "bad-params",
      path: "environment.targets",
      port: "targets",
      quantity: "Position",
      left: "targets",
      right: "box, sphere, or cylinder",
      message: targets.error.message,
    });
  }
  notePlaceholderBoxes(loaded);
  return {
    plan: {
      ...planStep(run.play.timestep),
      environment: {
        ground: { plane: run.ground },
        gravity: [...run.play.gravity],
        ...(Array.isArray(run.play.primitives)
          ? { primitives: run.play.primitives as WorldPrimitive[] }
          : {}),
        ...(Array.isArray(run.play.stepProps)
          ? { stepProps: run.play.stepProps as WorldStepProp[] }
          : {}),
        targets: targets.ok ? targets.targets : [],
      },
      robots,
      boards,
      supplies,
      parts,
      leaves,
      rangers,
      ...(rays ? { rays } : {}),
      boxes,
      wires: electricalWires(loaded.nets),
      shownWires: authoredWires(loaded.nets, loaded.wires),
      levels: loaded.resolved.flatMap((inst) =>
        (["behaviour", "body", "visual"] as const).map((axis) => ({
          path: inst.path,
          axis,
          class: inst.axes[axis].class,
          variant: inst.axes[axis].variant,
          reason: inst.axes[axis].reason,
        }))
      ),
      report: loaded.report,
      ...(spans.length > 0 ? { spans } : {}),
      ...(coupled.shafts.length > 0 ? { shafts: coupled.shafts } : {}),
      ...(coupled.controls.length > 0 ? { controls: coupled.controls } : {}),
      ...(diags.length > 0 ? { degraded: diags } : {}),
      tree: runTree({
        run,
        resolved: loaded.resolved,
        robots,
        boards,
        supplies,
        parts,
        rangers,
        leaves,
        store: env.store,
        join: (...parts) => env.resolve(...parts),
        projectDir: worldDir,
        catalogDir: env.absolutePath(env.catalogDir()),
        assetRoot,
      }),
    },
    diags,
  };
}

/** Load one world file into the plan the run executes. */
export function planWorld(
  project: string,
  worldRel: string,
  env: PlanEnv,
  options: { context?: boolean } = {}
): PlanResult {
  const found = opened(project, worldRel, env);
  if ("error" in found) return { ok: false, errors: [schema(found.error)] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.readText(found.abs)) as unknown;
  } catch {
    return {
      ok: false,
      errors: [
        schema(
          "World file is not JSON. Hint: a world is a root part, parts/<publisher>/<name>@<version>.json."
        ),
      ],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [schema("World file is not a document.")] };
  }
  const version = (parsed as { version?: unknown }).version;
  if (version === 1) {
    return {
      ok: false,
      errors: [schema(`${WORLD_V1_MESSAGE}. Hint: write a version 2 world.`)],
    };
  }
  const loaded = loadWorldV2(env.absolutePath(found.abs), {
    store: env.store,
    catalogDir: env.absolutePath(env.catalogDir()),
    assetRoot: env.absolutePath(found.root),
  });
  if (!loaded.run) {
    const shown = loaded.diagnostics;
    return {
      ok: false,
      errors:
        shown.length > 0
          ? shown.map(fromDiag)
          : [schema("World file did not load.")],
    };
  }
  const built = build(loaded, found.root, assetDir(found.abs), env);
  if (!built.plan) {
    return { ok: false, errors: [schema("World file did not load.")] };
  }
  const loadErrors = loaded.diagnostics.filter(
    (diag) => diag.severity === "error"
  );
  const fromLoad = loadErrors.map((diag) => present(diag));
  const rows = [...fromLoad, ...built.diags.map((diag) => present(diag))];
  if (rows.length > 0) {
    built.plan.degraded = rows;
    if (built.plan.report) {
      // A load error that became a degraded row leaves the errors. The
      // report holds it as the loader worded it, before `present`.
      const drop = new Set([
        ...loadErrors.map((diag) => diag.message),
        ...rows.map((row) => row.message),
      ]);
      built.plan.report = {
        ...built.plan.report,
        errors: built.plan.report.errors.filter(
          (row) => !drop.has(row.message)
        ),
        degraded: rows,
      };
    }
  }
  noteFreshness(
    built.plan.report ?? null,
    built.plan.tree,
    loaded,
    found.root,
    env
  );
  const plan = built.plan;
  const report = plan.report ?? null;
  let context: string | undefined;
  const contextOf = () => {
    if (context === undefined && report) {
      const inputs = runInputs(
        plan,
        loaded.lock,
        found.root,
        assetDir(found.abs),
        env
      );
      context = runContext(parsed, report, inputs);
    }
    return context;
  };
  readAccuracy(report, parsed, worldRel, found.root, env, contextOf);
  if (options.context) {
    const own = contextOf();
    if (own !== undefined) plan.context = own;
  }
  return { ok: true, plan };
}

/**
 * A capture is stale when its stored signature no longer matches its
 * source. It still runs. A signature that cannot be recomputed marks the
 * row unchecked, with why. Only a snapshot this run loaded is checked, so
 * the view marks those options.
 */
function noteFreshness(
  report: RunReport | null,
  tree: WorldViewTree | undefined,
  loaded: LoadResult,
  root: string,
  env: PlanEnv
): void {
  if (!report) return;
  const catalog = env.absolutePath(env.catalogDir());
  const world = env.absolutePath(root);
  const stamp = stampEnv(env);
  for (const row of report.snapshots) {
    const from = row.provenance?.from;
    if (!from?.hash) continue;
    const snap = loaded.snapshots.find((item) => item.id === row.ref);
    if (!snap) continue;
    const fresh = provenanceHash(
      snap.file,
      { catalogDir: catalog, worldDir: world },
      stamp
    );
    if (!fresh.checked) {
      row.unchecked = fresh.reason;
      continue;
    }
    if (fresh.hash === from.hash) continue;
    row.stale = true;
    markStaleOptions(
      tree?.nodes ?? [],
      row.ref,
      `the part changed since ${from.part} class ${from.level} was captured`
    );
    report.warnings.push(
      makeDiag({
        severity: "warning",
        code: "stale-capture",
        path: from.part,
        port: snap.path,
        quantity: "Snapshot",
        left: from.level,
        right: row.ref,
        detail: `stale capture of ${from.part} class ${from.level} (${snap.path})`,
      })
    );
  }
}

/**
 * Every file the run reads, by its project path and content hash: each
 * board's firmware image, each robot's URDF and every mesh it names, and
 * the level overlays merged into a part. A file that cannot be read is
 * stated as such, so it still differs from one that can.
 */
function runInputs(
  plan: RunPlan,
  lock: LoadResult["lock"],
  root: string,
  worldDir: string,
  env: PlanEnv
): RunInput[] {
  const inputs = new Map<string, string>();
  const add = (abs: string) => {
    const file = env.relative(root, abs).split(env.sep).join("/");
    if (inputs.has(file)) return;
    let sha256 = "missing";
    try {
      if (env.exists(abs)) {
        sha256 = sha256Bytes(
          env.readBytes
            ? env.readBytes(abs)
            : new TextEncoder().encode(env.readText(abs))
        );
      }
    } catch {
      sha256 = "unreadable";
    }
    inputs.set(file, sha256);
  };
  for (const board of plan.boards) add(env.resolve(worldDir, board.firmware));
  for (const robot of plan.robots) {
    const urdf = env.resolve(worldDir, robot.urdf);
    add(urdf);
    let xml = "";
    try {
      xml = env.exists(urdf) ? env.readText(urdf) : "";
    } catch {
      xml = "";
    }
    const mesh = /<mesh\b[^>]*?filename\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of xml.matchAll(mesh)) {
      add(env.resolve(env.dirname(urdf), match[1] ?? match[2] ?? ""));
    }
  }
  return [
    ...[...inputs].map(([file, sha256]) => ({ file, sha256 })),
    ...(lock?.overlays ?? []).map((row) => ({
      file: row.path,
      sha256: row.sha256,
    })),
  ];
}

/** The document's assembly check, when it has one (`accuracy.ts`). */
function readAccuracy(
  report: RunReport | null,
  document: unknown,
  worldRel: string,
  root: string,
  env: PlanEnv,
  contextOf: () => string | undefined
): void {
  const id = (document as { id?: unknown }).id;
  const recordRel = typeof id === "string" ? recordPathFor(id) : null;
  if (!report || !recordRel) return;
  const abs = env.resolve(root, recordRel);
  if (!env.exists(abs)) return;
  let record: unknown = null;
  try {
    record = JSON.parse(env.readText(abs)) as unknown;
  } catch {
    return;
  }
  const rel = worldRel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const context = contextOf();
  if (context === undefined) return;
  noteAccuracy(report, context, rel, recordRel, record);
}

function markStaleOptions(
  nodes: readonly WorldViewNode[],
  ref: string,
  reason: string
): void {
  for (const node of nodes) {
    for (const axis of node.levels) {
      for (const option of axis.options) {
        if (option.ref === ref) option.stale = reason;
      }
    }
    markStaleOptions(node.children, ref, reason);
  }
}

function stampEnv(env: PlanEnv): StampEnv {
  return {
    store: env.store,
    absolutePath: (file) => env.absolutePath(file),
    defaultCatalog: () => env.absolutePath(env.catalogDir()),
    join: (...parts) => env.resolve(...parts),
  };
}

/**
 * `1 ms / k` exactly, so MuJoCo and the circuit read the same number. A step
 * that does not divide 1 ms is omitted and the body steps 1 ms.
 */
function planStep(seconds: number | undefined): { timestep?: number } {
  const k = typeof seconds === "number" ? stepsPerMs(seconds) : null;
  return k === null ? {} : { timestep: DEFAULT_TIMESTEP_S / k };
}
