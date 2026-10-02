/** Session helpers every domain uses: the host post, the held failure, and the sim clock in milliseconds. */

import type { WorldError, WorldSender } from "@sfab-bench/contract";
import type { FromWorker } from "../sim";
import type { SessionState } from "./state";

export function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function post(s: SessionState, message: FromWorker) {
  s.host.post(message);
}

export function fail(s: SessionState, errors: WorldError[], message?: string) {
  s.failure = message !== undefined ? { errors, message } : { errors };
  post(s, {
    type: "error",
    generation: s.generation,
    errors,
    ...(message ? { message } : {}),
  });
}

export function simMs(s: SessionState): number {
  if (!s.sim) return 0;
  return Math.round(s.sim.data.time * 1000);
}

export function noteCommand(
  s: SessionState,
  kind: "play" | "pause",
  by?: WorldSender
) {
  if (!by || !s.recorder) return;
  s.recorder.noteEvent({ timeMs: simMs(s), kind, by });
}
