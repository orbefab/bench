import { ok as expect } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalogTree, filterCatalogTree } from "@sfab-bench/contract";

import { resolveArtifact } from "./cad-pkg";
import { db } from "./db";
import {
  fallbackRoot,
  listProjectFiles,
  openProject,
  registerProject,
  resolveRequestRoot,
  shouldSkipDir,
} from "./projects";

expect(shouldSkipDir("node_modules"), "node_modules skipped");
expect(shouldSkipDir(".git"), "dot dirs skipped");
expect(shouldSkipDir(".cad-venv"), "cad venv skipped");
expect(!shouldSkipDir("STEP"), "STEP is walked");
expect(!shouldSkipDir("references"), "references is walked");

const root = mkdtempSync(join(tmpdir(), "xr-project-"));
mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(root, "node_modules", "pkg", "hidden.step"), "ISO-10303");
mkdirSync(join(root, "cad", "STEP", "envelopes"), { recursive: true });
writeFileSync(join(root, "cad", "STEP", "envelopes", "box.step"), "ISO-10303");
mkdirSync(join(root, "cad", "src"), { recursive: true });
writeFileSync(join(root, "cad", "src", "box.py"), "print(1)\n");
writeFileSync(join(root, "part.glb"), "glTF");

const files = listProjectFiles(root);
expect(
  files.some((f) => f.path === "cad/STEP/envelopes/box.step"),
  "project STEP is listed"
);
expect(
  files.some((f) => f.path === "part.glb" && f.kind === "glb"),
  "project GLB is listed"
);
expect(
  !files.some((f) => f.path.includes("node_modules")),
  "node_modules STEP is ignored"
);
expect(
  !files.some((f) => f.path.endsWith(".py")),
  "python scripts are not documents"
);

const tree = catalogTree(files);
const cad = tree.find((n) => n.type === "dir" && n.name === "cad");
expect(cad?.type === "dir", "catalog keeps cad as a folder");
const stepDir =
  cad?.type === "dir"
    ? cad.children.find((n) => n.type === "dir" && n.name === "STEP")
    : undefined;
expect(stepDir?.type === "dir", "STEP stays nested under cad");
expect(
  filterCatalogTree(tree, "envelopes").length > 0,
  "filter matches folder path"
);

const step = resolveArtifact("cad/STEP/envelopes/box.step", root);
expect(
  !("error" in step) && step.kind === "step",
  "resolve STEP inside project"
);
const py = resolveArtifact("cad/src/box.py", root);
expect("error" in py, "scripts are not artifacts");
const escaped = resolveArtifact("../outside.step", root);
expect("error" in escaped, "parent paths are rejected");
const missing = resolveArtifact("cad/STEP/nope.step", root);
expect("error" in missing, "missing STEP is rejected");

const other = mkdtempSync(join(tmpdir(), "xr-project-b-"));
writeFileSync(join(other, "other.step"), "ISO-10303");
expect(
  "error" in resolveArtifact("other.step", root),
  "artifact from another root is refused"
);
const otherStep = resolveArtifact("other.step", other);
expect(
  !("error" in otherStep) && otherStep.kind === "step",
  "same name resolves inside its own root"
);
expect(
  "error" in resolveArtifact("cad/STEP/envelopes/box.step", other),
  "first root's path is not in the second"
);

const a = mkdtempSync(join(tmpdir(), "xr-fallback-a-"));
const b = mkdtempSync(join(tmpdir(), "xr-named-b-"));
const stray = mkdtempSync(join(tmpdir(), "xr-stray-"));
let registeredPath: string | undefined;
let openedPath: string | undefined;
try {
  const before = fallbackRoot();
  const registered = registerProject(b);
  registeredPath = registered.path;
  expect(fallbackRoot() === before, "register does not set fallback");
  const again = registerProject(b);
  expect(
    again.openedAt === registered.openedAt,
    "repeat register does not bump opened_at"
  );
  const opened = openProject(a);
  openedPath = opened.path;
  expect(fallbackRoot() === opened.path, "open sets fallback");
  const named = resolveRequestRoot(b, "loopback");
  expect(named === registered.path, "loopback ?project= is the named folder");
  expect(
    fallbackRoot() === opened.path,
    "named request does not steal fallback"
  );
  expect(
    resolveRequestRoot(undefined, "loopback") === opened.path,
    "param-less is fallback"
  );
  let pairedStatus = 0;
  try {
    resolveRequestRoot(stray, "paired");
  } catch (err) {
    pairedStatus = (err as { status?: number }).status ?? 0;
  }
  expect(pairedStatus === 403, "paired unknown folder is 403");
} finally {
  for (const path of [registeredPath, openedPath]) {
    if (path) db.prepare("DELETE FROM projects WHERE path = ?").run(path);
  }
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
  rmSync(stray, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}

console.log("project.selfcheck ok");
