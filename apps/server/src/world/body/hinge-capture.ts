/**
 * Capture a hinge@1 snapshot from a gear-train body on a fixture.
 * The deep side is one MuJoCo body per shaft and one joint equality per
 * mesh. The snapshot side is the rigid collapse. Nothing here is SG90-specific.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import {
  FIXTURE_FORMAT,
  type FixtureFile,
  type GearTrain,
  type PartFile,
  type PartTypeFile,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
} from "@sfab-bench/contract";

import { contentHash, sortValue } from "../parts/si";
import { lintSnapshot } from "../snapshot-lint";
import { collapse } from "./gear-train";
import { gearTrainXml, hingeXml } from "./mjcf";

const STEP_S = 0.001;

export type HingeCaptureEntry = {
  form: "hinge@1";
  id: string;
  part: string;
  fixture: string;
  baseline: { level: string; value: number };
  heldOut: "fixture";
  sourceLevel: "0" | "1" | "2" | "3";
};

export type HingeCaptureInput = {
  catalog: string;
  entry: HingeCaptureEntry;
  created: string;
  tool: { name: string; version: string };
  bench: { version: string; mujoco: string; avr8js: string };
  outFile?: string;
};

type Trace = { angle: number[]; speed: number[] };

let mujocoModule: Promise<MainModule> | null = null;

function mujoco(): Promise<MainModule> {
  if (!mujocoModule) {
    mujocoModule = import("@mujoco/mujoco").then((mod) => mod.default());
  }
  return mujocoModule;
}

export async function writeHingeSnapshot(
  input: HingeCaptureInput
): Promise<void> {
  const part = readPart(input.catalog, input.entry.part);
  const train = gearTrainOf(part, input.entry.sourceLevel);
  const typeId = typeof part.type === "string" ? part.type : part.type.id;
  const type = readType(input.catalog, typeId);
  const fixturePath = join(
    input.catalog,
    "fixtures",
    `${input.entry.fixture}.fixture.json`
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;
  if (fixture.format !== FIXTURE_FORMAT) {
    throw new Error(`${input.entry.fixture} is not ${FIXTURE_FORMAT}`);
  }
  const hinge = collapse(train);
  const cases = casesOf(fixture);
  const mj = await mujoco();
  let maxAbs = 0;
  let worstRms = 0;
  let rise = 0;
  let sawStep = false;
  let speedLo = Number.POSITIVE_INFINITY;
  let speedHi = Number.NEGATIVE_INFINITY;
  let torqueLo = Number.POSITIVE_INFINITY;
  let torqueHi = Number.NEGATIVE_INFINITY;
  for (const item of cases) {
    const steps = Math.round(fixture.duration / STEP_S);
    const torque = (t: number) => signalAt(item.input, t, fixture.duration);
    const deep = simulate(
      mj,
      gearTrainXml(train, item.inertia, STEP_S),
      train.output,
      torque,
      steps
    );
    const snap = simulate(
      mj,
      hingeXml(hinge, item.inertia, STEP_S),
      "output",
      torque,
      steps
    );
    const abs = maxAbsDiff(deep.angle, snap.angle);
    const rms = rmsDiff(deep.angle, snap.angle);
    if (abs > maxAbs) maxAbs = abs;
    if (rms > worstRms) worstRms = rms;
    if (item.input.signal === "step") {
      const deepRise = riseTime(deep.angle, STEP_S);
      const snapRise = riseTime(snap.angle, STEP_S);
      if (deepRise === null || snapRise === null) {
        throw new Error(
          `${input.entry.part} step at inertia ${item.inertia} did not cover 10–90%`
        );
      }
      const delta = Math.abs(snapRise - deepRise);
      if (!sawStep || delta > rise) rise = delta;
      sawStep = true;
    }
    for (const trace of [deep, snap]) {
      for (const speed of trace.speed) {
        if (speed < speedLo) speedLo = speed;
        if (speed > speedHi) speedHi = speed;
      }
    }
    for (let k = 0; k < steps; k++) {
      const applied = torque(k * STEP_S);
      if (applied < torqueLo) torqueLo = applied;
      if (applied > torqueHi) torqueHi = applied;
    }
  }
  if (!sawStep) throw new Error(`${input.entry.fixture} has no torque step`);
  const ratings = part.ratings?.shaft;
  const speedRating = pair(ratings?.speed);
  const torqueRating = pair(ratings?.torque);
  if (!speedRating || !torqueRating) {
    throw new Error(
      `${input.entry.part} shaft has no speed and torque ratings`
    );
  }
  if (
    speedLo > speedRating[0] ||
    speedHi < speedRating[1] ||
    torqueLo > torqueRating[0] ||
    torqueHi < torqueRating[1]
  ) {
    throw new Error(
      `${input.entry.part} fixture did not reach the shaft ratings ` +
        `(speed ${speedLo}..${speedHi}, torque ${torqueLo}..${torqueHi})`
    );
  }
  const speedBound = clipToRating(speedLo, speedHi, speedRating);
  const torqueBound = clipToRating(torqueLo, torqueHi, torqueRating);
  const snap: SnapshotFile = {
    format: SNAPSHOT_FORMAT,
    partType: typeId,
    part: part.id,
    axis: "body",
    form: "hinge@1",
    ports: shaftPorts(type),
    params: {
      armature: hinge.armature,
      damping: hinge.damping,
      frictionloss: hinge.frictionloss,
    },
    envelope: {
      bounds: {
        [`${shaftName(type)}.speed`]: speedBound,
        [`${shaftName(type)}.torque`]: torqueBound,
      },
    },
    error: [
      {
        metric: "free-run-max-abs",
        quantity: `${shaftName(type)}.angle`,
        value: round9(maxAbs),
        heldOut: input.entry.heldOut,
        baseline: input.entry.baseline,
      },
      {
        metric: "free-run-rms",
        quantity: `${shaftName(type)}.angle`,
        value: round9(worstRms),
        heldOut: input.entry.heldOut,
        baseline: input.entry.baseline,
      },
      {
        metric: "step-rise",
        quantity: `${shaftName(type)}.angle`,
        value: round9(rise),
        heldOut: input.entry.heldOut,
        baseline: input.entry.baseline,
      },
    ],
    quality: "Q2a",
    provenance: {
      source: "captured",
      from: {
        part: part.id,
        level: input.entry.sourceLevel,
        hash: contentHash(train),
      },
      fixture: {
        ref: input.entry.fixture,
        hash: contentHash(fixture),
        seed: fixture.seed,
      },
      tool: input.tool,
      bench: input.bench,
      created: input.created,
    },
  };
  const lint = lintSnapshot(snap, {
    plausible: type.plausible,
    ports: type.ports,
    ...(type.requiredOutputs ? { requiredOutputs: type.requiredOutputs } : {}),
  });
  if (lint.diagnostics.length > 0 || lint.quality !== "Q2a") {
    throw new Error(
      `hinge lint ${lint.quality}: ${lint.diagnostics.map((d) => d.message).join("; ")}`
    );
  }
  snap.quality = lint.quality;
  const out = input.outFile ?? snapshotPath(input.catalog, input.entry.id);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(sortValue(snap), null, 2)}\n`);
}

function gearTrainOf(
  part: PartFile,
  level: string
): GearTrain & { omits: string[]; kind: "gear-train" } {
  const slot = part.axes?.body?.[level as "2"];
  const impl = slot ? slot.variants[slot.default] : undefined;
  if (!impl || impl.kind !== "gear-train") {
    throw new Error(`${part.id} class ${level} body is not a gear train`);
  }
  return impl;
}

function shaftName(type: PartTypeFile): string {
  const found = Object.entries(type.ports).find(
    ([, decl]) => decl.domain === "rotational" && decl.direction === "out"
  );
  if (!found) throw new Error(`${type.id} has no rotational output`);
  return found[0];
}

function shaftPorts(type: PartTypeFile): SnapshotFile["ports"] {
  const name = shaftName(type);
  return { inputs: [`${name}.torque`], outputs: [`${name}.angle`] };
}

function casesOf(
  fixture: FixtureFile
): { inertia: number; input: FixtureFile["inputs"][number] }[] {
  const sweep = fixture.sweeps.find((row) => row.quantity === "Inertia");
  const mount =
    fixture.mount !== "clamped" ? fixture.mount.load.inertia : undefined;
  const inertias = sweep?.values ?? (mount !== undefined ? [mount] : []);
  if (inertias.length === 0) throw new Error("fixture has no load inertia");
  const port = fixture.inputs[0]?.port;
  if (!port || !fixture.record.includes(`${port}.angle`)) {
    throw new Error("fixture must record the driven shaft angle");
  }
  const out: { inertia: number; input: FixtureFile["inputs"][number] }[] = [];
  for (const inertia of inertias) {
    for (const input of fixture.inputs) out.push({ inertia, input });
  }
  return out;
}

function signalAt(
  input: FixtureFile["inputs"][number],
  t: number,
  duration: number
): number {
  const amplitude = input.params.amplitude ?? 0;
  if (input.signal === "step") {
    const t0 = input.params.t0 ?? 0;
    const width = input.params.width;
    if (t < t0) return 0;
    if (width !== undefined && t >= t0 + width) return 0;
    return amplitude;
  }
  if (input.signal === "chirp") {
    const f0 = input.params.f0 ?? 0;
    const f1 = input.params.f1 ?? f0;
    const phase =
      2 *
      Math.PI *
      (f0 * t + ((f1 - f0) * t * t) / (2 * Math.max(duration, STEP_S)));
    return amplitude * Math.sin(phase);
  }
  throw new Error(`fixture signal ${input.signal} is not a hinge capture`);
}

function simulate(
  mj: MainModule,
  xml: string,
  joint: string,
  torque: (t: number) => number,
  steps: number
): Trace {
  const spec = mj.parseXMLString(xml);
  const parseError = mj.mjs_getError(spec);
  if (parseError) throw new Error(parseError);
  const model = mj.mj_compile(spec);
  const data = new mj.MjData(model);
  try {
    const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, joint);
    if (jid < 0) throw new Error(`joint ${joint} is missing`);
    const qadr = (model.jnt_qposadr as Int32Array)[jid] ?? -1;
    const vadr = (model.jnt_dofadr as Int32Array)[jid] ?? -1;
    if (qadr < 0 || vadr < 0) throw new Error(`joint ${joint} has no dof`);
    const angle: number[] = [];
    const speed: number[] = [];
    const qpos = data.qpos as Float64Array;
    const qvel = data.qvel as Float64Array;
    const applied = data.qfrc_applied as Float64Array;
    for (let k = 0; k < steps; k++) {
      applied[vadr] = torque(k * STEP_S);
      mj.mj_step(model, data);
      angle.push(qpos[qadr] ?? 0);
      speed.push(qvel[vadr] ?? 0);
    }
    return { angle, speed };
  } finally {
    free(data);
    free(model);
    free(spec);
  }
}

function free(obj: MjModel | MjData | { delete?: () => void }): void {
  obj.delete?.();
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const err = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (err > max) max = err;
  }
  return max;
}

function rmsDiff(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const err = (a[i] ?? 0) - (b[i] ?? 0);
    sum += err * err;
  }
  return Math.sqrt(sum / n);
}

/** 10–90% of this trace's own start-to-end change, seconds. */
function riseTime(angle: readonly number[], dt: number): number | null {
  const q0 = angle[0];
  const command = angle[angle.length - 1];
  if (q0 === undefined || command === undefined) return null;
  const delta = command - q0;
  if (Math.abs(delta) < 1e-15) return 0;
  const dir = Math.sign(delta);
  const lo = q0 + 0.1 * delta;
  const hi = q0 + 0.9 * delta;
  let tLo: number | null = null;
  let tHi: number | null = null;
  for (let i = 1; i < angle.length; i++) {
    const prev = angle[i - 1] ?? 0;
    const next = angle[i] ?? 0;
    if (tLo === null && (prev - lo) * dir < 0 && (next - lo) * dir >= 0) {
      tLo = lerp(i, prev, next, lo, dt);
    }
    if (
      tLo !== null &&
      tHi === null &&
      (prev - hi) * dir < 0 &&
      (next - hi) * dir >= 0
    ) {
      tHi = lerp(i, prev, next, hi, dt);
      break;
    }
  }
  if (tLo === null || tHi === null) return null;
  return tHi - tLo;
}

