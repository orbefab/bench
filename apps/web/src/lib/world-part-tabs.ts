/**
 * Part tabs inside one browser tab. The browser tab is the folder
 * (`?project=`, ADR 0006). A part tab is one open part file. The set
 * is client state: a reload keeps only the focused file in `?world=`.
 */

import type { RecordedFrame, RecordingSummary } from "@sfab-bench/contract";

import type { TimelineData } from "@/state/world-timeline";

import type { HistoryModel } from "./world-history";
import { emptyHistory } from "./world-history";

export type PartTabSelection = {
  path: string;
  link?: string;
} | null;

export type PartTabWire = {
  owner: string;
  index: number;
} | null;

export type PartTabCamera = {
  position: [number, number, number];
  target: [number, number, number];
};

/** Timeline data this client already holds. The worker does not keep it. */
export type PartTabTimeline = {
  from: number;
  to: number;
  playhead: number | null;
  recording?: RecordingSummary | null;
  data?: TimelineData | null;
  frame?: RecordedFrame | null;
};

export type PartTabSnapshot = {
  selection: PartTabSelection;
  wire: PartTabWire;
  /** Tree rows the user folded. */
  collapsed: readonly string[];
  /** True once this document has been seeded, so a return does not reseed. */
  seeded: boolean;
  camera: PartTabCamera | null;
  timeline: PartTabTimeline | null;
  /** Probed ports (`portProbeId`), in the order they were picked. */
  probes: readonly string[];
  history: HistoryModel;
};

export type PartCrumb = {
  file: string;
  name: string;
  /** Instance path in the previous part. Absent on the chain root. */
  from: string | null;
};

export type PartTab = {
  file: string;
  name: string;
  readOnly: boolean;
  /** From the part this chain started on, through this tab. */
  chain: PartCrumb[];
  snapshot: PartTabSnapshot;
};

export type PartTabsModel = {
  tabs: PartTab[];
  focused: string | null;
};

export function emptyPartTabs(): PartTabsModel {
  return { tabs: [], focused: null };
}

export function emptyPartTabSnapshot(): PartTabSnapshot {
  return {
    selection: null,
    wire: null,
    collapsed: [],
    seeded: false,
    camera: null,
    timeline: null,
    probes: [],
    history: emptyHistory(),
  };
}

/** `parts/sfab/flag@1.0.0.json` → `flag`. */
export function partTabLabel(file: string): string {
  const base = file.split("/").filter(Boolean).pop() ?? file;
  const at = base.lastIndexOf("@");
  if (at > 0 && base.endsWith(".json")) return base.slice(0, at);
  return base.replace(/\.json$/, "");
}

export type OpenPartTab = {
  file: string;
  name?: string;
  readOnly?: boolean;
  /**
   * Set by Open part. Absent for a sidebar open, which starts a chain
   * of one. Ignored when this file already has a tab.
   */
  parent?: { file: string; instance: string } | null;
};

/**
 * One tab per file. An open file is focused; its chain is left as it
 * was. A new file from the sidebar starts a chain of one. Open part
 * appends to the parent tab's chain.
 */
export function openPartTab(
  model: PartTabsModel,
  input: OpenPartTab
): PartTabsModel {
  const file = input.file;
  if (!file) return model;
  const existing = model.tabs.find((tab) => tab.file === file);
  if (existing) {
    return model.focused === file ? model : { ...model, focused: file };
  }
  const name = input.name?.trim() || partTabLabel(file);
  const parent = input.parent
    ? model.tabs.find((tab) => tab.file === input.parent?.file)
    : undefined;
  const from = input.parent?.instance ?? null;
  const chain: PartCrumb[] = parent
    ? [...parent.chain, { file, name, from }]
    : [{ file, name, from: null }];
  const tab: PartTab = {
    file,
    name,
    readOnly: input.readOnly === true,
    chain,
    snapshot: emptyPartTabSnapshot(),
  };
  return { tabs: [...model.tabs, tab], focused: file };
}

/**
 * Focus a crumb's file. A closed ancestor is opened again with the
 * chain up to that crumb. An open tab is focused and keeps its chain.
 */
