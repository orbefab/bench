import { ok as expect } from "node:assert/strict";
import { extractUrdfJointsAndMeshes } from "@sfab-bench/contract";

import {
  buildWorldOutline,
  formatDegrees,
  formatJointReadout,
  formatLiveDegrees,
  formatPartWire,
  outlinePartLabel,
} from "./world-outline";

const arm = extractUrdfJointsAndMeshes(`
<robot name="arm">
  <link name="base">
    <visual><geometry><mesh filename="meshes/base.stl"/></geometry></visual>
  </link>
  <link name="upper_arm">
    <visual><geometry><mesh filename="meshes/upper_arm.stl"/></geometry></visual>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base"/>
    <child link="upper_arm"/>
    <axis xyz="0 0 1"/>
    <limit lower="0" upper="2.617993877991494"/>
  </joint>
</robot>`);

const gripper = extractUrdfJointsAndMeshes(`
<robot name="gripper">
  <link name="palm">
    <visual><geometry><mesh filename="palm.obj"/></geometry></visual>
  </link>
  <link name="finger">
    <visual><geometry><mesh filename="finger.stl"/></geometry></visual>
  </link>
  <joint name="jaw" type="prismatic">
    <parent link="palm"/>
    <child link="finger"/>
    <axis xyz="1 0 0"/>
    <limit lower="0" upper="0.02"/>
  </joint>
</robot>`);

const outline = buildWorldOutline(
  {
    robots: [{ id: "arm" }, { id: "gripper" }],
    boards: [
      {
        id: "uno",
        chip: "atmega328p",
        firmware: "firmware/hold/hold.hex",
        source: "firmware/hold/hold.ino",
      },
    ],
    parts: [
      {
        id: "servo",
        model: "sg90",
        drives: { robot: "arm", joint: "shoulder" },
        signalPin: "signal",
      },
    ],
    wires: [
      ["usb.5V", "uno.5V"],
      ["usb.GND", "uno.GND"],
      ["uno.D9", "servo.signal"],
      ["uno.5V", "servo.V+"],
      ["uno.GND", "servo.GND"],
    ],
    supplies: [{ id: "usb", voltage: 5, currentLimit: 0.9, rSeries: 0.5 }],
    feeds: { boards: { uno: "usb" }, parts: { servo: "usb" } },
    targets: [{ id: "card" }],
  },
  { arm, gripper }
);

expect(
  outline.robots.map((robot) => robot.id).join(",") === "arm,gripper",
  "two robots"
);
expect(
  outline.boards.length === 1 && outline.boards[0]?.id === "uno",
  "one board"
);
expect(outline.boards[0]?.chip === "atmega328p", "board chip");
expect(
  outline.boards[0]?.firmware === "firmware/hold/hold.hex",
  "firmware path"
);
expect(outline.boards[0]?.source === "firmware/hold/hold.ino", "source path");
expect(outline.targets.join(",") === "card", "target id");

const base = outline.robots[0]?.links.find((link) => link.name === "base");
const upper = outline.robots[0]?.links.find(
  (link) => link.name === "upper_arm"
);
expect(base?.joint === null, "the root link has no parent joint");
expect(base?.meshes.join(",") === "meshes/base.stl", "base mesh");
expect(upper?.joint?.name === "shoulder", "shoulder moves the upper arm");
expect(upper?.joint?.type === "revolute", "shoulder is revolute");
expect(upper?.joint?.axis?.join(" ") === "0 0 1", "shoulder axis");
expect(upper?.meshes.join(",") === "meshes/upper_arm.stl", "upper arm mesh");
const shoulder = upper?.joint;
if (!shoulder) throw new Error("shoulder joint missing");
expect(
  shoulder.lowerDeg !== null && Math.abs(shoulder.lowerDeg) < 1e-6,
  "lower limit is 0°"
);
expect(
  shoulder.upperDeg !== null && Math.abs(shoulder.upperDeg - 150) < 1e-6,
  `upper limit is 150°, got ${shoulder.upperDeg}`
);
expect(
  shoulder.upperDeg !== null && formatDegrees(shoulder.upperDeg) === "150",
  "150° formats"
);

const finger = outline.robots[1]?.links.find((link) => link.name === "finger");
const palm = outline.robots[1]?.links.find((link) => link.name === "palm");
expect(palm?.joint === null, "gripper root");
expect(finger?.joint?.name === "jaw", "jaw moves the finger");
expect(finger?.joint?.type === "prismatic", "jaw is prismatic");
expect(
  finger?.joint?.lowerDeg === null && finger?.joint?.upperDeg === null,
  "prismatic limits stay out of degrees"
);
const jaw = finger?.joint;
if (!jaw) throw new Error("jaw joint missing");
expect(
  jaw.lowerMm !== null &&
    jaw.upperMm !== null &&
    Math.abs(jaw.lowerMm) < 1e-6 &&
    Math.abs(jaw.upperMm - 20) < 1e-6,
  `jaw limits are 0 mm to 20 mm, got ${jaw.lowerMm} ${jaw.upperMm}`
);
expect(finger?.meshes.join(",") === "finger.stl", "finger mesh");
expect(formatLiveDegrees(Math.PI / 2) === "90.0", "a right angle is 90.0");

const revolute = formatJointReadout(shoulder, Math.PI / 2);
expect(revolute.label === "Angle", "a revolute joint is an angle");
expect(revolute.value === "90.0°", `revolute value ${revolute.value}`);
expect(revolute.limits === "0° to 150°", `revolute limits ${revolute.limits}`);

const slide = formatJointReadout(jaw, 0.0125);
expect(slide.label === "Position", "a prismatic joint is a position");
expect(slide.value === "12.5 mm", `prismatic value ${slide.value}`);
expect(slide.limits === "0 mm to 20 mm", `prismatic limits ${slide.limits}`);

const continuous = formatJointReadout(
  {
    name: "spin",
    type: "continuous",
    axis: [0, 0, 1],
    lowerDeg: null,
    upperDeg: null,
    lowerMm: null,
    upperMm: null,
  },
  Math.PI
);
expect(continuous.label === "Angle", "a continuous joint is an angle");
expect(continuous.value === "180.0°", `continuous value ${continuous.value}`);
expect(continuous.limits === null, "a continuous joint has no degree limits");

expect(outline.parts.length === 1, "one part");
const servo = outline.parts[0];
expect(servo?.id === "servo" && servo.model === "sg90", "servo · sg90");
expect(
  outlinePartLabel(servo ?? { id: "", model: "" }) === "servo · sg90",
  "part label"
);
expect(
  servo?.drives?.robot === "arm" && servo.drives.joint === "shoulder",
  "drives shoulder"
);
expect(
  servo?.wires.map(formatPartWire).join(", ") ===
    "signal ← uno.D9, V+ ← uno.5V, GND ← uno.GND",
  `wires ${servo?.wires.map(formatPartWire).join(", ")}`
);
const usb = outline.supplies[0];
expect(outline.supplies.length === 1 && usb?.id === "usb", "one supply");
expect(
  usb?.voltage === 5 && usb.currentLimit === 0.9 && usb.rSeries === 0.5,
  "usb numbers"
);
expect(
  usb?.boards.join(",") === "uno",
  `usb feeds boards ${usb?.boards.join(",")}`
);
expect(
  usb?.parts.join(",") === "servo",
  `usb feeds parts ${usb?.parts.join(",")}`
);

console.log("world-outline.selfcheck ok");
