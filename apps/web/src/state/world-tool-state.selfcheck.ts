import { worldStore } from "./world";
import { beginToolGesture, pickWorldTool, worldToolStore } from "./world-tool";

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

console.log("world-tool-state.selfcheck ok");
