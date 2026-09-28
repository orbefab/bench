import { confirmActions, confirmLines } from "./world-confirm";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

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

console.log("world-confirm.selfcheck ok");
