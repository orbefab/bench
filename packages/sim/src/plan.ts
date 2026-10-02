/** The run's plan, built from loadWorldV2 (layered-sim E7, 318b899). */

import {
  type BehaviourImpl,
  type BodyImpl,
  DEFAULT_TIMESTEP_S,
  type Diagnostic,
  type PortDecl,
  type Pose,
  pinIndex,
  ROOT_PATH,
  type RunReport,
  SUPPLY_FORMS,
  type VisualImpl,
  type WorldError,
  type WorldPrimitive,
  type WorldStepProp,
  type WorldTarget,
  type WorldViewNode,
  type WorldViewTree,
} from "@sfab-bench/contract";
import { collapse } from "@sfab-bench/engine-body";
import { type AvrPinParams, avrPinParams } from "@sfab-bench/engine-circuit";
import {
  assetDir,
  type BatteryParams,
  envelopeOf,
  gearTrainErrors,
  type LiveInstance,
  type LiveNet,
  type LoadResult,
  loadWorldV2,
  makeDiag,
  mergeFormParams,
  siValue,
  tableLawOf,
  type Wire,
  type WireEnd,
} from "@sfab-bench/parts";
import {
  boardHostOf,
  chipExposure,
  chipFactsOf,
  gpioPinsOf,
} from "./chip-host";
import {
  type AssignedPart,
  assignNodes,
  type BoardStamp,
  type CircuitInst,
  circuitNumbers,
  connectorPort,
  groundPorts,
  isCircuitForm,
  ldoLaw,
  liveNets,
  railPowerPorts,
  stampBoard,
} from "./circuit-stamp";
import type { PlanEnv, StampEnv } from "./env";
import { formAdapter } from "./forms";
import { provenanceHash } from "./freshness";
import type { RangerLaw, RunRanger } from "./ranger";
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
  pins: Record<string, RunPin>;
  /** Pins a supply may power. On the Uno that is `5V`, not `VIN`. */
  powerInputs: readonly string[];
  /**
   * The supply that powers this board is on `VIN`, and not on the 5V
   * rail. The worker attaches there so the onboard regulator runs.
   */
  vinFeed: boolean;
  voltagePin: string;
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
   * exposes no chip pin the emulator knows.
   */
  pinOrder: readonly string[];
  /** Chip pin name for each `pinOrder` entry. Same length, same order. */
  wire: readonly string[];
  /**
   * Volts. A running chip above its brownout level and below this is outside
   * its specification. Null when the chip part gives no such band.
   */
  minOperatingVoltage: number | null;
  /**
   * Circuit parts on this board's nets, including its board netlist.
   * Absent when there are none.
   */
  stamp?: BoardStamp;
  brownoutVoltage: number;
  brownoutAssertVoltage: number;
  brownoutReleaseVoltage: number;
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
  pick: "part" | "supply";
};

export type RunPart = {
  id: string;
  /** Short name the cards and the recording already use, for example `sg90`. */
  model: string;
  /** Part type id, for example `hobby-servo-3wire`. */
  type: string;
  pins: Record<string, RunPin>;
  drive: { kind: "servo"; pin: string };
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
};

