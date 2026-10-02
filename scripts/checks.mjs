#!/usr/bin/env node
/**
 * Runs self-check files in one process with node's test runner, through
 * tsx (plain node when every file is .js or .mjs). Usage (from a package
 * dir): node ../../scripts/checks.mjs a.ts b.ts
 *
 * Each file is a top-level script: node:test imports the files one after
 * another, in name order, and a file that throws fails as one test. A
 * failure does not stop the files after it; the run exits 1 at the end.
 * `--test-force-exit` ends the run when the last file is done, so a check
 * that leaves a handle open cannot hang it. The dot reporter keeps the
 * checks' own lines as the log.
 *
 * ExperimentalWarning is silenced so the log has no process ids. Set
 * CHECK_TIMES=<path> to write node's spec report, one line and duration
 * per file, to that file.
 */
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
const timesPath = process.env.CHECK_TIMES;

const reporters = ["--test-reporter=dot", "--test-reporter-destination=stdout"];
if (timesPath) {
  reporters.push(
    "--test-reporter=spec",
    `--test-reporter-destination=${timesPath}`
  );
}

const plainJs = files.every((file) => /\.[cm]?js$/.test(file));
const run = spawnSync(
  plainJs ? process.execPath : "tsx",
  [
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--experimental-test-isolation=none",
    "--test-force-exit",
    ...reporters,
    ...files,
  ],
  { stdio: "inherit", shell: process.platform === "win32" }
);
if (run.status !== 0) {
  const why = run.error
    ? run.error.message
    : (run.signal ?? `exit ${run.status}`);
  console.error(`checks failed (${why})`);
  process.exit(run.status || 1);
}
