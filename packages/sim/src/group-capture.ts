/**
 * Capture a group's behaviour snapshot from the group running. The form's
 * params are reduced from the deep level's run plan by form; nothing here
 * names a part type. The error rows run both levels on one fixture world
 * and compare the instance at its own ports: the angle of its rotational
 * output and the current into its power input.
 *
 * The part, every part its netlist reaches and their types are read from
 * the capture source (the project, then the catalog) and staged into the
 * fixture world's copy, so the run measures what the signature names. A
 * part that is not the scene instance's own part takes that instance's
 * place when its type is the same.
 */
import {
  type FormId,
  type GroupCaptureRecipe,
  type LevelSpec,
  type NetlistInstance,
  type PartFile,
  type PartTypeFile,
  type RecordedFrame,
  type RecordingRead,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
} from "@sfab-bench/contract";
import {
  contentHash,
  environmentKind,
  lintSnapshot,
  loadPartById,
  runRootOf,
  sortValue,
} from "@sfab-bench/parts";

import type { CaptureEnv } from "./capture";
import { groupSignature } from "./capture-signature";
import type { CaptureSource } from "./capture-source";
import type { AssignedPart } from "./circuit-stamp";
import type { RunPlan } from "./plan";
import { openContext, planSide, type Selection } from "./run-context";

/** The servo pulse map spans 180°. */
const PULSE_SPAN = Math.PI;

export type GroupCaptureEntry = {
  id: string;
  part: string;
} & GroupCaptureRecipe;

