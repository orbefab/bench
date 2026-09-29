#!/usr/bin/env node
/**
 * Runs self-check files one after another (.ts with tsx, plain .mjs with
 * node) and stops at the first failure. Usage (from a package dir): node ../../scripts/checks.mjs a.ts b.ts
 *
 * ExperimentalWarning is silenced so the log has no process ids. Set
 * CHECK_TIMES=<path> to append "<seconds> <file>" per check to that file.
 */
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
const timesPath = process.env.CHECK_TIMES;

for (const file of files) {
  const start = process.hrtime.bigint();
  const plainJs = /\.[cm]?js$/.test(file);
  const run = spawnSync(plainJs ? process.execPath : "tsx", ["--disable-warning=ExperimentalWarning", file], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (timesPath) {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    appendFileSync(timesPath, `${seconds.toFixed(1)} ${file}\n`);
  }
  if (run.status !== 0) {
    const why = run.error ? run.error.message : (run.signal ?? `exit ${run.status}`);
    console.error(`check failed: ${file} (${why})`);
    process.exit(run.status || 1);
  }
}
