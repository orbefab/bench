/**
 * Rename part file: the card target, and tabs following a moved file.
 */
import { ok as expect } from "node:assert/strict";
import {
  breadcrumb,
  emptyPartTabs,
  openPartTab,
  retargetPartFile,
  worldPathAfterMove,
} from "./world-part-tabs";
import {
  partFileName,
  RENAME_LIBRARY_REASON,
  renamePartTarget,
} from "./world-rename-part";

const project = renamePartTarget({ source: "project" });
expect(project.enabled === true, "a project part renames");
const library = renamePartTarget({ source: "library" });
const catalog = renamePartTarget({ source: "catalog" });
expect(
  library.enabled === false &&
    "reason" in library &&
    library.reason === RENAME_LIBRARY_REASON,
  "a library part is disabled"
);
expect(
  catalog.enabled === false &&
    "reason" in catalog &&
    catalog.reason === RENAME_LIBRARY_REASON,
  "a catalog part is disabled"
);
expect(
  partFileName("sfab/nano-servo-scene@1.0.0") === "nano-servo-scene",
  "the field shows the short name"
);

const usb = "parts/sfab/nano-servo-usb@1.0.0.json";
const scene = "parts/sfab/nano-servo-scene@1.0.0.json";
const next = "parts/sfab/servo-scene@1.0.0.json";
let model = emptyPartTabs();
model = openPartTab(model, { file: usb });
model = openPartTab(model, {
  file: scene,
  parent: { file: usb, instance: "scene" },
});
const moved = retargetPartFile(model, scene, next);
expect(moved.focused === next, "the focused tab follows the file");
expect(
  moved.tabs.some((tab) => tab.file === next && tab.name === "servo-scene"),
  "the tab takes the new name"
);
expect(
  !moved.tabs.some((tab) => tab.file === scene),
  "the old file is gone from the tabs"
);
expect(
  breadcrumb(moved)
    .map((crumb) => crumb.file)
    .join(" ") === `${usb} ${next}`,
  "the crumb follows the file"
);
expect(
  breadcrumb(moved)
    .map((crumb) => crumb.name)
    .join(" › ") === "nano-servo-usb › servo-scene",
  "the crumb takes the new name"
);
expect(worldPathAfterMove(scene, scene, next) === next, "the url follows");
expect(worldPathAfterMove(usb, scene, next) === usb, "another tab's url stays");
expect(
  retargetPartFile(moved, scene, next) === moved,
  "a second retarget is a no-op"
);

console.log("world-rename-part.selfcheck ok");
