/**
 * Capture a group's behaviour snapshot from the group running. The form's
 * params are reduced from the deep level's run plan by form; nothing here
 * names a part type. The error rows run both levels on one fixture world
 * and compare the instance at its own ports: the angle of its rotational
 * output and the current into its power input.
 */
import {
  type FormId,
  type GroupCaptureRecipe,
  type LevelSpec,
  type PartFile,
  type PartTypeFile,
  type RecordedFrame,
  type RecordingRead,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
} from "@sfab-bench/contract";
import { contentHash, lintSnapshot, sortValue } from "@sfab-bench/parts";

import type { CaptureEnv } from "./capture";
import type { AssignedPart } from "./circuit-stamp";
import { groupHash } from "./freshness";
import type { RunPlan } from "./plan";

/** The servo pulse map spans 180°. */
const PULSE_SPAN = Math.PI;

export type GroupCaptureEntry = {
  id: string;
  part: string;
} & GroupCaptureRecipe;

export type GroupCaptureInput = {
  catalog: string;
  entry: GroupCaptureEntry;
  created: string;
  tool: { name: string; version: string };
  bench: { version: string; mujoco: string; avr8js: string };
  outFile?: string;
};

export type GroupCaptureStats = {
  params: Record<string, number>;
  angleMaxAbs: number;
  currentMaxAbs: number;
};

type Reducer = (
  plan: RunPlan,
  path: string,
  vNominal: number
) => Record<string, number>;

const REDUCERS: Partial<Record<FormId, Reducer>> = {
  "position-servo@1": reducePositionServo,
};

/** Whether a capture entry's form is a group reduction. */
export function isGroupForm(form: string): boolean {
  return REDUCERS[form as FormId] !== undefined;
}

/**
 * `position-servo@1` from the shaft named after the instance: its one
 * `dc-motor@1` behind the train (`K = ratio·k`, `R`, `efficiency`), the one
 * `servo-control@1` under the instance (`eSat`, `quiescent`), and each
 * `potentiometer@1` wiper's track draw at `vNominal` added to `quiescent`.
 * The control and each wiper must span the pulse map.
 */
function reducePositionServo(
  plan: RunPlan,
  path: string,
  vNominal: number
): Record<string, number> {
  const shaft = shaftOf(plan, path);
  const [motor, ...more] = shaft.motors;
  if (!motor || more.length > 0) {
    throw new Error(`${path}: needs one dc-motor@1 on its shaft`);
  }
  const [control, ...others] = (plan.controls ?? []).filter((row) =>
    row.path.startsWith(`${path}.`)
  );
  if (!control || others.length > 0) {
    throw new Error(`${path}: needs one servo-control@1 under it`);
  }
  const travels = [control.travel, ...shaft.sensors.map((row) => row.travel)];
  if (travels.some((travel) => Math.abs(travel - PULSE_SPAN) > 1e-9)) {
    throw new Error(`${path}: a travel is not the pulse map's π rad`);
  }
  const stamped = stampedParts(plan);
  const paramOf = (part: string, key: string): number => {
    const value = stamped.get(part)?.params[key];
    if (typeof value !== "number") throw new Error(`${part}: no ${key}`);
    return value;
  };
  let quiescent = paramOf(control.path, "quiescent");
  for (const sensor of shaft.sensors) {
    quiescent += vNominal / paramOf(sensor.path, "R");
  }
  return {
    K: round12(motor.ratio * motor.k),
    R: round12(paramOf(motor.path, "R")),
    efficiency: round12(motor.efficiency),
    eSat: round12(control.eSat),
    quiescent: round12(quiescent),
  };
}

function shaftOf(plan: RunPlan, path: string) {
  const shaft = (plan.shafts ?? []).find((row) => row.id === path);
  if (!shaft) throw new Error(`${path}: no shaft is named after it`);
  return shaft;
}

function stampedParts(plan: RunPlan): Map<string, AssignedPart> {
  const out = new Map<string, AssignedPart>();
  for (const row of plan.spans ?? []) out.set(row.part.path, row.part);
  for (const holder of [...plan.boards, ...plan.supplies]) {
    for (const part of holder.stamp?.parts ?? []) out.set(part.path, part);
  }
  return out;
}

