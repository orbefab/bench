/** Session helpers every domain uses: the host post, the held failure, and the sim clock in milliseconds. */

import {
  DEFAULT_TIMESTEP_S,
  type WorldError,
  type WorldSender,
} from "@sfab-bench/contract";
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

/** Master steps since t = 0: MuJoCo's time is a float sum of steps. */
export function stepCount(s: SessionState): number {
  if (!s.sim) return 0;
  return Math.round(s.sim.data.time * 1000 * s.perMs);
}

/** Whole simulated milliseconds: the clock events and frames key on. */
export function simMs(s: SessionState): number {
  return Math.floor(stepCount(s) / s.perMs);
}

/** Simulated milliseconds at the end of the step in progress. */
export function stepEndMs(s: SessionState): number {
  return (stepCount(s) + 1) / s.perMs;
}

/** The master step in seconds. */
export function stepS(s: SessionState): number {
  return DEFAULT_TIMESTEP_S / s.perMs;
}

export function noteCommand(
  s: SessionState,
  kind: "play" | "pause",
  by?: WorldSender
) {
  if (!by || !s.recorder) return;
  s.recorder.noteEvent({ timeMs: simMs(s), kind, by });
}