export function openPartCrumb(
  model: PartTabsModel,
  file: string
): PartTabsModel {
  const focused = model.tabs.find((tab) => tab.file === model.focused);
  const chain = focused?.chain ?? [];
  const index = chain.findIndex((crumb) => crumb.file === file);
  if (index < 0) return model;
  const existing = model.tabs.find((tab) => tab.file === file);
  if (existing) {
    return model.focused === file ? model : { ...model, focused: file };
  }
  const crumb = chain[index];
  if (!crumb) return model;
  const tab: PartTab = {
    file: crumb.file,
    name: crumb.name,
    readOnly: false,
    chain: chain.slice(0, index + 1),
    snapshot: emptyPartTabSnapshot(),
  };
  return { tabs: [...model.tabs, tab], focused: file };
}

export function breadcrumb(model: PartTabsModel): PartCrumb[] {
  const focused = model.tabs.find((tab) => tab.file === model.focused);
  return focused ? focused.chain.map((crumb) => ({ ...crumb })) : [];
}

/**
 * Close one tab. The focused tab's neighbour is the tab that was on
 * its right, or the one on its left when it was last. The last tab
 * leaves the model empty.
 */
export function closePartTab(
  model: PartTabsModel,
  file: string
): PartTabsModel {
  const index = model.tabs.findIndex((tab) => tab.file === file);
  if (index < 0) return model;
  const tabs = model.tabs.filter((tab) => tab.file !== file);
  let focused = model.focused;
  if (focused === file) {
    focused = tabs[index]?.file ?? tabs[index - 1]?.file ?? null;
  }
  return { tabs, focused };
}

export function savePartTab(
  model: PartTabsModel,
  file: string,
  snapshot: PartTabSnapshot
): PartTabsModel {
  let changed = false;
  const tabs = model.tabs.map((tab) => {
    if (tab.file !== file || tab.snapshot === snapshot) return tab;
    changed = true;
    return { ...tab, snapshot };
  });
  return changed ? { ...model, tabs } : model;
}

export function partTabSnapshot(
  model: PartTabsModel,
  file: string
): PartTabSnapshot | null {
  return model.tabs.find((tab) => tab.file === file)?.snapshot ?? null;
}

/** Learn the part's name once the view arrives. Every crumb of that file updates. */
export function renamePartTab(
  model: PartTabsModel,
  file: string,
  name: string
): PartTabsModel {
  const next = name.trim();
  if (!next) return model;
  let changed = false;
  const tabs = model.tabs.map((tab) => {
    let chainChanged = false;
    const chain = tab.chain.map((crumb) => {
      if (crumb.file !== file || crumb.name === next) return crumb;
      chainChanged = true;
      return { ...crumb, name: next };
    });
    const tabName = tab.file === file && tab.name !== next ? next : tab.name;
    if (!chainChanged && tabName === tab.name) return tab;
    changed = true;
    return {
      ...tab,
      name: tabName,
      chain: chainChanged ? chain : tab.chain,
    };
  });
  return changed ? { ...model, tabs } : model;
}

/**
 * A rename moved `from` to `to`. Every tab and crumb of that file
 * follows, and takes the new file's name. The focused tab follows too.
 */
export function retargetPartFile(
  model: PartTabsModel,
  from: string,
  to: string
): PartTabsModel {
  if (!from || !to || from === to) return model;
  const name = partTabLabel(to);
  let changed = false;
  const tabs = model.tabs.map((tab) => {
    const file = tab.file === from ? to : tab.file;
    const tabName = tab.file === from ? name : tab.name;
    let chainChanged = false;
    const chain = tab.chain.map((crumb) => {
      if (crumb.file !== from) return crumb;
      chainChanged = true;
      return { ...crumb, file: to, name };
    });
    if (file === tab.file && tabName === tab.name && !chainChanged) return tab;
    changed = true;
    return {
      ...tab,
      file,
      name: tabName,
      chain: chainChanged ? chain : tab.chain,
    };
  });
  const focused = model.focused === from ? to : model.focused;
  if (!changed && focused === model.focused) return model;
  return { tabs, focused };
}

/** `?world=` changes only when the focused file is the one that moved. */
export function worldPathAfterMove(
  world: string,
  from: string,
  to: string
): string {
  return world === from ? to : world;
}