export async function writeGroupSnapshot(
  input: GroupCaptureInput,
  env: CaptureEnv
): Promise<GroupCaptureStats> {
  const { entry } = input;
  const reduce = REDUCERS[entry.form];
  if (!reduce) throw new Error(`no group reduction to ${entry.form}`);
  const read = (id: string): PartFile | null => {
    const file = refPath(env.join(input.catalog, "parts"), id, env);
    try {
      return JSON.parse(env.readText(file)) as PartFile;
    } catch {
      return null;
    }
  };
  const part = read(entry.part);
  if (!part) throw new Error(`${entry.part} is not in the catalog`);
  const fromHash = groupHash(entry.part, entry.sourceLevel, read);
  if (!fromHash) {
    throw new Error(
      `${entry.part} class ${entry.sourceLevel} behaviour is not a composite`
    );
  }
  const typeId = typeof part.type === "string" ? part.type : part.type.id;
  const type = JSON.parse(
    env.readText(env.join(input.catalog, "types", `${typeId}.json`))
  ) as PartTypeFile;
  const power = onePort(type, "power", (decl) => decl.role === "power");
  const shaft = onePort(
    type,
    "rotational",
    (decl) => decl.domain === "rotational"
  );
  const { instance } = entry.scene;

  const root = env.makeTemp("sfab-capture-");
  try {
    env.copyTree(env.join(env.examplesDir(), entry.scene.project), root);
    const worldText = env.readText(env.join(root, entry.scene.world));
    const deep = writeSide(root, entry, "deep", worldText, env);
    const snapWorld = writeSide(root, entry, "snap", worldText, env);
    const planned = env.plan(root, deep);
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    const params = reduce(planned.plan, instance, entry.vNominal);
    const { robot, joint } = shaftOf(planned.plan, instance).drives;
    const seed = (JSON.parse(worldText) as { play?: { seed?: unknown } }).play
      ?.seed;
    const snapshot = (
      error: SnapshotFile["error"],
      bounds: Record<string, [number, number]>
    ): SnapshotFile => ({
      format: SNAPSHOT_FORMAT,
      partType: typeId,
      part: entry.part,
      axis: "behaviour",
      form: entry.form,
      ports: {
        inputs: [`${power}.voltage`],
        outputs: [`${shaft}.angle`, `${power}.current`],
      },
      params,
      envelope: { bounds },
      error,
      quality: "Q2a",
      provenance: {
        source: "captured",
        from: { part: entry.part, level: entry.sourceLevel, hash: fromHash },
        fixture: {
          ref: `${entry.scene.project}/${entry.scene.world}`,
          hash: contentHash(JSON.parse(worldText) as unknown),
          seed: typeof seed === "number" ? seed : 0,
        },
        tool: input.tool,
        bench: input.bench,
        created: input.created,
      },
    });
    // The snapshot side resolves the ref from the world's own snapshots
    // first, so it runs these params before the catalog has them. With no
    // error rows yet it claims only what the linter grants.
    const provisional = snapshot([], {});
    provisional.quality = lintOf(provisional, type).quality;
    writeJson(
      refPath(env.join(root, "snapshots"), entry.id, env),
      provisional,
      env
    );
    const a = (await env.runWorld(root, deep, entry.scene.ms)).read;
    const b = (await env.runWorld(root, snapWorld, entry.scene.ms)).read;
    const angleOf = (frame: RecordedFrame) => frame.joints[robot]?.[joint];
    const partOf = (key: "current" | "voltage") => (frame: RecordedFrame) =>
      frame.parts[instance]?.[key];
    const angle = compare(channel(a, angleOf), channel(b, angleOf));
    const current = compare(
      channel(a, partOf("current")),
      channel(b, partOf("current"))
    );
    const row = (
      metric: "free-run-max-abs" | "free-run-rms",
      quantity: string,
      value: number
    ) => ({
      metric,
      quantity,
      value: round9(value),
      heldOut: entry.heldOut,
      baseline: entry.baseline,
    });
    const done = snapshot(
      [
        row("free-run-max-abs", `${shaft}.angle`, angle.maxAbs),
        row("free-run-rms", `${shaft}.angle`, angle.rms),
        row("free-run-max-abs", `${power}.current`, current.maxAbs),
        row("free-run-rms", `${power}.current`, current.rms),
      ],
      {
        [`${power}.voltage`]: range(channel(a, partOf("voltage"))),
        [`${power}.current`]: range(channel(a, partOf("current"))),
      }
    );
    const lint = lintOf(done, type);
    if (lint.diagnostics.length > 0 || lint.quality !== "Q2a") {
      throw new Error(
        `group lint ${lint.quality}: ${lint.diagnostics.map((d) => d.message).join("; ")}`
      );
    }
    done.quality = lint.quality;
    writeJson(
      input.outFile ??
        refPath(env.join(input.catalog, "snapshots"), entry.id, env),
      done,
      env
    );
    return {
      params,
      angleMaxAbs: angle.maxAbs,
      currentMaxAbs: current.maxAbs,
    };
  } finally {
    env.removeTree(root);
  }
}