function lerp(
  index: number,
  prev: number,
  next: number,
  level: number,
  dt: number
): number {
  const span = next - prev;
  const frac = span === 0 ? 0 : (level - prev) / span;
  return (index - 1 + frac) * dt;
}

/** Observed range, pulled back inside the rating when a case ran past it. */
function clipToRating(
  lo: number,
  hi: number,
  rating: [number, number]
): [number, number] {
  return [Math.max(lo, rating[0]), Math.min(hi, rating[1])];
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function readPart(catalog: string, id: string): PartFile {
  return JSON.parse(readFileSync(partPath(catalog, id), "utf8")) as PartFile;
}

function readType(catalog: string, id: string): PartTypeFile {
  return JSON.parse(
    readFileSync(join(catalog, "types", `${id}.json`), "utf8")
  ) as PartTypeFile;
}

function partPath(catalog: string, id: string): string {
  const slash = id.indexOf("/");
  const at = id.lastIndexOf("@");
  return join(
    catalog,
    "parts",
    id.slice(0, slash),
    `${id.slice(slash + 1, at)}@${id.slice(at + 1)}.json`
  );
}

function snapshotPath(catalog: string, id: string): string {
  const slash = id.indexOf("/");
  const at = id.lastIndexOf("@");
  return join(
    catalog,
    "snapshots",
    id.slice(0, slash),
    `${id.slice(slash + 1, at)}@${id.slice(at + 1)}.json`
  );
}
