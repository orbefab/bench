/** The run's plan, built from loadWorldV2 (layered-sim E7, 318b899). */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  arduinoPinBit,
  type BehaviourImpl,
  type BodyImpl,
  type Diagnostic,
  type PortDecl,
  type Pose,
  type RunReport,
  type VisualImpl,
  type WorldError,
  type WorldPrimitive,
  type WorldStepProp,
  type WorldTarget,
} from "@sfab-bench/contract";
import { type AvrPinParams, avrPinParams } from "./circuit/pin";
import {
  type BoardStamp,
  type CircuitInst,
  circuitNumbers,
  connectorPort,
  groundPorts,
  isCircuitForm,
  liveNets,
  railPowerPorts,
  stampBoard,
  touches,
} from "./circuit-stamp";
import type { LiveInstance } from "./parts/levels";
import { type LoadResult, loadWorldV2 } from "./parts/load";
import type { LiveNet, Wire, WireEnd } from "./parts/nets";
import { siValue } from "./parts/si";
import { chipFacts, pathRefOf, snapshotRefOf } from "./power-path";
import type { RangerLaw, RunRanger } from "./ranger";
import {
  envelopeOf,
  type SnapshotEnvelope,
  type TableLaw,
  tableLawOf,
} from "./snapshot-law";
import { readTargets } from "./targets";

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
  voltagePin: string;
  groundPin: string;
  /** Amperes drawn by the board, independent of voltage. */
  current: number;
  /**
   * Class-1 source law, `snapshot:<ref>`, or null when the 5V pin is
   * the supply terminal. A class-2 board carries `stamp` instead.
   */
  boardCircuit: string | null;
  /** The selected variant has a board netlist. */
  hasNetlist: boolean;
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
  /**
   * Class-1 USB law. Null when this variant does not name a snapshot.
   * A bench supply still leaves the pin as the ideal terminal.
   */
  powerSnapshot?: PowerSnapshot | null;
};

export type PowerSnapshot = {
  ref: string;
  law: TableLaw;
  envelope: SnapshotEnvelope;
  quality: string;
  error: RunReport["snapshots"][number]["error"];
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
};

export type { RunRanger };

/**
 * What one run executes. Not a file format. Instance ids are the ones
 * written in the scene (`arm`, `uno`, `servo`), so wires stay `uno.D9`.
 */
export type RunPlan = {
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
};

export type PlanResult =
  | { ok: true; plan: RunPlan }
  | { ok: false; errors: WorldError[] };

export function catalogRoot(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

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
  worldRel: string
): { root: string; abs: string } | { error: string } {
  let root: string;
  try {
    root = realpathSync(project);
  } catch {
    return {
      error: "The project folder is gone. Hint: open the folder again.",
    };
  }
  const rel = worldRel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..") || path.isAbsolute(rel)) {
    return { error: "path escapes the project" };
  }
  const abs = path.resolve(root, rel);
  if (!existsSync(abs)) {
    return {
      error: `World "${worldRel}" does not exist. Hint: the path is relative to the project.`,
    };
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return {
      error: `World "${worldRel}" does not exist. Hint: the path is relative to the project.`,
    };
  }
  const back = path.relative(root, real);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    return { error: "path escapes the project" };
  }
  return { root, abs: real };
}

