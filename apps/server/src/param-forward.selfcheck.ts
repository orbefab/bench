/**
 * The Nano and Uno chip children take `firmware` and `source` from the
 * board instance via `$param`. The view records that source, and the
 * card reports it. The board's own params stay editable.
 */

import { ok as expect } from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { WorldViewNode } from "@sfab-bench/contract";

import { forwardLabel, instanceCard } from "../../web/src/lib/world-card";
import { planWorld } from "./world/plan";
import { viewOf } from "./world/view";

const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function flat(nodes: readonly WorldViewNode[]): WorldViewNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children)]);
}

function nodeAt(nodes: readonly WorldViewNode[], id: string): WorldViewNode {
  const node = flat(nodes).find((item) => item.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function open(project: string, world: string) {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  return viewOf(planned.plan);
}

function expectForward(
  node: WorldViewNode,
  name: string,
  from: string,
  param: string
): void {
  const recorded = node.forwards?.[name];
  expect(
    recorded?.from === from && recorded.param === param,
    `${node.id}.${name} from ${recorded?.from}.${recorded?.param}`
  );
  const card = instanceCard(node).params.find((row) => row.name === name);
  expect(
    card?.forward?.from === from && card.forward.param === param,
    `${node.id} card ${card?.forward?.from}.${card?.forward?.param}`
  );
  expect(
    card?.forward !== undefined &&
      forwardLabel(card.forward) === `from ${from}.${param}`,
    `${node.id} label`
  );
}

const nano = open(nanoDir, "parts/sfab/nano-led@1.0.0.json");
const nanoBoard = nano.boards.find((board) => board.id === "nano");
expect(nanoBoard?.pins.length === 20, "the Nano view lists 20 pins");
expect(nanoBoard?.pins[5] === "D5", "Nano pin 5 is D5");
expect(nanoBoard?.pins[13] === "D13", "Nano pin 13 is D13");
expect(
  nanoBoard?.minOperatingVoltage === 3.78,
  "Nano SOA floor is on the view"
);
expect(nanoBoard?.brownoutVoltage === 2.7, "Nano brownout is on the view");
expect(
  nanoBoard?.ledPin === "D13",
  `the Nano LED is on D13, got ${nanoBoard?.ledPin}`
);
const nanoMcu = nodeAt(nano.tree.nodes, "nano.mcu");
const nanoHost = nodeAt(nano.tree.nodes, "nano");
expectForward(nanoMcu, "firmware", "nano", "firmware");
expectForward(nanoMcu, "source", "nano", "source");
expect(
  nanoMcu.forwards?.quiescent === undefined &&
    typeof nanoMcu.params.quiescent === "number",
  "quiescent on the chip stays the chip's own param"
);
expect(
  nanoHost.forwards?.firmware === undefined &&
    typeof nanoHost.params.firmware === "string",
  "the board's firmware param is not forwarded"
);
const nanoFirmware = instanceCard(nanoHost).params.find(
  (row) => row.name === "firmware"
);
expect(
  nanoFirmware?.forward === undefined,
  "the board card still edits firmware"
);

const arm = open(armDir, "parts/sfab/arm-bench@1.0.0.json");
const unoBoard = arm.boards.find((board) => board.id === "uno");
expect(unoBoard?.pins.length === 20, "the Uno view lists 20 pins");
expect(unoBoard?.pins[5] === "D5", "Uno pin 5 is D5");
expect(unoBoard?.minOperatingVoltage === 3.78, "Uno SOA floor is on the view");
const unoMcu = nodeAt(arm.tree.nodes, "uno.mcu");
const unoHost = nodeAt(arm.tree.nodes, "uno");
expectForward(unoMcu, "firmware", "uno", "firmware");
expectForward(unoMcu, "source", "uno", "source");
expect(
  unoHost.forwards?.firmware === undefined &&
    typeof unoHost.params.firmware === "string",
  "the Uno board's firmware param is not forwarded"
);

console.log(
  "param-forward: nano.mcu from nano.firmware, uno.mcu from uno.firmware"
);
