import { bindSceneInvalidate } from "@/scene/invalidate";
import { worldStore } from "./world";
import {
  beginToolGesture,
  pickWorldTool,
  tapWireEmpty,
  tapWirePort,
  worldToolStore,
} from "./world-tool";

function expect(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}

// A closed or changed document cancels a drag in flight: its window
// listeners and the paused orbit must not outlive it.
worldStore.getState().retargetDocument("parts/sfab/a@1.0.0.json");
pickWorldTool("move");
let cancelled = 0;
beginToolGesture(() => {
  cancelled += 1;
});
expect(worldToolStore.getState().gesture, "a gesture is in flight");
worldStore.getState().retargetDocument("parts/sfab/b@1.0.0.json");
expect(cancelled === 1, "a document change cancels the gesture once");
expect(
  worldToolStore.getState().mode === "select" &&
    !worldToolStore.getState().gesture,
  "the tool is back to Select with no gesture"
);

// The same document reloading keeps a gesture: only a new document resets.
pickWorldTool("rotate");
beginToolGesture(() => {
  cancelled += 1;
});
worldStore.getState().retargetDocument("parts/sfab/b@1.0.0.json");
expect(cancelled === 1, "the same document does not cancel");
pickWorldTool("select");
expect(cancelled === 2, "picking another tool cancels a gesture");

// The canvas draws on demand: a tool change, a held port and its release
// each ask for a frame, or the markers and the rubber band stay on screen.
let frames = 0;
bindSceneInvalidate(() => {
  frames += 1;
});
pickWorldTool("wire");
expect(frames === 1, "entering Wire asks for a frame");
tapWirePort("uno.D10");
expect(frames === 2, "holding a port asks for a frame");
tapWireEmpty();
expect(
  worldToolStore.getState().wireFrom === null && frames === 3,
  "letting go of a held port asks for a frame"
);
tapWirePort("uno.D10");
pickWorldTool("move");
expect(
  worldToolStore.getState().wireFrom === null && frames === 6,
  "leaving Wire with a port held clears it and asks for a frame"
);
pickWorldTool("select");
expect(frames === 7, "leaving a tool asks for a frame");
pickWorldTool("select");
expect(frames === 7, "picking the tool already in use asks for nothing");
bindSceneInvalidate(null);

console.log("world-tool-state.selfcheck ok");
