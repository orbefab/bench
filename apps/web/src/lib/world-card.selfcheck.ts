import { ok as expect } from "node:assert/strict";
import type { WorldViewNode } from "@sfab-bench/contract";

import { instanceCard } from "./world-card";

const node: WorldViewNode = {
  id: "servo",
  name: "servo",
  part: "sfab/sg90@1.0.0",
  type: "servo",
  role: "part",
  pose: {
    position: [0, 0, 0],
    rotation: [1, 0, 0, 0],
  },
  ports: [
    { name: "signal", source: "type", fixed: true, wired: false },
    { name: "V+", source: "type", fixed: false, wired: false },
  ],
  params: { K: 0.2 },
  levels: [
    {
      axis: "behaviour",
      chosen: { class: 1, variant: "motor" },
      options: [
        {
          class: 1,
          variant: "motor",
          label: "dc-motor@1",
          runnable: true,
        },
        {
          class: 0,
          variant: "idle",
          label: "none",
          runnable: false,
          reason: "no runtime for script",
        },
      ],
    },
    {
      axis: "visual",
      chosen: { class: 1, variant: "mesh" },
      options: [
        {
          class: 1,
          variant: "mesh",
          label: "mesh",
          runnable: false,
          reason: "placeholder mesh",
        },
        {
          class: 0,
          variant: "box",
          label: "box",
          runnable: true,
        },
      ],
    },
  ],
  children: [],
};

const card = instanceCard(node);
expect(
  card.ports
    .map((port) => `${port.name}${port.fixed ? " fixed" : ""}`)
    .join(", ") === "signal fixed, V+",
  "ports list fixed quietly"
);
expect(
  card.params.length === 1 &&
    card.params[0]?.name === "K" &&
    card.params[0].value === 0.2,
  "params are the instance params"
);
expect(
  card.axes.map((axis) => axis.axis).join(",") === "behaviour,visual",
  "one picker per authored axis"
);
const behaviour = card.axes[0]?.options ?? [];
const chosen = behaviour.find((option) => option.chosen);
const gray = behaviour.find((option) => !option.runnable);
expect(
  chosen?.variant === "motor" && chosen.class === 1,
  "the resolved option is chosen"
);
expect(
  gray?.variant === "idle" &&
    gray.gray === true &&
    gray.reason === "no runtime for script",
  "an option that cannot run is grayed with its reason"
);
const visual = card.axes[1]?.options ?? [];
const currentMesh = visual.find((option) => option.chosen);
expect(
  currentMesh?.variant === "mesh" && currentMesh.gray === false,
  "the running level is not grayed"
);
expect(
  currentMesh?.reason === "placeholder mesh",
  "a placeholder mesh is still the resolved level"
);

console.log("world-card.selfcheck ok");
