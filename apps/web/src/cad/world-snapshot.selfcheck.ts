import type { WorldState } from "@sfab-bench/contract";

import { viewerSnapshot, worldViewerSelection } from "@/cad/viewer-snapshot";
import { setWorldLiveState, worldStore } from "@/state/world";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const live: WorldState = {
  simTime: 12.345,
  playing: true,
  poses: {},
  joints: {},
  boards: { uno: { running: true } },
};

worldStore.setState({
  path: "examples/arm/parts/sfab/arm-bench@1.0.0.json",
  playing: false,
  simTime: 0,
});
setWorldLiveState(live);

const open = viewerSnapshot();
expect(
  open.file === "examples/arm/parts/sfab/arm-bench@1.0.0.json",
  "world path is the file"
);
expect(open.empty === false, "an open world is not an empty CAD view");
expect(open.playing === true, "playing comes from the live run");
expect(open.simTime === 12.345, "simTime comes from the live run");
expect(open.tree.length === 0 && open.partCount === 0, "no CAD tree");
expect(open.selected === null, "CAD selection stays off the world snapshot");
expect(
  open.selection === null,
  "nothing picked reports a null world selection"
);
expect(
  worldViewerSelection(false, { kind: "board", board: "uno" }) === undefined,
  "a CAD view omits the world selection"
);
expect(
  worldViewerSelection(true, null) === null,
  "an open world can report nothing selected"
);
const linkPick = { kind: "link" as const, robot: "arm", link: "upper_arm" };
expect(
  worldViewerSelection(true, linkPick) === linkPick,
  "the helper returns the link selection"
);

worldStore.getState().select({ kind: "board", board: "uno" });
const boardSnap = viewerSnapshot();
expect(
  boardSnap.selection?.kind === "board" && boardSnap.selection.board === "uno",
  "get_viewer names the selected board"
);
worldStore.getState().select(linkPick);
const linkSnap = viewerSnapshot();
expect(
  linkSnap.selection?.kind === "link" &&
    linkSnap.selection.robot === "arm" &&
    linkSnap.selection.link === "upper_arm",
  "get_viewer names the selected link"
);
const partPick = { kind: "part" as const, part: "servo" };
worldStore.getState().select(partPick);
const partSnap = viewerSnapshot();
expect(
  partSnap.selection?.kind === "part" && partSnap.selection.part === "servo",
  "get_viewer names the selected part"
);
worldStore.getState().select({ kind: "supply", supply: "usb" });
const supplySnap = viewerSnapshot();
expect(
  supplySnap.selection?.kind === "supply" &&
    supplySnap.selection.supply === "usb",
  "get_viewer names the selected supply"
);

worldStore.getState().close();
setWorldLiveState(null);
const closed = viewerSnapshot();
expect(closed.file === "", "closing the world clears the snapshot file");
expect(closed.playing === undefined, "a CAD snapshot has no playing");
expect(closed.simTime === undefined, "a CAD snapshot has no simTime");
expect(closed.selection === undefined, "a CAD snapshot has no world selection");

console.log("world-snapshot.selfcheck ok");
