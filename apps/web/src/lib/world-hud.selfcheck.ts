import { ok as expect } from "node:assert/strict";
import { decideHudSample } from "./world-hud";

const INTERVAL = 200;

type Sample = { t: number; playing: boolean; id: string };

/**
 * The hook's rule, without timers: one flush at the end of the open
 * window, carrying the latest skipped sample. A publish cancels it.
 */
function replay(samples: readonly Sample[]): {
  published: string[];
  pending: string | null;
  flushAt: number | null;
} {
  let lastPublish = 0;
  let live = false;
  let playing = false;
  let flushAt: number | null = null;
  let pending: string | null = null;
  const published: string[] = [];

  const fireDueFlush = (t: number) => {
    if (flushAt === null || pending === null || t < flushAt) return;
    published.push(pending);
    lastPublish = flushAt;
    pending = null;
    flushAt = null;
    live = true;
  };

  for (const sample of samples) {
    fireDueFlush(sample.t);
    const decision = decideHudSample({
      now: sample.t,
      lastPublish,
      intervalMs: INTERVAL,
      live,
      playingChanged: live && sample.playing !== playing,
    });
    playing = sample.playing;
    if (decision.publishNow) {
      published.push(sample.id);
      lastPublish = sample.t;
      live = true;
      pending = null;
      flushAt = null;
      continue;
    }
    pending = sample.id;
    if (flushAt === null) flushAt = decision.flushAt;
  }
  return { published, pending, flushAt };
}

const pausedStep = replay([
  { t: 0, playing: false, id: "attach" },
  { t: 50, playing: false, id: "step" },
]);
expect(
  pausedStep.published.join(",") === "attach",
  `the step inside the window is not written yet, got ${pausedStep.published.join(",")}`
);
expect(pausedStep.pending === "step", "the skipped step is the pending sample");
expect(pausedStep.flushAt === 200, `flush at 200, got ${pausedStep.flushAt}`);

const afterFlush = replay([
  { t: 0, playing: false, id: "attach" },
  { t: 50, playing: false, id: "step" },
  { t: 200, playing: false, id: "quiet" },
]);
expect(
  afterFlush.published.join(",") === "attach,step",
  `the skipped step flushes at the end of the window, got ${afterFlush.published.join(",")}`
);

const playing = replay(
  Array.from({ length: 26 }, (_, i) => ({
    t: i * 40,
    playing: true,
    id: `p${i * 40}`,
  }))
);
expect(
  playing.published.length < 10,
  `playing stays throttled, published ${playing.published.length} of 26`
);
expect(
  playing.published[0] === "p0",
  `first playing sample is immediate, got ${playing.published[0]}`
);
expect(
  !playing.published.includes("p40") && !playing.published.includes("p80"),
  "samples inside the window are not published immediately"
);

const pauseInside = replay([
  { t: 0, playing: true, id: "play" },
  { t: 40, playing: false, id: "pause" },
]);
expect(
  pauseInside.published.join(",") === "play,pause",
  "a play/pause change publishes immediately"
);
expect(pauseInside.pending === null, "an immediate publish cancels the flush");

console.log("world-hud.selfcheck ok");