function lintOf(snap: SnapshotFile, type: PartTypeFile) {
  return lintSnapshot(snap, {
    plausible: type.plausible,
    ports: type.ports,
    ...(type.requiredOutputs ? { requiredOutputs: type.requiredOutputs } : {}),
  });
}

function onePort(
  type: PartTypeFile,
  label: string,
  match: (decl: PartTypeFile["ports"][string]) => boolean
): string {
  const names = Object.entries(type.ports)
    .filter(([, decl]) => match(decl))
    .map(([name]) => name);
  const [name, ...more] = names;
  if (!name || more.length > 0) {
    throw new Error(`${type.id} needs one ${label} port, has ${names.length}`);
  }
  return name;
}

/** A copy of the scene world with the instance's levels for one side. */
function writeSide(
  root: string,
  entry: GroupCaptureEntry,
  side: "deep" | "snap",
  worldText: string,
  env: CaptureEnv
): string {
  const world = JSON.parse(worldText) as {
    id: string;
    play: {
      levels?: { default: LevelSpec; paths?: Record<string, LevelSpec> };
    };
  };
  const slash = world.id.indexOf("/");
  const at = world.id.lastIndexOf("@");
  const name = `${world.id.slice(slash + 1, at)}-capture-${side}`;
  world.id = `${world.id.slice(0, slash + 1)}${name}${world.id.slice(at)}`;
  const levels = world.play.levels ?? { default: 1 };
  world.play.levels = {
    ...levels,
    paths: {
      ...levels.paths,
      [entry.scene.instance]: side === "deep" ? entry.deep : entry.snap,
    },
  };
  const rel = `parts/${world.id.slice(0, slash)}/${name}${world.id.slice(at)}.json`;
  writeJson(env.join(root, rel), world, env);
  return rel;
}

/** `<dir>/<publisher>/<name>@<version>.json`. */
function refPath(dir: string, id: string, env: CaptureEnv): string {
  const slash = id.indexOf("/");
  return env.join(dir, id.slice(0, slash), `${id.slice(slash + 1)}.json`);
}

function writeJson(file: string, value: unknown, env: CaptureEnv): void {
  env.writeText(file, `${JSON.stringify(sortValue(value), null, 2)}\n`);
}

function channel(
  read: RecordingRead,
  pick: (frame: RecordedFrame) => number | undefined
): number[] {
  return read.frames.map((frame) => pick(frame) ?? Number.NaN);
}

function compare(a: number[], b: number[]): { maxAbs: number; rms: number } {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`frame counts ${a.length} and ${b.length}`);
  }
  let maxAbs = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (!Number.isFinite(d)) throw new Error(`frame ${i} has no value`);
    if (d > maxAbs) maxAbs = d;
    sum += d * d;
  }
  return { maxAbs, rms: Math.sqrt(sum / a.length) };
}

function range(values: number[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("a frame has no value");
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return [round9(lo), round9(hi)];
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function round12(n: number): number {
  return Number(n.toPrecision(12));
}
