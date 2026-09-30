import { ok as expect } from "node:assert/strict";
import {
  confirmActions,
  confirmBody,
  confirmLines,
  confirmTitle,
} from "./world-confirm";

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

const serverSentence =
  "This removes capture-1, which 1 level rule select (nano.power default). Nothing changed. Send it again with break to put those rules back on the level's default.";
const body = confirmBody([{ kind: "remove-capture", variant: "capture-1" }], {
  count: 1,
  message: serverSentence,
  ports: [{ name: "capture-1", dependents: ["nano.power default"] }],
});
expect(
  body.startsWith("Deleting capture-1 breaks 1 rule that uses it: ") &&
    !body.includes("is deleted") &&
    body.includes("nano.power default") &&
    body.includes("back to the level's default") &&
    !body.includes("Send it again") &&
    !body.includes("with break"),
  "the capture dialog names the capture and the rule, and not the resend wording"
);
const plural = confirmBody([{ kind: "remove-capture", variant: "capture-2" }], {
  count: 2,
  message: serverSentence,
  ports: [
    {
      name: "capture-2",
      dependents: ["nano.power default", "nano.rail path"],
    },
  ],
});
expect(
  plural.startsWith("Deleting capture-2 breaks 2 rules that use it: ") &&
    plural.includes("nano.power default; nano.rail path"),
  "two rules read 'rules that use it'"
);
expect(
  confirmBody([{ kind: "remove-instance" }], prompt) === prompt.message,
  "the fixed-ports dialog keeps the server's sentence"
);

console.log("world-confirm.selfcheck ok");