export type { RunRanger };

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
  /** Electrical pairs only. Mechanical links are `parts[].drives`. */
  wires: [string, string][];
  /** The scene's own electrical wires as authored, for the cards. */
  shownWires: [string, string][];
  /** Resolved level per instance per axis. Absent on a hand-built plan. */
  levels?: RunLevel[];
  /** Run report from the loader. The worker keeps it and amends envelope warnings. */
  report?: RunReport | null;
  /**
   * A part whose non-ground nets touch two boards. Stamped once on the
   * island rail, with both boards' node names. Absent when there are none.
   */
  spans?: { part: AssignedPart; boards: string[] }[];
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
  const missing = diag.message.includes("does not exist");
  return {
    code: missing ? "missing-file" : "schema",
    path: diag.path,
    message: diag.message,
  };
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
    return {
      kind: "gpio",
      output: true,
      digital: true,
      pwm: decl.pwm === true,
    };
  }
  if (decl.role === "logic" && decl.direction === "in") {
    return { kind: "signal", output: false, digital: false, pwm: false };
  }
  return { kind: "signal", output: false, digital: false, pwm: false };
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
function pushBox(boxes: RunBox[], inst: LiveInstance, pick: RunBox["pick"]) {
  const drawn = drawnBox(inst);
  if (!drawn) return;
  boxes.push({
    id: inst.path,
    pose: poseOf(inst),
    size: drawn.size,
    pick,
  });
  if (drawn.fallbackClass !== null) {
    inst.axes.visual.reason = `placeholder mesh; drawn as the class-${drawn.fallbackClass} box`;
  }
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
  fallbackClass: number | null;
} | null {
  const body = inst.axes.body.impl as BodyImpl | null;
  if (body?.kind === "urdf") return null;
  const visual = inst.axes.visual.impl as VisualImpl | null;
  if (visual?.kind === "box") {
    if (!finiteSize(visual.size)) return null;
    return {
      size: [visual.size[0], visual.size[1], visual.size[2]],
      fallbackClass: null,
    };
  }
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

function poseOf(inst: LiveInstance): Pose {
  if (!inst.pose) return IDENTITY;
  return {
    position: [...inst.pose.position] as Pose["position"],
    rotation: [...inst.pose.rotation] as Pose["rotation"],
  };
}

function cannot(inst: LiveInstance, detail: string, code = "idle"): Diagnostic {
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

function degrade(diag: Diagnostic, code: string): Diagnostic {
  return { ...diag, severity: "degraded", code: diag.code ?? code };
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
  const next =
    diag.severity === "degraded" ? diag : degrade(diag, degradeCode(diag));
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

function digitalPeer(
  inst: LiveInstance,
  port: string,
  loaded: LoadResult,
  boards: readonly RunBoard[]
): { boardId: string; bit: number } | null {
  for (const wire of loaded.wires) {
    const other =
      wire.a.path === inst.path && wire.a.port === port
        ? wire.b
        : wire.b.path === inst.path && wire.b.port === port
          ? wire.a
          : null;
    if (!other) continue;
    const board = boards.find((item) => item.id === other.path);
    if (!board) continue;
    const bit = pinIndex(board.pinOrder, other.port);
    if (bit === undefined) continue;
    return { boardId: other.path, bit };
  }
  return null;
}

function circuitInstOf(inst: LiveInstance): CircuitInst | null {
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (
    !behaviour ||
    behaviour.kind !== "form" ||
    !isCircuitForm(behaviour.form)
  ) {
    return null;
  }
  const params = circuitNumbers(behaviour, inst.params);
  if (!params) return null;
  const ports: Record<string, string> = {};
  for (const [name, decl] of Object.entries(inst.type.ports)) {
    if (decl.internal) continue;
    ports[name] = `${inst.path}.${name}`;
  }
  const ldo = ldoLaw(behaviour, inst.params);
  if (ldo === null) return null;
  return {
    path: inst.path,
    form: behaviour.form,
    typeId: inst.type.id,
    params,
    ports,
    ...(ldo ? { ldo } : {}),
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

function boundPairs(
  bounds: Record<string, unknown>
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [key, range] of Object.entries(bounds)) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const lo = range[0];
    const hi = range[1];
    if (typeof lo !== "number" || typeof hi !== "number") continue;
    out[key] = [siValue(lo), siValue(hi)];
  }
  return out;
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
  if (behaviour.kind === "form") return `no runtime for form ${behaviour.form}`;
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
    resetFraction: null,
    parts,
    nets,
  });
}

function rangerLaw(numbers: Record<string, number>): RangerLaw {
  return {
    c: numbers.c ?? 0,
    rangeMin: numbers.rangeMin ?? 0,
    rangeMax: numbers.rangeMax ?? 0,
    beamHalf: numbers.beamHalf ?? 0,
    trigMin: numbers.trigMin ?? 0,
    echoDelay: numbers.echoDelay ?? 0,
    echoTimeout: numbers.echoTimeout ?? 0,
    working: numbers.working ?? 0,
    quiescent: numbers.quiescent ?? 0,
    vMin: numbers.vMin ?? 0,
    face: numbers.face ?? 0,
  };
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
  const rangers: RunRanger[] = [];
  const boxes: RunBox[] = [];
  const circuits: CircuitInst[] = [];

  // An if-chain on the selected behaviour. A composite is a shell and
  // is skipped. What runs: firmware; form resistor@1, capacitor@1 and
  // diode@1; form multibody@1 with a urdf body; form thevenin-limit@1;
  // form dc-motor@1 with a lumped joint, a hinge@1 snapshot, or the
  // collapse of a gear train; form ranger@1. Anything else is a plan
  // error that names the path.
  const byPath = new Map(loaded.resolved.map((item) => [item.path, item]));
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
      circuits.push(circuit);
      if (!inst.path.includes(".")) {
        leaves.push({ id: inst.path, model: shortName(inst.part.id) });
      }
      if (inst.pose) pushBox(boxes, inst, "part");
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
        diags.push(
          cannot(host, `unknown chip "${behaviour.chip}"`, "unsupported")
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
      const visual = host.axes.visual.impl as VisualImpl | null;
      const size =
        visual?.kind === "box"
          ? ([...visual.size] as [number, number, number])
          : ([0, 0, 0] as [number, number, number]);
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
      const gpio = gpioPinsOf(behaviour.chip, exposure);
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
        pins: pinsOf(host.type.ports),
        powerInputs: [powerName],
        vinFeed: false,
        voltagePin: powerName,
        groundPin: groundName,
        current: quiescent ?? 0,
        hasNetlist: host.path !== inst.path,
        resetPort:
          host === inst
            ? (behaviour.resetPort ?? null)
            : ([...exposure.entries()].find(
                ([, pin]) => pin === behaviour.resetPort
              )?.[0] ?? null),
        resetFraction: facts.resetFraction,
        pinOrder: gpio.map((pin) => pin.name),
        wire: gpio.map((pin) => pin.chip),
        minOperatingVoltage: facts.minOperatingVoltage,
        brownoutVoltage: params.brownoutVoltage ?? Number.POSITIVE_INFINITY,
        brownoutAssertVoltage:
          params.brownoutAssertVoltage ?? Number.POSITIVE_INFINITY,
        brownoutReleaseVoltage:
          params.brownoutReleaseVoltage ?? Number.POSITIVE_INFINITY,
        operatingVoltage: rail[0],
        supply: { min: rail[0], max: rail[1] },
        pin: avrPinParams(params),
      });
      continue;
    }
    const place =
      behaviour?.kind === "form"
        ? formAdapter(behaviour.form)?.place
        : undefined;
    if (place && behaviour?.kind === "form") {
      place({
        inst,
        behaviour,
        typeId,
        numbers: () => formNumbers(inst),
        pins: () => pinsOf(inst.type.ports),
        reject: (detail) => {
          diags.push(cannot(inst, detail, "bad-params"));
        },
        add: (supply) => {
          supplies.push(supply);
        },
        box: () => {
          pushBox(boxes, inst, "supply");
        },
      });
      continue;
    }
    if (behaviour?.kind === "form" && behaviour.form === "dc-motor@1") {
      const numbers = formNumbers(inst);
      const hinge = jointOf(inst, loaded);
      if (
        !numbers ||
        inst.axes.behaviour.label !== "form dc-motor@1" ||
        !hinge
      ) {
        diags.push(
          cannot(inst, "the run needs dc-motor@1 and a lumped joint or a hinge")
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
        drive: { kind: "servo", pin: "signal" },
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
        ...(drives ? { drives } : {}),
      });
      pushBox(boxes, inst, "part");
      continue;
    }
    if (behaviour?.kind === "form" && behaviour.form === "ranger@1") {
      const numbers = formNumbers(inst);
      if (!numbers) {
        diags.push(cannot(inst, "the run needs ranger@1"));
        continue;
      }
      // The ray uses this scene pose for the whole run. A sensor on a
      // moving link is not supported yet.
      rangers.push({
        id: inst.path,
        model: shortName(inst.part.id),
        pose: poseOf(inst),
        law: rangerLaw(numbers),
        trig: digitalPeer(inst, "Trig", loaded, boards),
        echo: digitalPeer(inst, "Echo", loaded, boards),
      });
      pushBox(boxes, inst, "part");
      continue;
    }
    if (behaviour?.kind === "snapshot") {
      const found = loaded.snapshots.find((row) => row.id === behaviour.ref);
      const law = found ? tableLawOf(found.file) : null;
      const envelope = found ? envelopeOf(found.file) : null;
      const ran = loaded.snapshotRuns.some(
        (row) => row.path === inst.path && row.ref === behaviour.ref
      );
      if (
        !found ||
        !law ||
        !envelope ||
        !ran ||
        found.file.form !== "table@1"
      ) {
        diags.push(
          cannot(inst, `snapshot ${behaviour.ref} did not load as table@1`)
        );
        continue;
      }
      for (const name of law.across) {
        if (!inst.type.ports[name]) {
          diags.push(
            cannot(
              inst,
              `snapshot ${behaviour.ref} across port ${name} is not on ${inst.type.id}`
            )
          );
        }
      }
      if (diags.some((diag) => diag.path === inst.path)) continue;
      const ports: Record<string, string> = {};
      for (const name of law.across) ports[name] = `${inst.path}.${name}`;
      circuits.push({
        path: inst.path,
        form: "table@1",
        typeId: inst.type.id,
        params: {},
        ports,
        table: { ref: behaviour.ref, law, envelope },
      });
      if (!inst.path.includes(".")) {
        leaves.push({ id: inst.path, model: shortName(inst.part.id) });
      }
      if (inst.pose) pushBox(boxes, inst, "part");
      continue;
    }
    diags.push(cannot(inst, runtimeGap(inst), "no-runtime"));
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
  const owners = new Map<string, RunBoard[]>();
  for (const part of circuits) {
    const hit = ownersOf(part);
    owners.set(part.path, hit);
    if (hit.length >= 2) {
      spans.push({
        part: assignNodes(part, nets, ground),
        boards: hit.map((board) => board.id),
      });
      continue;
    }
    const reached = suppliesReached(part, supplies, nets);
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
    const onVin = supplyOnPort(board, "VIN");
    // VIN feeds the regulator. Parts on the regulated port take this
    // supply in the feed walk; their load sits on the 5V node.
    board.vinFeed = onRail === null && onVin !== null;
  }
  const boardsOn = new Map<string, RunBoard[]>();
  for (const board of boards) {
    const supplyId =
      supplyOnPort(board, board.voltagePin) ?? supplyOnPort(board, "VIN");
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
      resetFraction: board.resetFraction,
      pins: board.pinOrder,
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
      also: alsoByBoard.get(board.id),
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
      ...(run.play.timestep === DEFAULT_TIMESTEP_S
        ? { timestep: DEFAULT_TIMESTEP_S }
        : {}),
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
  env: PlanEnv
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
        schema("World file is not JSON. Hint: a world is <name>.world.json."),
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
  const fromLoad = loaded.diagnostics
    .filter((diag) => diag.severity === "error")
    .map((diag) => present(diag));
  const rows = [...fromLoad, ...built.diags.map((diag) => present(diag))];
  if (rows.length > 0) {
    built.plan.degraded = rows;
    if (built.plan.report) {
      const drop = new Set(rows.map((row) => row.message));
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
  return { ok: true, plan: built.plan };
}

/**
 * A capture is stale when its stored hash no longer matches the part.
 * It still runs. A hash that cannot be recomputed is left unmarked. Only
 * a snapshot this run loaded is checked, so the view marks those options.
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
      { catalogDir: catalog, worldDir: world, assetRoot: world },
      stamp
    );
    if (!fresh.checked || fresh.hash === from.hash) continue;
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

function degradeCode(diag: Diagnostic): string {
  const text = diag.message;
  if (
    text.includes("does not exist") ||
    text.includes("not found") ||
    text.includes("missing")
  ) {
    return "missing-file";
  }
  if (text.includes("unknown chip")) return "unsupported";
  if (text.includes("no runtime")) return "no-runtime";
  if (text.includes("reaches no supply") || text.includes("no supply")) {
    return "unpowered";
  }
  if (text.includes("variant") || text.includes("param")) return "bad-params";
  return "idle";
}
