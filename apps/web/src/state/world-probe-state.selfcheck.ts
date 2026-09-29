import type { WorldClientMessage } from "@sfab-bench/contract";

import { bindSceneInvalidate } from "@/scene/invalidate";
import { worldStore } from "./world";
import {
  clearProbes,
  probedPorts,
  setProbes,
  toggleProbePort,
} from "./world-probe";
import {
  bindWorldSocket,
  noteLiveRecording,
  restoreTimeline,
  takeTimeline,
  worldTimelineSnapshot,
} from "./world-timeline";

/**
 * The probe list is client state per part tab. A pick asks the server for
 * the port's tracks; a removal asks for nothing; a stopped run is never asked.
 */

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

let frames = 0;
bindSceneInvalidate(() => {
  frames += 1;
});

const sent: WorldClientMessage[] = [];
bindWorldSocket((message) => {
  sent.push(message);
});
function timelines(): Extract<WorldClientMessage, { type: "timeline" }>[] {
  return sent.filter(
    (message): message is Extract<WorldClientMessage, { type: "timeline" }> =>
      message.type === "timeline"
  );
}

worldStore.getState().retargetDocument("parts/sfab/arm-bench@1.0.0.json");
noteLiveRecording({ id: "r1", from: 0, to: 1 }, false);
await flush();
expect(timelines().length === 1, "the recording asks for the strip");
expect(
  !("tracks" in (timelines()[0] ?? {})),
  "with nothing probed the request names no tracks"
);

// A pick adds the port, asks for it at once, and asks for a frame.
sent.length = 0;
frames = 0;
toggleProbePort("port:servo.signal");
expect(probedPorts().join(",") === "port:servo.signal", "a pick adds");
expect(frames === 1, "a pick redraws the marker");
await flush();
expect(
  timelines().length === 1 &&
    timelines()[0]?.tracks?.join(",") === "port:servo.signal",
  "a pick asks the server for the port"
);

toggleProbePort("port:usb.5V");
await flush();
expect(
  timelines()[1]?.tracks?.join(",") === "port:servo.signal,port:usb.5V",
  "the request names every probed port"
);

// The answer's unrecorded list reaches the strip.
takeTimeline({
  type: "timeline-data",
  recording: "r1",
  from: 0,
  to: 1,
  tracks: [],
  markers: [],
  unrecorded: ["port:usb.5V"],
});
expect(
  worldTimelineSnapshot().data?.unrecorded?.join(",") === "port:usb.5V",
  "the unrecorded ports are kept"
);
takeTimeline({
  type: "timeline-data",
  recording: "r1",
  from: 0,
  to: 1,
  tracks: [],
  markers: [],
});
expect(
  worldTimelineSnapshot().data?.unrecorded === undefined,
  "an answer without the list leaves none"
);

// A removal asks for nothing.
sent.length = 0;
toggleProbePort("port:usb.5V");
await flush();
expect(sent.length === 0, "a removal sends nothing");
expect(probedPorts().join(",") === "port:servo.signal", "a removal drops it");

// A parked tab: the list is saved, and picking on a stopped run asks nobody.
const parked = [...probedPorts()];
restoreTimeline({
  recording: { id: "r1", from: 0, to: 1 },
  data: null,
  playhead: 0.5,
  frame: null,
  previous: true,
});
sent.length = 0;
toggleProbePort("port:uno.D9");
await flush();
expect(sent.length === 0, "a previous run is never asked for a new port");
expect(probedPorts().length === 2, "the pick still joins the list");

// Another document has its own list; coming back restores the saved one.
worldStore.getState().retargetDocument("parts/sfab/arm-scene@1.0.0.json");
expect(probedPorts().length === 0, "a new document starts with no probes");
setProbes(parked);
expect(
  probedPorts().join(",") === "port:servo.signal",
  "a saved list comes back"
);
worldStore.getState().retargetDocument("parts/sfab/arm-scene@1.0.0.json");
expect(probedPorts().length === 1, "the same document keeps its list");
clearProbes();
expect(probedPorts().length === 0, "clear empties the list");

console.log("world-probe-state.selfcheck ok");
