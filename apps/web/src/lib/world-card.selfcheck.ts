import type { WorldViewNode } from "@sfab-bench/contract";

import { instanceCard } from "./world-card";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

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
    { name: "signal", source: "type", fixed: true },
    { name: "V+", source: "type", fixed: false },
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
      axis: "body",
      chosen: { class: 2, variant: "train" },
      options: [
        {
          class: 2,
          variant: "train",
          label: "gear-train",
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
  card.axes.map((axis) => axis.axis).join(",") === "behaviour,body",
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
  gray?.variant === "idle" && gray.reason === "no runtime for script",
  "an option that cannot run is grayed with its reason"
);
expect(card.axes[1]?.options[0]?.chosen === true, "the body option is chosen");

console.log("world-card.selfcheck ok");
