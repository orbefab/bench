import { warnedPaths, warningsByPath, warningText } from "./world-warnings";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const map = warningsByPath({
  warnings: [
    {
      path: "nano",
      message: "fallback from 2 to 1",
      code: "degraded",
    },
  ],
  degraded: [
    {
      path: "nano",
      message: "nano reaches no supply",
      code: "unpowered",
    },
    {
      path: "servo",
      message: "port signal is broken",
      code: "broken-port",
    },
  ],
  diagnostics: [
    {
      path: "servo",
      message: "port signal is broken",
      code: "broken-port",
    },
  ],
  snapshots: [
    {
      path: "servo",
      envelope: ["V+ left the envelope"],
      stale: true,
    },
  ],
  errors: [
    {
      path: "",
      message: "the step is not 1 ms",
      code: "timestep-unsupported",
    },
  ],
});

const nano = map.get("nano") ?? [];
expect(nano.length === 2, `nano has ${nano.length} warnings`);
const servo = map.get("servo") ?? [];
expect(
  servo.map((row) => row.code).join(",") ===
    "broken-port,envelope,stale-capture",
  `servo codes ${servo.map((row) => row.code).join(",")}`
);
expect(
  servo.filter((row) => row.message === "port signal is broken").length === 1,
  "a repeated diagnostic is one warning"
);
const loose = map.get("") ?? [];
expect(
  loose.length === 1 && loose[0]?.message === "the step is not 1 ms",
  "a warning with no path stays on the run"
);
const paths = warnedPaths(map);
expect(
  paths.has("nano") && paths.has("servo") && !paths.has(""),
  "empty paths are not instance icons"
);
expect(
  warningText(servo).includes("stale"),
  "the card text includes the stale capture"
);

console.log("world-warnings.selfcheck ok");
