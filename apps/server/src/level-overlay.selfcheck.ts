/** Level overlays: variants a project adds to a library part, pinned in the lock. Copies only. */
import { deepStrictEqual, ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LevelOverlayFile, PartFile } from "@sfab-bench/contract";
import { LEVEL_OVERLAY_FORMAT } from "@sfab-bench/contract";
import {
  loadWorldV2,
  lockPathFor,
  planPartRename,
  writeLock,
} from "@sfab-bench/parts";

import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan-host";

const WORLD = "parts/sfab/nano-vcc-usb@1.0.0.json";
const PART = "sfab/nano-power-input@1.0.0";
const OVERLAY = "overlays/sfab/nano-power-input@1.0.0.levels.json";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const libraryFile = join(
  absolutePath(catalogRoot()),
  "parts/sfab/nano-power-input@1.0.0.json"
);

function overlayOf(name: string, level: "1" | "2" = "1"): LevelOverlayFile {
  return {
    format: LEVEL_OVERLAY_FORMAT,
    part: PART,
    axes: {
      behaviour: {
        [level]: {
          variants: {
            [name]: {
              kind: "snapshot",
              ref: "sfab/nano-power-input-behaviour-1@1.0.0",
              omits: ["dynamic response"],
            },
          },
        },
      },
    },
  };
}

function put(project: string, rel: string, value: unknown): void {
  const file = join(project, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function load(project: string) {
  return loadWorldV2(absolutePath(join(project, WORLD)), {
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
  });
}

const project = mkdtempSync(join(tmpdir(), "overlay-"));
try {
  cpSync(nanoDir, project, { recursive: true });
  const libraryBytes = readFileSync(libraryFile, "utf8");
  const plain = load(project);
  expect(plain.lock && plain.diagnostics.length === 0, "the example loads");
  expect(!plain.lock?.overlays, "no overlay, no overlays list");
  const originalSha = plain.lock?.parts.find((row) => row.id === PART)?.sha256;
  expect(originalSha, "the library part is pinned");

  put(project, OVERLAY, overlayOf("capture-1"));
  const withOverlay = load(project);
  const stale = withOverlay.diagnostics.filter((d) =>
    d.message.includes("level overlay")
  );
  expect(
    stale.length === 1 &&
      /missing a resolved level overlay/.test(stale[0]?.message ?? ""),
    `a lock without the overlay row is reported: ${withOverlay.diagnostics.map((d) => d.message).join("; ")}`
  );
  const instances = withOverlay.resolved.filter(
    (inst) => inst.part.id === PART
  );
  expect(instances.length > 0, "the example instances the library part");
  for (const inst of instances) {
    const slot = (inst.part as PartFile).axes?.behaviour?.["1"];
    expect(
      slot?.variants["capture-1"],
      `${inst.path} sees the overlay variant`
    );
    deepStrictEqual(slot?.default, "table");
    expect(slot?.variants.table, "library variants stay");
  }
  deepStrictEqual(readFileSync(libraryFile, "utf8"), libraryBytes);
  const pinned = withOverlay.lock;
  expect(pinned?.overlays?.length === 1, "the lock pins the overlay");
  deepStrictEqual(pinned?.overlays?.[0]?.id, PART);
  deepStrictEqual(pinned?.overlays?.[0]?.path, OVERLAY);
  deepStrictEqual(
    pinned?.parts.find((row) => row.id === PART)?.sha256,
    originalSha
  );

  writeLock(
    nodeStore,
    absolutePath(lockPathFor(join(project, WORLD))),
    pinned!
  );
  const settled = load(project);
  deepStrictEqual(settled.diagnostics, []);

  put(project, OVERLAY, overlayOf("capture-2"));
  const changed = load(project).diagnostics.filter((d) =>
    d.message.includes("level overlay")
  );
  expect(
    changed.length === 1 &&
      /hash mismatch on a level overlay/.test(changed[0]?.message ?? ""),
    "a changed overlay is reported like a changed snapshot"
  );

  put(project, OVERLAY, overlayOf("table"));
  const clash = load(project);
  expect(clash.lock === null || clash.run === null, "a clash does not load");
  expect(
    clash.diagnostics.some((d) => /clashes with a variant/.test(d.message)),
    `a name clash is a diagnostic: ${clash.diagnostics.map((d) => d.message).join("; ")}`
  );
  deepStrictEqual(readFileSync(libraryFile, "utf8"), libraryBytes);

  put(project, OVERLAY, {
    ...overlayOf("capture-1"),
    part: "sfab/other@1.0.0",
  });
  expect(
    load(project).diagnostics.some((d) => /names another part/.test(d.message)),
    "an overlay for another part is refused"
  );

  const flagRel = "parts/sfab/flag@1.0.0.json";
  put(project, "overlays/sfab/flag@1.0.0.levels.json", {
    ...overlayOf("capture-1"),
    part: "sfab/flag@1.0.0",
  });
  const flagFile = absolutePath(join(project, flagRel));
  const flagText = readFileSync(flagFile, "utf8");
  const planned = planPartRename({
    store: nodeStore,
    projectDir: absolutePath(project),
    catalogDir: absolutePath(catalogRoot()),
    file: flagFile,
    text: flagText,
    part: JSON.parse(flagText) as PartFile,
    to: "flag2",
    document: flagRel,
  });
  if ("error" in planned) throw new Error(planned.error);
  const moved = planned.files.filter((item) => item.path.includes("overlays"));
  expect(
    moved.length === 2 &&
      moved.some(
        (item) =>
          item.text === null && item.path.endsWith("flag@1.0.0.levels.json")
      ) &&
      moved.some(
        (item) =>
          item.path.endsWith("flag2@1.0.0.levels.json") &&
          (JSON.parse(item.text ?? "{}") as LevelOverlayFile).part ===
            "sfab/flag2@1.0.0"
      ),
    "rename moves the overlay file and swaps its part id"
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log(
  "level overlay: variant reaches every instance, library file byte-identical, lock pins it, changed overlay and name clash reported"
);
