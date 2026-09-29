/**
 * A set-play restart: a new view, a report with the time-step warning
 * on the open-part card, and an edited answer that carries histories.
 * Collapse, diagnostics, and history each write once and then return
 * the same value. The card scroller reserves its scrollbar gutter so
 * that warning cannot change the content width.
 */
import { ok as expect } from "node:assert/strict";
import type {
  RunReport,
  WorldViewNode,
  WorldViewTree,
} from "@sfab-bench/contract";

import { worldStore } from "@/state/world";

import { nextCollapse } from "./world-tree";
import {
  documentWarnings,
  inspectorBodyClass,
  warningsFromRun,
} from "./world-warnings";

const pose = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};

function node(id: string, children: WorldViewNode[] = []): WorldViewNode {
  return {
    id,
    name: id.slice(id.lastIndexOf(".") + 1),
    part: "sfab/part@1.0.0",
    type: "part",
    role: children.length > 0 ? "assembly" : "part",
    pose,
    ports: [],
    params: {},
    levels: [],
    children,
  };
}

const nodes = [node("$root", [node("$root.nano", [node("$root.nano.led")])])];
const view: WorldViewTree = {
  part: "sfab/nano-servo-usb@1.0.0",
  stage: "sfab/scene@1.0.0",
  play: { gravity: [0, 0, -3.71], seed: 1, timestep: 0.002 },
  nodes,
};
const warning = {
  path: "$root",
  port: "play",
  code: "timestep-unsupported",
  message: "play.timestep 0.002 s is not supported yet; the run steps 1 ms",
};
const report = { warnings: [warning] } as unknown as RunReport;
const edited = {
  canUndo: true,
  canRedo: false,
  histories: [{ canUndo: true, canRedo: false }],
};

function settle(input: {
  collapsed: ReadonlySet<string>;
  seededPath: string | null;
  target: string | null;
  nodes: readonly WorldViewNode[];
}): { writes: number; collapsed: ReadonlySet<string>; seededPath: string } {
  let collapsed = input.collapsed;
  let seededPath = input.seededPath;
  let writes = 0;
  for (let pass = 0; pass < 6; pass++) {
    const step = nextCollapse({
      collapsed,
      nodes: input.nodes,
      documentPath: "parts/example/nano-servo-usb.json",
      seededPath,
      target: input.target,
      kind: "instance",
    });
    const seedWrite = seededPath !== step.seededPath;
    if (!step.wrote && !seedWrite) {
      return { writes, collapsed, seededPath: step.seededPath };
    }
    if (step.wrote) {
      collapsed = step.collapsed;
      writes += 1;
    }
    if (seedWrite) {
      seededPath = step.seededPath;
      writes += 1;
    }
  }
  throw new Error("collapse did not settle within 6 passes");
}

const opened = settle({
  collapsed: new Set(),
  seededPath: null,
  target: null,
  nodes,
});
expect(
  opened.writes === 2 && opened.collapsed.has("$root.nano"),
  `first open writes ${opened.writes}`
);
const reloaded = settle({
  collapsed: opened.collapsed,
  seededPath: opened.seededPath,
  target: null,
  nodes: nodes.map((row) => ({ ...row })),
});
expect(reloaded.writes === 0, `a set-play reload writes ${reloaded.writes}`);
expect(
  reloaded.collapsed === opened.collapsed,
  "a set-play reload keeps the collapsed set"
);

const picked = settle({
  collapsed: opened.collapsed,
  seededPath: opened.seededPath,
  target: "$root.nano.led",
  nodes,
});
expect(picked.writes === 1, `a nested pick writes ${picked.writes}`);
const pickedAgain = settle({
  collapsed: picked.collapsed,
  seededPath: picked.seededPath,
  target: "$root.nano.led",
  nodes: nodes.map((row) => ({ ...row })),
});
expect(
  pickedAgain.writes === 0 && pickedAgain.collapsed === picked.collapsed,
  "a reload with the same pick does not write collapse"
);

expect(
  inspectorBodyClass.includes("[scrollbar-gutter:stable]") &&
    inspectorBodyClass.includes("overflow-x-hidden"),
  "the card reserves a stable scrollbar gutter"
);
const onCard = documentWarnings(warningsFromRun(report, [warning]));
expect(
  onCard.length === 1 && onCard[0]?.code === "timestep-unsupported",
  "the time-step warning is on the open-part card"
);

const documentPath = "parts/example/nano-servo-usb.json";
worldStore.getState().open(documentPath);
let writes = 0;
const unsubscribe = worldStore.subscribe(() => {
  writes += 1;
});
worldStore.getState().setTree(view);
worldStore.getState().setReport(report);
worldStore.getState().setDiagnostics([warning]);
worldStore.getState().applyHistory(edited, "set play");
expect(writes === 4, `the restart writes the store ${writes} times`);
writes = 0;
worldStore.getState().setReport(report);
worldStore.getState().setDiagnostics([{ ...warning }]);
worldStore.getState().applyHistory(
  {
    canUndo: true,
    canRedo: false,
    histories: [{ canUndo: true, canRedo: false }],
  },
  "set play"
);
worldStore.getState().setTree(view);
expect(writes === 0, `a repeated restart writes the store ${writes} times`);
unsubscribe();
worldStore.getState().close();

console.log("world-restart.selfcheck ok");
