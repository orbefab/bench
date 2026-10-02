/**
 * Parking a part tab drops this client's live run. A playing run asks
 * first. Mid-capture uses the same ask; nothing sets that flag until A6.
 */

export type ParkPhase = "playing" | "paused" | "idle";

export type ParkChoice = "stay" | "stop";

/**
 * `captureInFlight` is the A6 hook. Pass true while a capture runs.
 * The editor passes false until that UI exists.
 */
export function parkGuard(
  phase: ParkPhase,
  captureInFlight = false
): "ask" | "go" {
  if (captureInFlight || phase === "playing") return "ask";
  return "go";
}

/** Stay changes nothing. Stop pauses, then the switch or close proceeds. */
export function parkOutcome(choice: ParkChoice): "stay" | "stop-and-continue" {
  return choice === "stay" ? "stay" : "stop-and-continue";
}

export function runPhase(input: {
  playing: boolean;
  /** A run has time or a recording extent, and it is not playing. */
  started: boolean;
}): ParkPhase {
  if (input.playing) return "playing";
  if (input.started) return "paused";
  return "idle";
}
