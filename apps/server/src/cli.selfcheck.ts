import { ok as expect } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCli } from "./cli-parse";

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
  "parts/sfab/gauge-usb@1.0.0.json",
  "--ms",
  "3000",
]);
expect(
  ran.kind === "run" &&
    ran.project === resolve("/tmp/gauge") &&
    ran.world === "parts/sfab/gauge-usb@1.0.0.json" &&
    ran.ms === 3000,
  "run --ms"
);
const ranDefault = parseCli([
  "run",
  "/tmp/gauge",
  "parts/sfab/gauge-usb@1.0.0.json",
]);
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

const binPath = fileURLToPath(
  new URL("../bin/sfab-bench.mjs", import.meta.url)
);
function runMissing(args: string[], initCwd: string) {
  return spawnSync(process.execPath, [binPath, "run", ...args], {
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: initCwd },
    timeout: 60_000,
  });
}
const relative = runMissing(
  ["no-such-project", "w.world.json"],
  "/tmp/sfab-bench-init-a2b"
);
expect(relative.status === 1, "relative missing project exits 1");
expect(
  relative.stderr ===
    "bench run: /tmp/sfab-bench-init-a2b/no-such-project not found\n",
  `relative project resolves against INIT_CWD (${relative.stderr})`
);
expect(
  !relative.stdout.includes("undefined"),
  "relative failure has no undefined"
);
const absent = runMissing(
  ["/tmp/sfab-bench-missing-a2b", "w.world.json"],
  "/tmp/sfab-bench-other-cwd"
);
expect(absent.status === 1, "missing folder exits 1");
expect(
  absent.stderr === "bench run: /tmp/sfab-bench-missing-a2b not found\n",
  `missing folder line (${absent.stderr})`
);
expect(!absent.stdout.includes("undefined"), "missing folder has no undefined");

console.log("cli.selfcheck ok");
