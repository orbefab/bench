/**
 * What the board goldens keep of a run, as a trace: every recorded frame
 * field as a channel, every recorded event, the serial text per board, the
 * state at named checkpoints, and the warnings. Boards keep their ids.
 */

import type { RecordingRead, WorldState } from "@sfab-bench/contract";

import {
  channelsOf,
  type Discrete,
  leaves,
  REGRESSION_TOL,
  TRACE_FORMAT,
  type Trace,
} from "./trace";

type Warning = {
  severity: string;
  code?: string;
  message: string;
  path?: string;
};

/** The state fields a checkpoint keeps, by leaf path. */
export function stateSample(state: WorldState): Record<string, Discrete> {
  return Object.fromEntries(
    leaves({
      simTime: state.simTime,
      poses: state.poses,
      joints: state.joints,
      boards: state.boards,
      parts: state.parts,
      supplies: state.supplies,
      diagnostics: (state.diagnostics ?? []).map((row) => ({
        severity: row.severity,
        code: row.code,
        message: row.message,
        path: row.path,
      })),
    })
  );
}

export function warningLines(warnings: readonly Warning[]): string[] {
  return warnings.map(
    (row) =>
      `${row.severity} ${row.code ?? "-"}${row.path ? ` ${row.path}` : ""}: ${row.message}`
  );
}

export function recordingTrace(opts: {
  source: string;
  read: RecordingRead;
  serial: Record<string, string>;
  samples: Record<string, Record<string, Discrete>>;
  warnings: readonly Warning[];
}): Trace {
  return {
    format: TRACE_FORMAT,
    source: opts.source,
    tol: REGRESSION_TOL,
    ...channelsOf(opts.read.frames),
    events: opts.read.events,
    text: opts.serial,
    notes: warningLines(opts.warnings),
    samples: opts.samples,
  };
}
