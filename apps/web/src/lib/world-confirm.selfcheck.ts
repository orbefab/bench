import { ok as expect } from "node:assert/strict";
import { confirmActions, confirmLines, confirmTitle } from "./world-confirm";

const prompt = {
  count: 2,
  message: "Removing nano drops 2 fixed ports.",
  ports: [
    {
      name: "5V",
      dependents: ["wire bench usb.5V", "capture sfab/nano-power@1.0.0"],
    },
    { name: "GND", dependents: [] },
  ],
};

const lines = confirmLines(prompt);
expect(lines.length === 2, "one line per port");
expect(
  lines[0]?.port === "5V" && lines[0].dependents.includes("capture"),
  "a port lists its dependents"
);
expect(lines[1]?.dependents === "none", "a port with no dependents says none");
const actions = confirmActions(prompt);
expect(
  actions.stay === "stay" && actions.breakLabel === "Break 2",
  "Stay and Break N"
);

expect(
  confirmTitle([{ kind: "remove-instance" }]) === "This edit drops fixed ports",
  "an instance edit keeps the fixed-ports title"
);
expect(
  confirmTitle([{ kind: "remove-capture" }]) === "A parent uses this capture",
  "deleting a capture asks about the parent that uses it"
);

console.log("world-confirm.selfcheck ok");
