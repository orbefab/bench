import { ok as expect } from "node:assert/strict";
import type { WorldClientMessage } from "@sfab-bench/contract";

import {
  bindWorldSocket,
  noteLiveRecording,
  scrubTo,
  takeTimelineError,
  worldTimelineSnapshot,
} from "./world-timeline";

/**
 * The strip catches a paused edge, and a failed seek does not stick.
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const sent: WorldClientMessage[] = [];
bindWorldSocket((message) => {
  sent.push(message);
});

function seeks(): Extract<WorldClientMessage, { type: "seek" }>[] {
  return sent.filter(
    (message): message is Extract<WorldClientMessage, { type: "seek" }> =>
      message.type === "seek"
  );
}

function timelines(): Extract<WorldClientMessage, { type: "timeline" }>[] {
  return sent.filter(
    (message): message is Extract<WorldClientMessage, { type: "timeline" }> =>
      message.type === "timeline"
  );
}

noteLiveRecording({ id: "r1", from: 0, to: 1 }, true);
await flush();
expect(
  timelines().some((message) => message.to === 1),
  "opening a recording asks for the strip"
);
expect(worldTimelineSnapshot().recording?.to === 1, "the strip shows the edge");

sent.length = 0;
noteLiveRecording({ id: "r1", from: 0, to: 1.05 }, true);
await flush();
expect(sent.length === 0, "0.05 s of play does not refetch");
expect(
  worldTimelineSnapshot().recording?.to === 1,
  "the drawn edge stays until the strip publishes"
);

noteLiveRecording({ id: "r1", from: 0, to: 1.05 }, false);
await flush();
expect(
  timelines().some((message) => message.to === 1.05),
  "pausing publishes the tail at once"
);
expect(worldTimelineSnapshot().recording?.to === 1.05, "the strip caught up");

sent.length = 0;
noteLiveRecording({ id: "r2", from: 0, to: 2 }, false);
await flush();
scrubTo(0.4);
scrubTo(1.2);
const first = seeks();
expect(first.length === 1, "a second drag waits on the seek in flight");
const nonce = first[0]?.nonce;
expect(nonce, "the seek has a nonce");
if (!nonce) throw new Error("unreachable");
takeTimelineError({
  type: "timeline-error",
  message: "recording did not answer",
  nonce: "someone-else",
});
expect(seeks().length === 1, "another nonce does not retire this seek");
takeTimelineError({
  type: "timeline-error",
  message: "recording did not answer",
  nonce,
});
expect(seeks().length === 2, "the failed seek sends the one that was waiting");
expect(seeks()[1]?.t === 1.2, `queued seek was ${seeks()[1]?.t}`);

sent.length = 0;
noteLiveRecording({ id: "r3", from: 0, to: 2 }, true);
scrubTo(0.4);
takeTimelineError({
  type: "timeline-error",
  message: "timeline failed",
});
scrubTo(0.8);
expect(
  seeks().length === 1,
  "a timeline failure does not drop the seek that is in flight"
);

bindWorldSocket(null);

console.log("world-timeline.selfcheck ok");
