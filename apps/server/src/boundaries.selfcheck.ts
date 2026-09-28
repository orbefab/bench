/**
 * ADR 0012. One upward import, planted under `packages/parts` and removed.
 * The refusal is Biome's. The printed line has no temp path and no timing.
 */
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const biome = fileURLToPath(
  new URL("../../../node_modules/.bin/biome", import.meta.url)
);
const rel = "packages/parts/src/_boundary_probe.ts";
const abs = fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const specifier = "node:fs";
const message =
  "parts imports neither node nor an engine nor the server nor apps";

writeFileSync(abs, `import "${specifier}";\n`);
try {
  const result = spawnSync(
    biome,
    ["lint", rel, "--colors=off", "--diagnostic-level=error"],
    { cwd: root, encoding: "utf8" }
  );
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const refused =
    result.status !== 0 &&
    text.includes("lint/style/noRestrictedImports") &&
    text.includes(message) &&
    text.includes(specifier);
  if (!refused) {
    throw new Error(`boundary probe was not refused:\n${text}`);
  }
  process.stdout.write(
    `boundary: refused import "${specifier}" in ${rel} (${message})\n`
  );
} finally {
  rmSync(abs, { force: true });
}
