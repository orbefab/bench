import { resolve } from "node:path";

import { expandUserPath } from "./projects";

export type CliAction =
  | { kind: "help"; error?: string }
  | { kind: "dev" | "serve"; project?: string }
  | { kind: "run"; project: string; world: string; ms?: number };

export function parseCli(argv: string[]): CliAction {
  const args = [...argv];
  if (args.length === 0) return { kind: "serve" };
  const head = args[0];
  if (head === "-h" || head === "--help" || head === "help")
    return { kind: "help" };
  if (head === "open") {
    args.shift();
    const dir = args.shift();
    if (!dir)
      return { kind: "help", error: "usage: sfab-bench open <dir> [--dev]" };
    const project = resolve(expandUserPath(dir));
    const next = args[0];
    if (next === "--dev" || next === "dev") return { kind: "dev", project };
    if (next && next !== "serve")
      return { kind: "help", error: `unknown flag: ${next}` };
    return { kind: "serve", project };
  }
  if (head === "dev") return { kind: "dev" };
  if (head === "serve") return { kind: "serve" };
  if (head === "run") {
    const project = args[1];
    const world = args[2];
    if (!project || !world) {
      return {
        kind: "help",
        error: "usage: sfab-bench run <projectDir> <world> [--ms N]",
      };
    }
    const rest = args.slice(3);
    if (rest.length === 0) {
      return { kind: "run", project: resolve(expandUserPath(project)), world };
    }
    if (rest[0] !== "--ms" || rest.length !== 2) {
      return { kind: "help", error: `unknown flag: ${rest[0]}` };
    }
    const ms = Number(rest[1]);
    if (!Number.isInteger(ms) || ms < 0) {
      return {
        kind: "help",
        error: "usage: sfab-bench run <projectDir> <world> [--ms N]",
      };
    }
    return {
      kind: "run",
      project: resolve(expandUserPath(project)),
      world,
      ms,
    };
  }
  return { kind: "help", error: `unknown command: ${head}` };
}
