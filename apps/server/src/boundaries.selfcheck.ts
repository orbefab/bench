/**
 * ADR 0012. Upward imports and host globals, planted and removed.
 * The refusals are Biome's. The lines have no temp path and no timing.
 */
import { spawnSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const biome = fileURLToPath(
  new URL("../../../node_modules/.bin/biome", import.meta.url)
);

function refuse(
  rel: string,
  source: string,
  rule: string,
  needle: string,
  line: string
): void {
  const abs = path.join(root, rel);
  writeFileSync(abs, source);
  try {
    const result = spawnSync(
      biome,
      ["lint", rel, "--colors=off", "--diagnostic-level=error"],
      { cwd: root, encoding: "utf8" }
    );
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const refused =
      result.status !== 0 && text.includes(rule) && text.includes(needle);
    if (!refused) throw new Error(`boundary probe was not refused:\n${text}`);
    process.stdout.write(`${line}\n`);
  } finally {
    rmSync(abs, { force: true });
  }
}

const partsProbe = "packages/parts/src/_boundary_probe.ts";
const engineProbe = "packages/engine-circuit/src/_boundary_probe.ts";
const webProbe = "apps/web/src/_boundary_probe.ts";

refuse(
  partsProbe,
  'import "node:fs";\n',
  "lint/style/noRestrictedImports",
  "parts imports neither node nor an engine nor the server nor apps",
  `boundary: refused import "node:fs" in ${partsProbe} (parts imports neither node nor an engine nor the server nor apps)`
);
refuse(
  engineProbe,
  'import "@sfab-bench/parts";\n',
  "lint/style/noRestrictedImports",
  "an engine imports neither node nor parts nor the server nor apps",
  `boundary: refused import "@sfab-bench/parts" in ${engineProbe} (an engine imports neither node nor parts nor the server nor apps)`
);
const mcuToCircuit = "packages/engine-mcu/src/_boundary_probe.ts";
refuse(
  mcuToCircuit,
  'import "@sfab-bench/engine-circuit";\n',
  "lint/style/noRestrictedImports",
  "an engine does not import another engine",
  `boundary: refused import "@sfab-bench/engine-circuit" in ${mcuToCircuit} (an engine does not import another engine)`
);
refuse(
  webProbe,
  'import "@sfab-bench/engine-circuit";\n',
  "lint/style/noRestrictedImports",
  "the web client imports neither parts nor an engine",
  `boundary: refused import "@sfab-bench/engine-circuit" in ${webProbe} (the web client imports neither parts nor an engine)`
);
refuse(
  partsProbe,
  "export const host = process.cwd();\n",
  "lint/style/noRestrictedGlobals",
  "L1 and L2 do not use the Node host",
  `boundary: refused global process in ${partsProbe} (L1 and L2 do not use the Node host)`
);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
}

const packagesDir = path.join(root, "packages");
const layerRoots = [
  path.join(packagesDir, "parts", "src"),
  ...readdirSync(packagesDir)
    .filter((name) => name.startsWith("engine-"))
    .sort()
    .map((name) => path.join(packagesDir, name, "src")),
];
const files: string[] = [];
for (const dir of layerRoots) walk(dir, files);

const specifier = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (text.includes("globalThis")) {
    throw new Error(`${path.relative(root, file)} contains globalThis`);
  }
  const pkg = path.join(
    root,
    "packages",
    path.relative(root, file).split(path.sep)[1] ?? ""
  );
  specifier.lastIndex = 0;
  for (const hit of text.matchAll(specifier)) {
    const spec = hit[1];
    if (!spec?.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(file), spec);
    const out = path.relative(pkg, resolved);
    if (
      out === ".." ||
      out.startsWith(`..${path.sep}`) ||
      path.isAbsolute(out)
    ) {
      throw new Error(
        `${path.relative(root, file)} import ${spec} leaves the package`
      );
    }
  }
}

process.stdout.write(
  `boundary: scanned ${files.length} L1/L2 files for globalThis\n`
);

const simProbe = "packages/sim/src/_boundary_probe.ts";
refuse(
  simProbe,
  'import "node:fs";\n',
  "lint/style/noRestrictedImports",
  "sim imports neither node nor the server nor apps",
  `boundary: refused import "node:fs" in ${simProbe} (sim imports neither node nor the server nor apps)`
);
refuse(
  simProbe,
  'import "@sfab-bench/server";\n',
  "lint/style/noRestrictedImports",
  "sim imports neither node nor the server nor apps",
  `boundary: refused import "@sfab-bench/server" in ${simProbe} (sim imports neither node nor the server nor apps)`
);
refuse(
  simProbe,
  "export const host = process.cwd();\n",
  "lint/style/noRestrictedGlobals",
  "L3 does not use the Node host",
  `boundary: refused global process in ${simProbe} (L3 does not use the Node host)`
);

const simFiles: string[] = [];
walk(path.join(packagesDir, "sim", "src"), simFiles);
for (const file of simFiles) {
  const text = readFileSync(file, "utf8");
  if (text.includes("globalThis")) {
    throw new Error(`${path.relative(root, file)} contains globalThis`);
  }
  const pkg = path.join(root, "packages", "sim");
  specifier.lastIndex = 0;
  for (const hit of text.matchAll(specifier)) {
    const spec = hit[1];
    if (!spec?.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(file), spec);
    const out = path.relative(pkg, resolved);
    if (
      out === ".." ||
      out.startsWith(`..${path.sep}`) ||
      path.isAbsolute(out)
    ) {
      throw new Error(
        `${path.relative(root, file)} import ${spec} leaves the package`
      );
    }
  }
}
process.stdout.write(
  `boundary: scanned ${simFiles.length} L3 files for globalThis\n`
);
