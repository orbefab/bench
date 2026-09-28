import { resolve } from "node:path";
import { parseCli } from "./cli-parse";
import { loadHomeEnv } from "./config";

const HELP = `sfab-bench — CAD workbench

  sfab-bench              serve dist + API on :7322
  sfab-bench serve
  sfab-bench dev          Vite + API (development)
  sfab-bench open <dir>   open that folder, then serve
  sfab-bench open <dir> --dev
  sfab-bench run <projectDir> <world> [--ms N]
`;

async function main() {
  const action = parseCli(process.argv.slice(2));
  if (action.kind === "help") {
    if (action.error) console.error(action.error);
    console.log(HELP);
    process.exit(action.error ? 1 : 0);
  }
  if (action.kind === "run") {
    const { DEFAULT_RUN_MS, runCli } = await import("./run");
    await runCli({
      project: action.project,
      world: action.world,
      ms: action.ms ?? DEFAULT_RUN_MS,
    });
    return;
  }
  loadHomeEnv();
  if (action.project) process.env.SFAB_BENCH_PROJECT = resolve(action.project);
  if (action.kind === "dev") {
    await import("./dev");
    return;
  }
  await import("./listen");
}

void main();
