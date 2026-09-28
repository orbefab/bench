import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseCli } from "./cli-parse";

function expect(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}

expect(parseCli([]).kind === "serve", "default is serve");
expect(parseCli(["serve"]).kind === "serve", "serve");
expect(parseCli(["dev"]).kind === "dev", "dev");
expect(parseCli(["help"]).kind === "help", "help");

const opened = parseCli(["open", "/tmp/cad"]);
expect(
  opened.kind === "serve" && opened.project === resolve("/tmp/cad"),
  "open sets project then serve"
);

const openedDev = parseCli(["open", "/tmp/cad", "--dev"]);
expect(
  openedDev.kind === "dev" && openedDev.project === resolve("/tmp/cad"),
  "open --dev"
);

const missing = parseCli(["open"]);
expect(missing.kind === "help", "open without dir is help");

const ran = parseCli([
  "run",
  "/tmp/gauge",
  "gauge-usb.world.json",
  "--ms",
  "3000",
]);
expect(
  ran.kind === "run" &&
    ran.project === resolve("/tmp/gauge") &&
    ran.world === "gauge-usb.world.json" &&
    ran.ms === 3000,
  "run --ms"
);
const ranDefault = parseCli(["run", "/tmp/gauge", "gauge-usb.world.json"]);
expect(
  ranDefault.kind === "run" && ranDefault.ms === undefined,
  "run default span"
);
expect(
  parseCli(["run", "/tmp/gauge"]).kind === "help",
  "run without a world is help"
);

const bin = readFileSync(
  new URL("../bin/sfab-bench.mjs", import.meta.url),
  "utf8"
);
expect(bin.startsWith("#!/usr/bin/env node\n"), "bin shebang");

console.log("cli.selfcheck ok");
