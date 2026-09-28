import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { parseCli } from "./cli-parse";
import { loadHomeEnv } from "./config";

const HELP = `sfab-bench — CAD workbench

  sfab-bench              serve dist + API on :7322
  sfab-bench serve
  sfab-bench dev          Vite + API (development)
  sfab-bench open <dir>   open that folder, then serve
  sfab-bench open <dir> --dev
  sfab-bench run <projectDir> <world> [--ms N]
  sfab-bench convert <world.json>
`;

async function main() {
  const action = parseCli(process.argv.slice(2));
  if (action.kind === "help") {
    if (action.error) console.error(action.error);
    console.log(HELP);
    process.exit(action.error ? 1 : 0);
  }
  if (action.kind === "convert") {
    const world = resolve(action.world);
    if (!existsSync(world) || !statSync(world).isFile()) {
      console.error(`bench convert: ${world} not found`);
      process.exit(1);
    }
    const { convertWorldFile } = await import("@sfab-bench/parts");
    const { nodeStore } = await import("./world/node-store");
    const { catalogRoot } = await import("./world/plan-host");
    const project = dirname(world);
    const wrote = convertWorldFile(world, {
      store: nodeStore,
      catalogDir: catalogRoot(),
      assetRoot: project,
    });
    const rel = (file: string) => relative(project, file) || file;
    process.stdout.write(`${rel(wrote.partFile)}\n${rel(wrote.lockFile)}\n`);
    return;
  }
  if (action.kind === "run") {
    const project = resolveRunProject(action.project);
    if (!existsSync(project) || !statSync(project).isDirectory()) {
      console.error(`bench run: ${project} not found`);
      process.exit(1);
    }
    const { DEFAULT_RUN_MS, runCli } = await import("./run");
    await runCli({
      project,
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

/** Relative `run` paths follow pnpm's `INIT_CWD`, then the process cwd. */
function resolveRunProject(project: string): string {
  if (isAbsolute(project)) return project;
  const base = process.env.INIT_CWD?.trim() || process.cwd();
  return resolve(base, project);
}

void main();