function worldRelative(
  assetRoot: string,
  worldDir: string,
  file: string
): string {
  const abs = path.resolve(assetRoot, file);
  const rel = path.relative(worldDir, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return file.split(path.sep).join("/");
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
  for (const [key, value] of Object.entries(behaviour.params)) {
    out[key] = siValue(value);
  }
  for (const [key, value] of Object.entries(inst.params)) {
    if (typeof value === "number" && Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

/**
 * A lumped servo wired to another part's URDF still gets this box: the
 * robot meshes belong to that other part. When this part's own body is
 * a URDF, the meshes are already drawn, so the visual box is skipped.
 */
function pushBox(boxes: RunBox[], inst: LiveInstance, pick: RunBox["pick"]) {
  const body = inst.axes.body.impl as BodyImpl | null;
  if (body?.kind === "urdf") return;
  const visual = inst.axes.visual.impl as VisualImpl | null;
  if (visual?.kind !== "box") return;
  if (!visual.size.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return;
  }
  boxes.push({
    id: inst.path,
    pose: poseOf(inst),
    size: [visual.size[0], visual.size[1], visual.size[2]],
    pick,
  });
}

function poseOf(inst: LiveInstance): Pose {
  if (!inst.pose) return IDENTITY;
  return {
    position: [...inst.pose.position] as Pose["position"],
    rotation: [...inst.pose.rotation] as Pose["rotation"],
  };
}

function cannot(inst: LiveInstance, detail: string): Diagnostic {
  return {
    severity: "error",
    path: inst.path,
    port: "behaviour",
    quantity: "Level",
    left: inst.axes.behaviour.label,
    right: "runnable",
    message: `${inst.path} port behaviour quantity Level: ${detail} (${inst.axes.behaviour.label} vs runnable)`,
  };
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
  loaded: LoadResult
): { boardId: string; bit: number } | null {
  for (const wire of loaded.wires) {
    const other =
      wire.a.path === inst.path && wire.a.port === port
        ? wire.b
        : wire.b.path === inst.path && wire.b.port === port
          ? wire.a
          : null;
    if (!other) continue;
    const board = loaded.resolved.find((item) => item.path === other.path);
    const boardBehaviour = board?.axes.behaviour.impl as BehaviourImpl | null;
    if (!board || boardBehaviour?.kind !== "firmware") continue;
    const bit = arduinoPinBit(other.port);
    if (bit === undefined) continue;
    return { boardId: board.path, bit };
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
  return {
    path: inst.path,
    form: behaviour.form,
    typeId: inst.type.id,
    params,
    ports,
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
        (behaviour.form === "thevenin-limit@1" ||
          behaviour.form === "ideal-voltage@1")
      );
    });
    if (fed) return name;
  }
  return candidates[0] ?? null;
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
  worldDir: string
): { plan: RunPlan | null; diags: Diagnostic[] } {
  const world = loaded.world;
  if (!world) return { plan: null, diags: loaded.diagnostics };
  const diags: Diagnostic[] = [];
  const robots: RunRobot[] = [];
  const boards: RunBoard[] = [];
  const supplies: RunSupply[] = [];
  const parts: RunPart[] = [];
  const rangers: RunRanger[] = [];
  const boxes: RunBox[] = [];
  const circuits: CircuitInst[] = [];

  for (const inst of loaded.resolved) {
    if (inst.path === "$root") continue;
    const behaviour = selectedBehaviour(inst);
    if (behaviour?.kind === "composite") continue;
    const circuit = circuitInstOf(inst);
    if (circuit) {
      circuits.push(circuit);
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
        urdf: worldRelative(assetRoot, worldDir, file),
        pose: poseOf(inst),
      });
      continue;
    }
    if (behaviour?.kind === "firmware") {
      const boardCircuit = behaviour.boardCircuit ?? null;
      const snapRef = snapshotRefOf(boardCircuit);
      const pathName = pathRefOf(boardCircuit);
      if (boardCircuit !== null && !snapRef && pathName !== "uno-usb") {
        diags.push(cannot(inst, `unknown board circuit ${boardCircuit}`));
        continue;
      }
      const facts = chipFacts(behaviour.chip);
      if (!facts) {
        diags.push(cannot(inst, `unknown chip "${behaviour.chip}"`));
        continue;
      }
      let runCircuit = boardCircuit;
      let powerSnapshot: PowerSnapshot | null = null;
      if (snapRef) {
        const runs = loaded.snapshotRuns.includes(inst.path);
        if (runs) {
          const found = loaded.snapshots.find((row) => row.id === snapRef);
          const law = found ? tableLawOf(found.file) : null;
          const envelope = found ? envelopeOf(found.file) : null;
          if (!found || !law || !envelope) {
            diags.push(cannot(inst, `snapshot ${snapRef} did not load`));
            continue;
          }
          powerSnapshot = {
            ref: snapRef,
            law,
            envelope,
            quality: found.quality,
            error: found.file.error,
          };
        } else {
          runCircuit = null;
        }
      }
      const params = behaviour.params ?? {};
      const image = behaviour.imageParam
        ? inst.params[behaviour.imageParam]
        : undefined;
      if (typeof image !== "string") {
        diags.push(cannot(inst, "the board has no firmware image"));
        continue;
      }
      const visual = inst.axes.visual.impl as VisualImpl | null;
      const size =
        visual?.kind === "box"
          ? ([...visual.size] as [number, number, number])
          : ([0, 0, 0] as [number, number, number]);
      const powerName = chosenPowerPort(inst, loaded, facts.railVoltage);
      if (!powerName) {
        diags.push(cannot(inst, "the board has no power input"));
        continue;
      }
      const groundName = groundPorts(inst.type.ports)[0] ?? "GND";
      const rail = rangePair(inst.type.ports[powerName]?.ratings?.voltage) ?? [
        facts.railVoltage,
        facts.railVoltage,
      ];
      const source = inst.params.source;
      boards.push({
        id: inst.path,
        type: typeId,
        chip: behaviour.chip,
        firmware: worldRelative(assetRoot, worldDir, image),
        ...(typeof source === "string"
          ? { source: worldRelative(assetRoot, worldDir, source) }
          : {}),
        pose: poseOf(inst),
        size,
        pins: pinsOf(inst.type.ports),
        powerInputs: [powerName],
        voltagePin: powerName,
        groundPin: groundName,
        current: params.quiescent ?? 0,
        boardCircuit: runCircuit,
        hasNetlist: behaviour.board !== undefined,
        brownoutVoltage: params.brownoutVoltage ?? Number.POSITIVE_INFINITY,
        brownoutAssertVoltage:
          params.brownoutAssertVoltage ?? Number.POSITIVE_INFINITY,
        brownoutReleaseVoltage:
          params.brownoutReleaseVoltage ?? Number.POSITIVE_INFINITY,
        operatingVoltage: rail[0],
        supply: { min: rail[0], max: rail[1] },
        pin: avrPinParams(params),
        ...(powerSnapshot ? { powerSnapshot } : {}),
      });
      continue;
    }
    if (behaviour?.kind === "form" && behaviour.form === "thevenin-limit@1") {
      const numbers = formNumbers(inst);
      if (!numbers) {
        diags.push(cannot(inst, "the run needs thevenin-limit@1"));
        continue;
      }
      const pins = pinsOf(inst.type.ports);
      const positive =
        Object.entries(pins).find(
          ([, pin]) => pin.kind === "power" && pin.output
        )?.[0] ?? "5V";
      const ground =
        Object.entries(pins).find(([, pin]) => pin.kind === "ground")?.[0] ??
        "GND";
      supplies.push({
        id: inst.path,
        type: typeId,
        voltage: numbers.V ?? 0,
        currentLimit: numbers.Ilimit ?? 0,
        rSeries: numbers.Rs ?? 0,
        positivePin: positive,
        groundPin: ground,
        connector: inst.type.ports[positive]?.connector ?? null,
        pins,
      });
      pushBox(boxes, inst, "supply");
      continue;
    }
    if (behaviour?.kind === "form" && behaviour.form === "dc-motor@1") {
      const numbers = formNumbers(inst);
      const body = inst.axes.body.impl as BodyImpl | null;
      if (
        !numbers ||
        inst.axes.behaviour.label !== "form dc-motor@1" ||
        body?.kind !== "lumped" ||
        !body.joint
      ) {
        diags.push(cannot(inst, "the run needs dc-motor@1 and a lumped joint"));
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
          armature: body.joint.armature ?? 0,
          frictionloss: body.joint.frictionloss ?? 0,
          damping: body.joint.damping ?? 0,
        },
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
        trig: digitalPeer(inst, "Trig", loaded),
        echo: digitalPeer(inst, "Echo", loaded),
      });
      pushBox(boxes, inst, "part");
      continue;
    }
    diags.push(cannot(inst, runtimeGap(inst)));
  }

  const nets = liveNets(loaded.nets);
  const crowded = new Set<string>();
  for (const part of circuits) {
    const hit = boards.filter((board) => touches(part, board.id, nets));
    if (hit.length < 2) continue;
    crowded.add(part.path);
    const names = hit.map((board) => board.id).join(" and ");
    diags.push({
      severity: "error",
      path: part.path,
      port: "nets",
      quantity: "Part",
      left: names,
      right: "one board",
      message: `${part.path} sits between ${names}; a circuit part on two supplies is not in this run`,
    });
  }
  const stampParts = circuits.filter((part) => !crowded.has(part.path));
  for (const board of boards) {
    const inst = loaded.resolved.find((item) => item.path === board.id);
    if (!inst) continue;
    const behaviour = inst ? selectedBehaviour(inst) : null;
    const facts =
      behaviour?.kind === "firmware" ? chipFacts(behaviour.chip) : null;
    const stamp = stampBoard({
      boardId: board.id,
      netlist: board.hasNetlist,
      ports: inst.type.ports,
      supplyGround: supplyGround(board, supplies, loaded.nets),
      powerPort: board.voltagePin,
      resetPort:
        behaviour?.kind === "firmware" ? (behaviour.resetPort ?? null) : null,
      usbPort: connectorPort(inst.type.ports, "usb"),
      resetFraction: facts?.resetFraction ?? null,
      parts: stampParts,
      nets,
    });
    if (stamp) board.stamp = stamp;
  }

  if (diags.length > 0) return { plan: null, diags };
  const environment = world.environment;
  const targets = readTargets(environment.targets);
  if (!targets.ok) {
    return {
      plan: null,
      diags: [
        {
          severity: "error",
          path: "environment.targets",
          port: "targets",
          quantity: "Position",
          left: "targets",
          right: "box, sphere, or cylinder",
          message: targets.error.message,
        },
      ],
    };
  }
  return {
    plan: {
      environment: {
        ground: { plane: environment.ground.plane },
        gravity: [...environment.gravity],
        ...(Array.isArray(environment.primitives)
          ? { primitives: environment.primitives as WorldPrimitive[] }
          : {}),
        ...(Array.isArray(environment.stepProps)
          ? { stepProps: environment.stepProps as WorldStepProp[] }
          : {}),
        targets: targets.targets,
      },
      robots,
      boards,
      supplies,
      parts,
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
    },
    diags,
  };
}

/** Load one world file into the plan the run executes. */
export function planWorld(project: string, worldRel: string): PlanResult {
  const found = opened(project, worldRel);
  if ("error" in found) return { ok: false, errors: [schema(found.error)] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(found.abs, "utf8")) as unknown;
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
  const loaded = loadWorldV2(found.abs, {
    catalogDir: catalogRoot(),
    assetRoot: found.root,
  });
  const errors = loaded.diagnostics.filter((diag) => diag.severity === "error");
  if (errors.length > 0 || !loaded.world) {
    const shown = errors.length > 0 ? errors : loaded.diagnostics;
    return {
      ok: false,
      errors:
        shown.length > 0
          ? shown.map(fromDiag)
          : [schema("World file did not load.")],
    };
  }
  const built = build(loaded, found.root, path.dirname(found.abs));
  const blocked = built.diags.filter((diag) => diag.severity === "error");
  if (!built.plan || blocked.length > 0) {
    return { ok: false, errors: blocked.map(fromDiag) };
  }
  return { ok: true, plan: built.plan };
}
