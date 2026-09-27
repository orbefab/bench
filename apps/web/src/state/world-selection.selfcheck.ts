import { reduceWorldSelection, worldStore } from "./world";

function expect(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}

const link = { kind: "link" as const, robot: "arm", link: "upper_arm" };
const board = { kind: "board" as const, board: "uno" };
const part = { kind: "part" as const, part: "servo" };
const links = [{ robot: "arm", link: "upper_arm" }];
const reload = {
  links,
  boards: ["uno"] as readonly string[],
  parts: ["servo"] as readonly string[],
  supplies: ["usb"] as readonly string[],
};

let selection = reduceWorldSelection(null, {
  type: "select",
  selection: link,
});
expect(
  selection?.kind === "link" && selection.link === "upper_arm",
  "selects a link"
);
selection = reduceWorldSelection(selection, {
  type: "select",
  selection: board,
});
expect(
  selection?.kind === "board" && selection.board === "uno",
  "selects a board"
);

const keptBoard = reduceWorldSelection(selection, {
  type: "reload",
  ...reload,
});
expect(keptBoard === selection, "a reload that keeps the board keeps it");

const droppedBoard = reduceWorldSelection(selection, {
  type: "reload",
  links,
  boards: [],
  parts: ["servo"],
  supplies: ["usb"],
});
expect(droppedBoard === null, "a reload that removes the board clears it");

const pickedLink = reduceWorldSelection(null, {
  type: "select",
  selection: link,
});
const keptLink = reduceWorldSelection(pickedLink, {
  type: "reload",
  ...reload,
});
expect(keptLink === pickedLink, "a reload that keeps the link keeps it");
const droppedLink = reduceWorldSelection(pickedLink, {
  type: "reload",
  links: [{ robot: "arm", link: "base" }],
  boards: ["uno"],
  parts: ["servo"],
  supplies: ["usb"],
});
expect(droppedLink === null, "a reload that removes the link clears it");
expect(
  reduceWorldSelection(pickedLink, { type: "close" }) === null,
  "close clears a link"
);
expect(
  reduceWorldSelection(selection, { type: "close" }) === null,
  "close clears a board"
);
expect(
  reduceWorldSelection(null, {
    type: "select",
    selection: null,
  }) === null,
  "selecting nothing stays clear"
);

const pickedPart = reduceWorldSelection(null, {
  type: "select",
  selection: part,
});
expect(
  pickedPart?.kind === "part" && pickedPart.part === "servo",
  "selects a part"
);
const keptPart = reduceWorldSelection(pickedPart, {
  type: "reload",
  ...reload,
});
expect(keptPart === pickedPart, "a reload that keeps the part keeps it");
const droppedPart = reduceWorldSelection(pickedPart, {
  type: "reload",
  links,
  boards: ["uno"],
  parts: [],
  supplies: ["usb"],
});
expect(droppedPart === null, "a reload that removes the part clears it");
expect(
  reduceWorldSelection(pickedPart, { type: "close" }) === null,
  "close clears a part"
);

worldStore.getState().open("examples/arm/arm.world.json");
worldStore.getState().select(link);
expect(
  worldStore.getState().selection?.kind === "link",
  "the store selects a link"
);
worldStore.getState().close();
expect(worldStore.getState().selection === null, "the store clears on close");

worldStore.getState().open("examples/arm/arm.world.json");
worldStore.getState().select(board);
worldStore.getState().setOutline({
  robots: [
    {
      id: "arm",
      links: [{ name: "upper_arm", meshes: [], joint: null }],
    },
  ],
  parts: [{ id: "servo", model: "sg90", drives: null, wires: [] }],
  boards: [{ id: "uno", chip: "atmega328p", firmware: "hold.hex" }],
  supplies: [
    {
      id: "usb",
      voltage: 5,
      currentLimit: 0.9,
      rSeries: 0.5,
      boards: ["uno"],
      parts: ["servo"],
    },
  ],
  targets: [],
});
expect(
  worldStore.getState().selection?.kind === "board",
  "the store keeps a board the reloaded outline still has"
);
worldStore.getState().setOutline({
  robots: [
    {
      id: "arm",
      links: [{ name: "base", meshes: [], joint: null }],
    },
  ],
  parts: [],
  boards: [],
  supplies: [],
  targets: [],
});
expect(
  worldStore.getState().selection === null,
  "the store clears a board the reloaded outline dropped"
);
worldStore.getState().select(part);
worldStore.getState().setOutline({
  robots: [
    {
      id: "arm",
      links: [{ name: "base", meshes: [], joint: null }],
    },
  ],
  parts: [{ id: "servo", model: "sg90", drives: null, wires: [] }],
  boards: [],
  supplies: [],
  targets: [],
});
expect(
  worldStore.getState().selection?.kind === "part",
  "the store keeps a part the reloaded outline still has"
);
worldStore.getState().setOutline({
  robots: [],
  parts: [],
  boards: [],
  supplies: [],
  targets: [],
});
expect(
  worldStore.getState().selection === null,
  "the store clears a part the reloaded outline dropped"
);
const supply = { kind: "supply" as const, supply: "usb" };
worldStore.getState().select(supply);
worldStore.getState().setOutline({
  robots: [],
  parts: [],
  boards: [],
  supplies: [
    {
      id: "usb",
      voltage: 5,
      currentLimit: 0.9,
      rSeries: 0.5,
      boards: [],
      parts: [],
    },
  ],
  targets: [],
});
expect(
  worldStore.getState().selection?.kind === "supply",
  "the store keeps a supply the reloaded outline still has"
);
worldStore.getState().setOutline({
  robots: [],
  parts: [],
  boards: [],
  supplies: [],
  targets: [],
});
expect(
  worldStore.getState().selection === null,
  "the store clears a supply the reloaded outline dropped"
);
worldStore.getState().close();

console.log("world-selection.selfcheck ok");
