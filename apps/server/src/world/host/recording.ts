/** Recording queries answered by the worker: info, read, frame, timeline, and the ADC trace. */

import type {
  RecordedFrame,
  RecordingInfo,
  RecordingRead,
  WorldPinState,
  WorldServerMessage,
} from "@sfab-bench/contract";
import type { CpuResetRegs } from "@sfab-bench/engine-mcu";
import type { AdcTrace, RecordBody, RecordQuery, ToWorker } from "../worker";
import { type Doc, START_MS } from "./doc";
import { docKey, docs } from "./registry";

function ask(doc: Doc, query: RecordQuery): Promise<RecordBody> {
  const worker = doc.worker;
  if (!worker || !doc.lastState || (doc.errors && doc.errors.length > 0)) {
    return Promise.resolve({
      op: "error",
      message: doc.errorMessage ?? "world is not running",
    });
  }
  const request = doc.requestSeq + 1;
  doc.requestSeq = request;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      doc.pending.delete(request);
      resolve({ op: "error", message: "recording did not answer" });
    }, START_MS);
    doc.pending.set(request, { resolve, timer });
    try {
      worker.postMessage({
        type: "record",
        generation: doc.generation,
        request,
        query,
      } satisfies ToWorker);
    } catch (err: unknown) {
      clearTimeout(timer);
      doc.pending.delete(request);
      const message = err instanceof Error ? err.message : "recording failed";
      resolve({ op: "error", message });
    }
  });
}

export function runningDoc(
  project: string,
  worldRel: string
): Doc | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.worker || !doc.lastState) return { error: "world is not running" };
  if (doc.errors && doc.errors.length > 0) {
    return { error: doc.errorMessage ?? "world failed to load" };
  }
  return doc;
}

export async function seekDoc(
  doc: Doc,
  t: number,
  nonce: string
): Promise<Extract<WorldServerMessage, { type: "frame" }> | { error: string }> {
  const body = await ask(doc, { op: "frame", t });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "frame") return { error: "recording did not answer" };
  return {
    type: "frame",
    recording: body.id,
    t: body.frame?.t ?? t,
    frame: body.frame,
    nonce,
  };
}

export async function timelineDoc(
  doc: Doc,
  query: { from: number; to: number; maxPoints: number; tracks?: string[] }
): Promise<
  Extract<WorldServerMessage, { type: "timeline-data" }> | { error: string }
> {
  const maxPoints = Math.max(1, Math.min(4000, Math.floor(query.maxPoints)));
  const body = await ask(doc, {
    op: "timeline",
    from: query.from,
    to: query.to,
    maxPoints,
    ...(query.tracks ? { tracks: query.tracks } : {}),
  });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "timeline") return { error: "recording did not answer" };
  return {
    type: "timeline-data",
    recording: body.id,
    from: body.from,
    to: body.to,
    tracks: body.tracks,
    markers: body.markers,
    ...(body.unrecorded ? { unrecorded: body.unrecorded } : {}),
  };
}

/**
 * Registers and pin levels taken at the latest brownout reboot, before
 * that CPU executed an instruction. Null when this board has not rebooted.
 */
export function brownoutBootSnapshot(
  project: string,
  worldRel: string,
  board: string
): { regs: CpuResetRegs; pins: WorldPinState } | null {
  const named = docKey(project, worldRel);
  if ("error" in named) return null;
  return docs.get(named.key)?.bootSnap.get(board) ?? null;
}

/** What this document is recording. W6 reads this; the socket does too. */
export async function recordingInfo(
  project: string,
  worldRel: string
): Promise<RecordingInfo | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "info" });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "info") return { error: "recording did not answer" };
  return body.info;
}

/**
 * Frames and events in `[from, to]`, seconds of sim time.
 * `maxFrames` picks real frames and keeps the extremes of the ones it skips.
 */
export async function readRecording(
  project: string,
  worldRel: string,
  query: {
    from: number;
    to: number;
    tracks?: string[];
    maxFrames?: number;
  }
): Promise<RecordingRead | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "read", ...query });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "read") return { error: "recording did not answer" };
  return body.read;
}

/**
 * Test only. Board nodes and ADC samples for a run opened with `adcTrace`.
 * A sample's `ms` is the step it completed in. Its reference is the board
 * node stamped at `ms - 1`, except a CPU that booted in that same quantum.
 * Without the option the worker answers "ADC trace is off".
 */
export async function readAdcTrace(
  project: string,
  worldRel: string
): Promise<AdcTrace | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "adc" });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "adc") return { error: "recording did not answer" };
  return body.trace;
}

/** The full frame at or before `t` seconds. Null when that time was dropped. */
export async function frameAt(
  project: string,
  worldRel: string,
  t: number
): Promise<RecordedFrame | null | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "frame", t });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "frame") return { error: "recording did not answer" };
  return body.frame;
}

/** Test-only. Keep this many milliseconds of sim time instead of 10 minutes. */
export async function setRecordingBound(
  project: string,
  worldRel: string,
  boundMs: number
): Promise<{ ok: true } | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "config", boundMs });
  if (body.op === "error") return { error: body.message };
  return { ok: true };
}

/** Test-only. The lockstep loop skips the recorder while this is false. */
export async function setRecordingEnabled(
  project: string,
  worldRel: string,
  enabled: boolean
): Promise<{ ok: true } | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "config", enabled });
  if (body.op === "error") return { error: body.message };
  return { ok: true };
}
