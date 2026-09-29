import { LIBRARY_PART_REASON, openPartTarget } from "./world-open-part";
import { parkGuard, parkOutcome, runPhase } from "./world-park";
import {
  breadcrumb,
  closePartTab,
  emptyPartTabSnapshot,
  emptyPartTabs,
  openPartCrumb,
  openPartTab,
  partTabSnapshot,
  savePartTab,
} from "./world-part-tabs";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const usb = "parts/sfab/nano-servo-usb@1.0.0.json";
const scene = "parts/sfab/nano-servo-scene@1.0.0.json";
const flag = "parts/sfab/flag@1.0.0.json";
const arm = "parts/sfab/arm-bench@1.0.0.json";

let model = emptyPartTabs();
model = openPartTab(model, { file: usb });
expect(
  model.tabs.length === 1 && model.focused === usb,
  "a sidebar open starts one tab"
);
expect(
  breadcrumb(model)
    .map((crumb) => crumb.name)
    .join(" › ") === "nano-servo-usb",
  "a sidebar open is a chain of one"
);

model = openPartTab(model, {
  file: scene,
  parent: { file: usb, instance: "scene" },
});
model = openPartTab(model, {
  file: flag,
  parent: { file: scene, instance: "flag" },
});
expect(
  model.tabs.length === 3 && model.focused === flag,
  "Open part adds a tab"
);
expect(
  breadcrumb(model)
    .map((crumb) => crumb.name)
    .join(" › ") === "nano-servo-usb › nano-servo-scene › flag",
  "Open part extends the chain"
);
expect(
  model.tabs.find((tab) => tab.file === flag)?.chain[2]?.from === "flag",
  "Open part remembers the instance path"
);

const again = openPartTab(model, {
  file: scene,
  parent: { file: flag, instance: "nope" },
});
expect(
  again.tabs === model.tabs && again.focused === scene,
  "a second open focuses the tab"
);
expect(again.tabs.length === 3, "one file never has two tabs");
expect(
  breadcrumb(again)
    .map((crumb) => crumb.name)
    .join(" › ") === "nano-servo-usb › nano-servo-scene",
  "focusing a tab keeps the chain it was opened with"
);

const sidebar = openPartTab(again, { file: arm });
expect(
  sidebar.tabs.length === 4 && sidebar.focused === arm,
  "a sidebar open adds a tab"
);
expect(
  breadcrumb(sidebar)
    .map((crumb) => crumb.name)
    .join(" › ") === "arm-bench",
  "a sidebar open starts a new chain"
);

const parked = savePartTab(sidebar, arm, {
  ...emptyPartTabSnapshot(),
  selection: { path: "arm", link: "upper_arm" },
  collapsed: ["arm.fore"],
  seeded: true,
  camera: { position: [1, 2, 3], target: [0, 0, 0] },
  timeline: { from: 0, to: 1.5, playhead: 0.4 },
  history: {
    undoOrder: [""],
    redoOrder: [],
    parts: [{ canUndo: true, canRedo: false }],
  },
});
const away = openPartTab(parked, { file: usb });
expect(away.focused === usb, "switching focuses the other file");
const back = openPartTab(away, { file: arm });
const restored = partTabSnapshot(back, arm);
expect(
  restored?.selection?.path === "arm" &&
    restored.selection.link === "upper_arm" &&
    restored.collapsed.join(",") === "arm.fore" &&
    restored.seeded === true &&
    restored.camera?.position[0] === 1 &&
    restored.timeline?.to === 1.5 &&
    restored.timeline.playhead === 0.4 &&
    restored.history.parts[0]?.canUndo === true,
  "a parked tab restores its selection, tree, camera, and timeline"
);

let closed = closePartTab(back, arm);
expect(
  closed.focused === flag,
  "closing the last tab focuses the neighbour on its left"
);
closed = closePartTab(closed, usb);
closed = closePartTab(closed, scene);
closed = closePartTab(closed, flag);
expect(
  closed.tabs.length === 0 && closed.focused === null,
  "the last tab leaves nothing open"
);

model = emptyPartTabs();
model = openPartTab(model, { file: usb });
model = openPartTab(model, {
  file: scene,
  parent: { file: usb, instance: "scene" },
});
model = openPartTab(model, {
  file: flag,
  parent: { file: scene, instance: "flag" },
});
model = closePartTab(model, scene);
expect(
  model.tabs.every((tab) => tab.file !== scene),
  "closing a tab drops it"
);
const reopened = openPartCrumb(model, scene);
expect(
  reopened.tabs.some((tab) => tab.file === scene) && reopened.focused === scene,
  "a crumb reopens a closed tab"
);
expect(
  breadcrumb(reopened)
    .map((crumb) => crumb.name)
    .join(" › ") === "nano-servo-usb › nano-servo-scene",
  "the reopened tab keeps the chain up to that crumb"
);

const project = openPartTarget({
  source: "project",
  file: scene,
});
const library = openPartTarget({ source: "library" });
const catalog = openPartTarget({ source: "catalog" });
expect(
  project.enabled === true && project.file === scene,
  "a project file opens"
);
expect(
  library.enabled === false && library.reason === LIBRARY_PART_REASON,
  "a library part is disabled"
);
expect(
  catalog.enabled === false && catalog.reason === LIBRARY_PART_REASON,
  "a catalog part is disabled"
);

expect(parkGuard("playing") === "ask", "a playing run asks");
expect(parkGuard("paused") === "go", "a paused run does not ask");
expect(parkGuard("idle") === "go", "an idle run does not ask");
expect(parkGuard("idle", true) === "ask", "a capture in flight asks");
expect(parkOutcome("stay") === "stay", "Stay changes nothing");
expect(
  parkOutcome("stop") === "stop-and-continue",
  "Stop and continue pauses, then proceeds"
);
expect(
  runPhase({ playing: true, started: true }) === "playing",
  "playing wins"
);
expect(
  runPhase({ playing: false, started: true }) === "paused",
  "a started run is paused"
);
expect(
  runPhase({ playing: false, started: false }) === "idle",
  "an unstarted run is idle"
);

console.log("world-part-tabs.selfcheck ok");