export type GroupCaptureInput = {
  catalog: string;
  /** Where the part, the parts it reaches and their types are read. */
  source: CaptureSource;
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
  // Everything the signature reads, as the source read it, to stage.
  const parts = new Map<
    string,
    { part: PartFile; inProject: boolean; overlay?: string }
  >();
  const types = new Map<string, { type: PartTypeFile; inProject: boolean }>();
  const read = (id: string): PartFile | null => {
    const found = input.source.part(id);
    if (found) parts.set(id, found);
    return found?.part ?? null;
  };
  const readType = (id: string): PartTypeFile | null => {
    const found = input.source.type(id);
    if (found) types.set(id, found);
    return found?.type ?? null;
  };
  const part = read(entry.part);
  if (!part) throw new Error(`${entry.part} did not load`);
  const source = {
    level: entry.sourceLevel,
    variant: part.axes?.behaviour?.[entry.sourceLevel]?.default ?? "",
  };
  const fromHash = groupSignature(entry.part, source, read, readType);
  if (!fromHash) {
    throw new Error(
      `${entry.part} class ${entry.sourceLevel} behaviour is not a composite`
    );
  }
  const type = input.source.typeOf(part);
  if (!type) throw new Error(`${entry.part} type did not load`);
  const typeId = type.id;
  const ports = groupPorts(type);
  if (typeof ports === "string") throw new Error(ports);
  const { power, shaft } = ports;
  const { instance } = entry.scene;

  const root = env.makeTemp("sfab-capture-");
  try {
    env.copyTree(env.join(env.examplesDir(), entry.scene.project), root);
    stage(root, parts, types, env);
    const worldText = placeInstance(
      root,
      input,
      env.readText(env.join(root, entry.scene.world)),
      typeId,
      env
    );
    const deep = writeSide(root, entry, "deep", worldText, env);
    const snapWorld = writeSide(root, entry, "snap", worldText, env);
    // The source side's realization, from a frozen context of the scene.
    const { plan } = planSide(
      openContext(env.files, root, entry.scene.world, {
        document: JSON.parse(worldText) as unknown,
      }),
      sideLevels(entry, "deep", worldText)
    );
    const params = reduce(plan, instance, entry.vNominal);
    const { robot, joint } = shaftOf(plan, instance).drives;
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
        variant: source.variant,
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
    const partOf = (key: "current" | "maxCurrent") => (frame: RecordedFrame) =>
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
        // Both sides, so the snapshot's own run of the scene is inside. A
        // frame's `maxCurrent` is the worst step in its window. The bound
        // is widened by the stated error: a run nearer than that is inside
        // what the snapshot already claims. The voltage is sampled only at
        // the frame, so it is not bounded.
        [`${power}.current`]: widen(
          [
            range([
              ...channel(a, partOf("current")),
              ...channel(b, partOf("current")),
            ])[0],
            range([
              ...channel(a, partOf("maxCurrent")),
              ...channel(b, partOf("maxCurrent")),
            ])[1],
          ],
          current.maxAbs
        ),
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

/**
 * The ports a group capture compares at: the type's one power input and
 * its one rotational port. A string says why the type has no such pair.
 */
export function groupPorts(
  type: PartTypeFile
): { power: string; shaft: string } | string {
  const power = onePort(type, "power", (decl) => decl.role === "power");
  if (typeof power === "string") return power;
  const shaft = onePort(
    type,
    "rotational",
    (decl) => decl.domain === "rotational"
  );
  if (typeof shaft === "string") return shaft;
  return { power: power.name, shaft: shaft.name };
}

function onePort(
  type: PartTypeFile,
  label: string,
  match: (decl: PartTypeFile["ports"][string]) => boolean
): { name: string } | string {
  const names = Object.entries(type.ports)
    .filter(([, decl]) => match(decl))
    .map(([name]) => name);
  const [name, ...more] = names;
  if (!name || more.length > 0) {
    return `${type.id} needs one ${label} port, has ${names.length}`;
  }
  return { name };
}

/**
 * Write each part and type the signature read into the fixture copy, so
 * the run reads exactly what was signed: the project's file over the
 * copy's; a catalog one by removing the copy's own shadow, with the
 * project's level overlay for it when there is one (the loader merges it
 * the same way there), and the copy's own overlay removed when not.
 */
function stage(
  root: string,
  parts: Map<string, { part: PartFile; inProject: boolean; overlay?: string }>,
  types: Map<string, { type: PartTypeFile; inProject: boolean }>,
  env: CaptureEnv
): void {
  for (const [id, found] of parts) {
    const file = refPath(env.join(root, "parts"), id, env);
    if (found.inProject) {
      writeJson(file, found.part, env);
      continue;
    }
    env.removeTree(file);
    const overlay = refPath(env.join(root, "overlays"), id, env).replace(
      /\.json$/,
      ".levels.json"
    );
    if (found.overlay) env.writeText(overlay, env.readText(found.overlay));
    else env.removeTree(overlay);
  }
  for (const [id, found] of types) {
    const file = env.join(root, "types", `${id}.json`);
    if (found.inProject) writeJson(file, found.type, env);
    else env.removeTree(file);
  }
}

/** Every slot a part's composites declare under one name, at any level. */
function slotsOf(part: PartFile, name: string): NetlistInstance[] {
  const out: NetlistInstance[] = [];
  for (const level of Object.values(part.axes?.behaviour ?? {})) {
    for (const variant of Object.values(level?.variants ?? {})) {
      if (variant.kind !== "composite") continue;
      const slot = variant.netlist.instances[name];
      if (slot) out.push(slot);
    }
  }
  return out;
}

/**
 * The scene world's text with the scene instance running the captured
 * part. When the instance already names it, the text is unchanged. Else
 * the composite that declares the instance (the world, or a part under it,
 * walked from where the loader starts paths) points it at the captured
 * part, at every level that declares it. Refused: a captured part of
 * another type, an inline instance, a path whose levels name different
 * parts, and a declaring part the scene holds more than once (each copy
 * would run the captured part, while the levels name only this path).
 */
function placeInstance(
  root: string,
  input: GroupCaptureInput,
  worldText: string,
  typeId: string,
  env: CaptureEnv
): string {
  const { entry } = input;
  const lib = { store: env.store, catalogDir: input.catalog, assetRoot: root };
  const load = (ref: string | PartFile): PartFile | null => {
    if (typeof ref !== "string") return ref;
    const found = loadPartById(root, lib, ref);
    return "part" in found ? found.part : null;
  };
  const world = JSON.parse(worldText) as PartFile;
  const run = runRootOf(world, (id) => {
    const found = load(id);
    return found ? environmentKind(found) : "other";
  });
  const where = `${entry.scene.world} instance ${entry.scene.instance}`;
  /** The one part every level of `part` names at `name`. */
  const oneRef = (part: PartFile, name: string): string | PartFile => {
    const refs = slotsOf(part, name).map((slot) => slot.part);
    const [first, ...rest] = refs;
    if (first === undefined) throw new Error(`${where} does not exist`);
    if (rest.some((ref) => ref !== first)) {
      throw new Error(
        `${where}: ${part.id} names different parts at ${name} on different levels`
      );
    }
    return first;
  };
  let holder: PartFile | null = run.unwrapped ? load(run.stage.part) : world;
  const segments = entry.scene.instance.split(".");
  const name = segments.pop() ?? "";
  for (const segment of segments) {
    holder = holder ? load(oneRef(holder, segment)) : null;
  }
  if (!holder) throw new Error(`${where} does not exist`);
  const from = oneRef(holder, name);
  if (typeof from !== "string") {
    throw new Error(`${where} is an inline part; name a part file instead`);
  }
  if (from === entry.part) return worldText;
  const was = load(from);
  const wasType = was ? input.source.typeOf(was)?.id : undefined;
  if (wasType !== typeId) {
    throw new Error(
      `${where} is a ${wasType ?? "part that did not load"}; ${entry.part} is a ${typeId}`
    );
  }
  if (holder.id !== world.id) {
    const copies = instancesOf(world, holder.id, load, new Set());
    if (copies !== 1) {
      throw new Error(
        `${where}: ${holder.id} is in the scene ${copies} times; each would run ${entry.part}`
      );
    }
  }
  for (const slot of slotsOf(holder, name)) slot.part = entry.part;
  if (holder.id === world.id) return JSON.stringify(holder);
  writeJson(refPath(env.join(root, "parts"), holder.id, env), holder, env);
  return worldText;
}

/** How many instances of `id` are under `part`, at any level. */
function instancesOf(
  part: PartFile,
  id: string,
  load: (ref: string | PartFile) => PartFile | null,
  walking: Set<string>
): number {
  if (walking.has(part.id)) return 0;
  walking.add(part.id);
  let count = 0;
  const names = new Set<string>();
  for (const level of Object.values(part.axes?.behaviour ?? {})) {
    for (const variant of Object.values(level?.variants ?? {})) {
      if (variant.kind !== "composite") continue;
      for (const name of Object.keys(variant.netlist.instances)) {
        names.add(name);
      }
    }
  }
  for (const name of names) {
    const refs = new Set(slotsOf(part, name).map((slot) => slot.part));
    for (const ref of refs) {
      if (ref === id) count += 1;
      const child = load(ref);
      if (child) count += instancesOf(child, id, load, walking);
    }
  }
  walking.delete(part.id);
  return count;
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
    play: { levels?: Selection };
  };
  const slash = world.id.indexOf("/");
  const at = world.id.lastIndexOf("@");
  const name = `${world.id.slice(slash + 1, at)}-capture-${side}`;
  world.id = `${world.id.slice(0, slash + 1)}${name}${world.id.slice(at)}`;
  world.play.levels = sideLevels(entry, side, worldText);
  const rel = `parts/${world.id.slice(0, slash)}/${name}${world.id.slice(at)}.json`;
  writeJson(env.join(root, rel), world, env);
  return rel;
}

/** The scene's levels with the instance at the side's level. */
function sideLevels(
  entry: GroupCaptureEntry,
  side: "deep" | "snap",
  worldText: string
): Selection {
  const levels = (JSON.parse(worldText) as { play?: { levels?: Selection } })
    .play?.levels ?? { default: 1 };
  return {
    ...levels,
    paths: {
      ...levels.paths,
      [entry.scene.instance]: side === "deep" ? entry.deep : entry.snap,
    },
  };
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

function widen([lo, hi]: [number, number], by: number): [number, number] {
  return [round9(lo - by), round9(hi + by)];
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function round12(n: number): number {
  return Number(n.toPrecision(12));
}
