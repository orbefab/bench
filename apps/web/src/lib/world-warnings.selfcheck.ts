import { ok as expect } from "node:assert/strict";
import {
  documentWarnings,
  instanceWarningMap,
  instanceWarnings,
  warnedPaths,
  warningsByPath,
  warningText,
} from "./world-warnings";

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

const play = warningsByPath({
  warnings: [
    {
      path: "$root",
      port: "play",
      message: "play.timestep 0.002 s is not supported yet; the run steps 1 ms",
      code: "timestep-unsupported",
    },
    {
      path: "$root",
      port: "5V",
      message: "the stage reaches no supply",
      code: "unpowered",
    },
  ],
});
expect(
  documentWarnings(play).length === 1 &&
    documentWarnings(play)[0]?.code === "timestep-unsupported",
  "a play diagnostic is document-level"
);
expect(
  instanceWarnings(play, "$root").length === 1 &&
    instanceWarnings(play, "$root")[0]?.code === "unpowered",
  "a real warning on $root stays on the stage"
);
expect(
  warnedPaths(play).has("$root") &&
    instanceWarningMap(play).get("$root")?.length === 1,
  "the stage icon is the part warning, not the time step"
);
expect(documentWarnings(map).length === 1, "an empty path is document-level");

// A capture freshness could not check marks its path, with the reason.
const REASON =
  "the group reaches sfab/x@1.0.0, whose snapshot files its signature does not cover";
const unchecked = warningsByPath({
  snapshots: [
    { path: "nano.power", unchecked: REASON },
    { path: "nano.led", unchecked: null },
  ],
});
const power = unchecked.get("nano.power") ?? [];
expect(
  power.length === 1 &&
    power[0]?.code === "unchecked-capture" &&
    power[0].message.includes(REASON),
  `unchecked capture ${JSON.stringify(power)}`
);
expect(
  warnedPaths(unchecked).has("nano.power") &&
    !warnedPaths(unchecked).has("nano.led"),
  "a checked capture is not marked"
);

console.log("world-warnings.selfcheck ok");
