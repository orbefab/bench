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

/**
 * `bench run` is its own module. Its static import closure must not reach
 * the server, the live socket, or anything that opens a port.
 */
const forbiddenStem = new Set(["listen", "app", "http", "https", "live", "ws"]);

function forbiddenOf(spec: string): string | null {
  if (
    spec === "node:http" ||
    spec === "node:https" ||
    spec === "http" ||
    spec === "https"
  ) {
    return "http";
  }
  if (spec === "ws" || spec.startsWith("ws/")) return "ws";
  const stem = (spec.split("/").pop() ?? spec).replace(
    /\.(tsx?|jsx?|mjs|cjs)$/,
    ""
  );
  if (!forbiddenStem.has(stem)) return null;
  return stem === "https" ? "http" : stem;
}

function packageDirs(): Map<string, string> {
  const found = new Map<string, string>();
  for (const base of ["packages", "apps"]) {
    for (const entry of readdirSync(path.join(root, base))) {
      const dir = path.join(root, base, entry);
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(dir, "package.json"), "utf8")
        ) as {
          name?: string;
        };
        if (pkg.name) found.set(pkg.name, dir);
      } catch {
        /* not a package */
      }
    }
  }
  return found;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.default === "string") return obj.default;
  if (typeof obj.import === "string") return obj.import;
  return null;
}

function findSource(abs: string): string | null {
  for (const candidate of [
    abs,
    `${abs}.ts`,
    `${abs}.tsx`,
    path.join(abs, "index.ts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function resolveSpec(
  fromFile: string,
  spec: string,
  packages: Map<string, string>
): string | null {
  if (spec.startsWith("."))
    return findSource(path.resolve(path.dirname(fromFile), spec));
  if (!spec.startsWith("@sfab-bench/")) return null;
  const slash = spec.indexOf("/", "@sfab-bench/".length);
  const name = slash === -1 ? spec : spec.slice(0, slash);
  const sub = slash === -1 ? "." : `.${spec.slice(slash)}`;
  const dir = packages.get(name);
  if (!dir) return null;
  const pkg = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8")
  ) as {
    exports?: Record<string, unknown>;
  };
  const target = exportTarget(pkg.exports?.[sub]);
  if (!target) throw new Error(`${name} has no export ${sub}`);
  const source = findSource(path.resolve(dir, target));
  if (!source) throw new Error(`${spec} does not resolve to a source file`);
  return source;
}

function staticSpecs(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  for (const hit of stripped.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (hit[1]) specs.push(hit[1]);
  }
  for (const hit of stripped.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    if (hit[1]) specs.push(hit[1]);
  }
  return specs;
}

const packages = packageDirs();
const entry = path.join(root, "apps/server/src/run.ts");
const seen = new Set<string>();
const pending = [entry];
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const spec of staticSpecs(text)) {
    const banned = forbiddenOf(spec);
    if (banned) {
      throw new Error(
        `${path.relative(root, file)} statically imports ${spec} (${banned})`
      );
    }
    const next = resolveSpec(file, spec, packages);
    if (spec.startsWith(".") && !next) {
      throw new Error(
        `${path.relative(root, file)} import ${spec} did not resolve`
      );
    }
    if (next) pending.push(next);
  }
}
const simEntry = path.join(root, "packages/sim/src/sim.ts");
if (!seen.has(simEntry)) throw new Error("bench run closure did not reach Sim");
if (seen.size < 10)
  throw new Error(`bench run closure is only ${seen.size} files`);
process.stdout.write(
  "boundary: bench run imports neither listen nor app nor http nor live nor ws\n"
);

/** Public names of one module file, following `export *`. */
function exportedNames(file: string, seenFiles = new Set<string>()): string[] {
  if (seenFiles.has(file)) return [];
  seenFiles.add(file);
  const text = readFileSync(file, "utf8");
  const names: string[] = [];
  const decl =
    /export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z0-9_]+)/g;
  for (const hit of text.matchAll(decl)) {
    if (hit[1]) names.push(hit[1]);
  }
  for (const hit of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    const body = hit[1] ?? "";
    for (const part of body.split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const name = piece
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.push(name);
    }
  }
  for (const hit of text.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const spec = hit[1];
    if (!spec) continue;
    const next = resolveSpec(file, spec, packages);
    if (next) names.push(...exportedNames(next, seenFiles));
  }
  return names;
}

const simPkg = JSON.parse(
  readFileSync(path.join(root, "packages/sim/package.json"), "utf8")
) as { exports?: Record<string, string> };
const simNames: string[] = [];
for (const target of Object.values(simPkg.exports ?? {})) {
  if (typeof target !== "string" || !target.endsWith(".ts")) continue;
  simNames.push(...exportedNames(path.resolve(root, "packages/sim", target)));
}
const setters = simNames.filter((name) => name.startsWith("configure"));
if (setters.length > 0) {
  throw new Error(`sim exports configure setter: ${setters.join(", ")}`);
}
process.stdout.write("boundary: sim exports no configure setter\n");
