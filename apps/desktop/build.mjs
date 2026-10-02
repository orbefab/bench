#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** Bundles the Electron main process, its preload, and the API server. */
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverPkg = JSON.parse(
  readFileSync(new URL("../server/package.json", import.meta.url), "utf8")
);

// Real npm dependencies stay on disk (some read their own files at runtime, and the
// 66 MB OCCT wasm has no business inside a bundle). Workspace packages are ours and
// are TypeScript, so they have to be bundled in.
const runtimeDeps = Object.keys(serverPkg.dependencies).filter(
  (name) => !name.startsWith("@sfab-bench/")
);

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  absWorkingDir: here,
};

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  format: "cjs",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  format: "cjs",
  external: ["electron"],
});

// Emitted into the server package, not this one: its dependencies are installed
// there, and pnpm will not resolve them from apps/desktop/dist.
await build({
  ...common,
  entryPoints: ["../server/src/listen.ts"],
  outfile: "../server/dist/api.mjs",
  format: "esm",
  external: runtimeDeps,
});

// The tessellation thread is its own entry point: `new Worker(path)` needs a real
// file, and it must not be the server bundle, which starts listening on import.
// `occt/build.ts` looks for it by this name beside itself.
await build({
  ...common,
  entryPoints: ["../server/src/occt/worker.ts"],
  outfile: "../server/dist/occt-worker.mjs",
  format: "esm",
  external: runtimeDeps,
});

// The world thread is its own entry too. `world/host.ts` looks for this name
// beside the server bundle. MuJoCo stays external so its wasm resolves from
// the package, next to mujoco.js. avr8js is external the same way: it is a
// server dependency, so `runtimeDeps` keeps it out of the bundle.
await build({
  ...common,
  entryPoints: ["../server/src/world/worker.ts"],
  outfile: "../server/dist/world-worker.mjs",
  format: "esm",
  external: runtimeDeps,
});
