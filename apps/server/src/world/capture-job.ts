/**
 * The socket's capture job: the same runner as `pnpm capture`, one job per
 * world. The runner writes to a temp file; only a finished snapshot lands,
 * as an `add-capture` edit through the normal edit path.
 */
import { join } from "node:path";

import type {
  AxisName,
  CaptureAxisName,
  EditOp,
  PartFile,
  WorldServerMessage,
} from "@sfab-bench/contract";
import {
  editLabel,
  loadWorldV2,
  nextCaptureRef,
  partFilePath,
} from "@sfab-bench/parts";
import {
  CaptureAborted,
  type CaptureEntry,
  type CaptureFile,
  captureFromConfig,
} from "@sfab-bench/sim/capture";
import {
  captureLevelFor,
  captureRecipeFor,
} from "@sfab-bench/sim/capture-recipe";

import { serverCaptureEnv } from "../capture-host";
import { applyDocumentEdit } from "./edit";
import { absolutePath, nodeStore } from "./node-store";
import { catalogRoot, nodeStampEnv } from "./plan-host";

export type CaptureRequest = {
  nonce: string;
  path: string;
  axis: CaptureAxisName;
};

type Job = { nonce: string; owner: unknown; controller: AbortController };

const jobs = new Map<string, Job>();
const PROGRESS_MS = 250;

function jobKey(project: string, world: string): string {
  return `${project}\0${world}`;
}

/** Reads the part the path names in the open document, as it is now. */
function partAtInstance(
  project: string,
  world: string,
  path: string
): { part: PartFile } | { error: string } {
  const root = absolutePath(project);
  const file = absolutePath(join(root, world));
  if (!nodeStore.exists(file)) return { error: `no document ${world}` };
  const loaded = loadWorldV2(file, {
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: root,
  });
  const inst = loaded.resolved.find((item) => item.path === path);
  if (!inst) return { error: `no instance ${path}` };
  return { part: inst.part };
}

/** The catalog config's stamp, so a card capture and the CLI write the same provenance. */
function captureFileFor(recipe: CaptureEntry, catalog: string): CaptureFile {
  const file = join(catalog, "fixtures", "capture.config.json");
  const base = nodeStore.exists(file)
    ? (JSON.parse(nodeStore.readText(file)) as Partial<CaptureFile>)
    : {};
  return {
    created: base.created ?? "2026-09-27T00:00:00.000Z",
    tool: base.tool ?? { name: "sfab-bench-capture", version: "1" },
    entries: [recipe],
  };
}

/** The omits the level's existing snapshots already state. */
function omitsAt(part: PartFile, axis: AxisName, level: string): string[] {
  const slot = part.axes?.[axis]?.[level as "0"];
  const out: string[] = [];
  for (const variant of Object.values(slot?.variants ?? {})) {
    if (variant.kind !== "snapshot") continue;
    for (const item of variant.omits ?? []) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.length > 0 ? out : ["dynamic response"];
}

async function run(
  project: string,
  world: string,
  request: CaptureRequest,
  job: Job,
  emit: (event: WorldServerMessage) => void
): Promise<WorldServerMessage> {
  const failed = (message: string): WorldServerMessage => ({
    type: "capture-failed",
    nonce: request.nonce,
    message,
  });
  const found = partAtInstance(project, world, request.path);
  if ("error" in found) return failed(found.error);
  const part = found.part;
  const root = absolutePath(project);
  const own = partFilePath(root, part.id);
  const inProject = Boolean(own && nodeStore.exists(own));
  const catalog = absolutePath(catalogRoot());
  const recipe = captureRecipeFor(part, request.axis, {
    catalogDir: catalog,
    store: nodeStore,
    join,
  });
  if (!recipe)
    return failed(`${part.id} has no ${request.axis} capture recipe`);
  const level = captureLevelFor(part, request.axis, recipe);
  if ("error" in level) return failed(level.error);
  const ref = nextCaptureRef(nodeStore, root, part.id, request.axis);
  const number = ref?.match(/-(\d+)@/)?.[1];
  if (!ref || !number) return failed(`${part.id} is not a part id`);
  const variant = `capture-${number}`;

  const projectFixture = recipe.sweep.fixture
    ? join(root, "fixtures", `${recipe.sweep.fixture}.fixture.json`)
    : null;
  const tmp = serverCaptureEnv.makeTemp("sfab-capture-out-");
  let snapshot: string;
  try {
    const out = join(tmp, "snapshot.json");
    let last = 0;
    await captureFromConfig(
      {
        config: captureFileFor(recipe, catalog),
        catalogDir: catalog,
        ...(inProject ? { libraryDir: root } : {}),
        ...(projectFixture && nodeStore.exists(projectFixture)
          ? { fixtureFile: projectFixture }
          : {}),
        outFile: out,
        signal: job.controller.signal,
        onStep(done, total, label) {
          const now = Date.now();
          if (done < total && now - last < PROGRESS_MS) return;
          last = now;
          emit({
            type: "capture-progress",
            nonce: request.nonce,
            done,
            total,
            label,
          });
        },
      },
      serverCaptureEnv,
      nodeStampEnv
    );
    snapshot = serverCaptureEnv.readText(out);
  } catch (err) {
    if (err instanceof CaptureAborted) return failed("aborted");
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    serverCaptureEnv.removeTree(tmp);
  }
  if (job.controller.signal.aborted) return failed("aborted");

  const op: EditOp = {
    kind: "add-capture",
    document: inProject ? part.id : world,
    part: part.id,
    axis: request.axis,
    level: Number(level.level) as 0 | 1 | 2 | 3,
    variant,
    ref,
    snapshot,
    omits: omitsAt(part, request.axis, level.level),
  };
  const landed = await applyDocumentEdit(
    project,
    world,
    [op],
    editLabel(op),
    inProject ? part.id : undefined
  );
  if ("needsConfirm" in landed)
    return failed(landed.message ?? "needs confirmation");
  if ("error" in landed) return failed(landed.error);
  return {
    type: "captured",
    nonce: request.nonce,
    path: request.path,
    axis: request.axis,
    level: op.level,
    variant,
    ref,
  };
}

/** Starts the job. Every reply, refusal included, goes through `emit`. */
export function startCapture(
  project: string,
  world: string,
  request: CaptureRequest,
  owner: unknown,
  emit: (event: WorldServerMessage) => void
): void {
  const key = jobKey(project, world);
  if (jobs.has(key)) {
    emit({
      type: "capture-failed",
      nonce: request.nonce,
      message: "a capture is already running for this world",
    });
    return;
  }
  const job: Job = {
    nonce: request.nonce,
    owner,
    controller: new AbortController(),
  };
  jobs.set(key, job);
  void run(project, world, request, job, emit)
    .catch(
      (err: unknown): WorldServerMessage => ({
        type: "capture-failed",
        nonce: request.nonce,
        message: err instanceof Error ? err.message : String(err),
      })
    )
    .then((event) => {
      jobs.delete(key);
      emit(event);
    });
}

/** False when no running job has this nonce. */
export function abortCapture(
  project: string,
  world: string,
  nonce: string
): boolean {
  const job = jobs.get(jobKey(project, world));
  if (!job || job.nonce !== nonce) return false;
  job.controller.abort();
  return true;
}

/** A closed socket takes its job with it. */
export function abortCaptureOf(owner: unknown): void {
  for (const job of jobs.values()) {
    if (job.owner === owner) job.controller.abort();
  }
}
