/** The run's plan, built from loadWorldV2 (layered-sim E7, 318b899). */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BehaviourImpl,
  BodyImpl,
  Diagnostic,
  PortDecl,
  Pose,
  VisualImpl,
  WorldError,
  WorldPrimitive,
  WorldStepProp,
} from "@sfab-bench/contract";

import type { LiveInstance } from "./parts/levels";
import { type LoadResult, loadWorldV2 } from "./parts/load";
import type { LiveNet } from "./parts/nets";
import { siValue } from "./parts/si";

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
  brownoutVoltage: number;
  brownoutAssertVoltage: number;
  brownoutReleaseVoltage: number;
  operatingVoltage: number;
  supply: { min: number; max: number };
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
  pins: Record<string, RunPin>;
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
  };
  robots: RunRobot[];
  boards: RunBoard[];
  supplies: RunSupply[];
  parts: RunPart[];
  /** Electrical pairs only. Mechanical links are `parts[].drives`. */
  wires: [string, string][];
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

  for (const inst of loaded.resolved) {
    if (inst.path === "$root") continue;
    if (inst.path.includes(".")) {
      diags.push(cannot(inst, "a nested instance is not in this run"));
      continue;
    }
    const typeId = inst.type.id;
    if (typeId === "assembly") continue;
    const bodyImpl = inst.axes.body.impl as BodyImpl | null;
    if (bodyImpl?.kind === "urdf") {
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
    if (typeId === "arduino-uno-r3") {
      const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
      if (behaviour?.kind !== "firmware") {
        diags.push(cannot(inst, "the run needs the firmware level"));
        continue;
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
      const rail = rangePair(inst.type.ports["5V"]?.ratings?.voltage) ?? [5, 5];
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
        powerInputs: ["5V"],
        voltagePin: "5V",
        groundPin: "GND",
        current: params.quiescent ?? 0,
        brownoutVoltage: params.brownoutVoltage ?? Number.POSITIVE_INFINITY,
        brownoutAssertVoltage:
          params.brownoutAssertVoltage ?? Number.POSITIVE_INFINITY,
        brownoutReleaseVoltage:
          params.brownoutReleaseVoltage ?? Number.POSITIVE_INFINITY,
        operatingVoltage: rail[0],
        supply: { min: rail[0], max: rail[1] },
      });
      continue;
    }
    if (inst.axes.behaviour.label === "form thevenin-limit@1") {
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
        pins,
      });
      continue;
    }
    if (typeId === "hobby-servo-3wire") {
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
      continue;
    }
    diags.push(cannot(inst, `the run has no ${typeId}`));
  }

  if (diags.length > 0) return { plan: null, diags };
  const environment = world.environment;
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
      },
      robots,
      boards,
      supplies,
      parts,
      wires: electricalWires(loaded.nets),
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
