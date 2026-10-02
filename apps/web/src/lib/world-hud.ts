export type HudSampleInput = {
  now: number;
  /** Time of the previous store write. Ignored until `live` is true. */
  lastPublish: number;
  intervalMs: number;
  /** False until the first sample has been written to the store. */
  live: boolean;
  /** Play/pause flipped since the sample already in the store. */
  playingChanged: boolean;
};

export type HudSampleDecision = {
  /** Write this sample now. */
  publishNow: boolean;
  /**
   * When this sample is skipped, publish the latest skipped sample at
   * this time. The window stays anchored to `lastPublish`: a later skip
   * keeps the earlier flush time and only replaces the payload.
   */
  flushAt: number | null;
};

/**
 * While the run is live, the inspector updates at most once per interval.
 * A sample inside the window is not dropped: it is held for a single flush
 * at the end of that window, which is what a paused step or a firmware
 * reload needs when it is the last message.
 */
export function decideHudSample(input: HudSampleInput): HudSampleDecision {
  if (!input.live || input.playingChanged) {
    return { publishNow: true, flushAt: null };
  }
  if (input.now - input.lastPublish >= input.intervalMs) {
    return { publishNow: true, flushAt: null };
  }
  return {
    publishNow: false,
    flushAt: input.lastPublish + input.intervalMs,
  };
}
