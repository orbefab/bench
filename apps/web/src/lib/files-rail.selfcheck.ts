import { ok as expect } from "node:assert/strict";
import {
  catalogEmptyReason,
  filesRailToggleTitle,
  readFileTreeExpansion,
  serializeFileTreeExpansion,
  shouldReloadOpenFile,
} from "./files-rail";

expect(filesRailToggleTitle(true, "show") === "Show files (⌘B)", "show title");
expect(filesRailToggleTitle(false) === "Toggle files (Ctrl+B)", "toggle title");

expect(
  catalogEmptyReason({
    fileCount: 0,
    listedCount: 0,
    treeCount: 0,
    kind: "all",
  }).type === "no-cad",
  "empty folder"
);
expect(
  catalogEmptyReason({
    fileCount: 3,
    listedCount: 0,
    treeCount: 0,
    kind: "glb",
  }).type === "kind",
  "kind trap"
);
expect(
  catalogEmptyReason({
    fileCount: 3,
    listedCount: 0,
    treeCount: 0,
    kind: "step",
  }).type === "kind",
  "step trap"
);
expect(
  catalogEmptyReason({
    fileCount: 3,
    listedCount: 2,
    treeCount: 0,
    kind: "all",
  }).type === "search",
  "search miss"
);
expect(
  catalogEmptyReason({
    fileCount: 3,
    listedCount: 2,
    treeCount: 2,
    kind: "all",
  }).type === "ready",
  "has rows"
);
expect(
  catalogEmptyReason({
    fileCount: 3,
    listedCount: 0,
    treeCount: 0,
    kind: "glb",
  }).type === "kind",
  "kind wins over a leftover search"
);

expect(
  shouldReloadOpenFile("a.step", "a.step", false) === false,
  "re-click is a no-op"
);
expect(shouldReloadOpenFile("a.step", "a.step", true), "error row retries");
expect(shouldReloadOpenFile("b.step", "a.step", false), "other file opens");

const roundTrip = readFileTreeExpansion(
  serializeFileTreeExpansion({ "/abs/path/proj": ["cad"] })
);
expect(roundTrip["/abs/path/proj"]?.[0] === "cad", "storage round-trip");
expect(
  Object.keys(readFileTreeExpansion("not-json")).length === 0,
  "bad json is empty"
);
expect(
  Object.keys(readFileTreeExpansion(null)).length === 0,
  "missing storage is empty"
);

const migrated = readFileTreeExpansion(
  JSON.stringify({
    projects: [
      {
        path: "/abs/path/old",
        expanded: ["cad", "cad"],
        seen: ["cad", "out"],
        updatedAt: 3,
      },
    ],
  })
);
expect(
  migrated["/abs/path/old"]?.join(",") === "cad",
  "old project rows become path → dirs"
);

const collapsed = readFileTreeExpansion(
  serializeFileTreeExpansion({ "/abs/path/proj": [] })
);
expect(
  Array.isArray(collapsed["/abs/path/proj"]) &&
    collapsed["/abs/path/proj"]?.length === 0,
  "collapse-all is stored"
);

console.log("files-rail.selfcheck ok");
