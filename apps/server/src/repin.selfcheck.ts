/**
 * `sfab-bench repin` on temp copies of the examples, fixtures and catalog
 * (run 7 unit 2a). A citation edit and a type edit leave stale lock rows;
 * the command re-stamps those rows and the assembly check's `fixture.lock`,
 * changing hash lines only. It refuses, writing nothing, on an id-set
 * change and on a changed document. It never reads a `broken` fixture,
 * never touches a snapshot, and finishes or refuses an interrupted run.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorldV2 } from "@sfab-bench/parts";

import { type RepinOptions, type RepinResult, repin } from "./repin";
import { nodeStore } from "./world/node-store";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const temps: string[] = [];

type Copy = { root: string; opts: RepinOptions };

function copy(): Copy {
  const root = mkdtempSync(join(tmpdir(), "sfab-repin-"));
  temps.push(root);
  cpSync(join(repo, "examples"), join(root, "examples"), { recursive: true });
  cpSync(join(repo, "apps/server/fixtures"), join(root, "fixtures"), {
    recursive: true,
    filter: (src) => !src.includes(`${"fixtures"}/external`),
  });
  cpSync(join(repo, "apps/server/catalog"), join(root, "catalog"), {
    recursive: true,
  });
  return {
    root,
    opts: {
      roots: [join(root, "examples"), join(root, "fixtures")],
      catalogDir: join(root, "catalog"),
      journal: join(root, ".sfab", "repin-plan.json"),
      write: true,
    },
  };
}

/** Every file under a folder, with its bytes. */
function bytesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(file, readFileSync(file, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** Files whose bytes moved, each with its changed lines. */
function moved(
  before: Map<string, string>,
  after: Map<string, string>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of after) {
    const old = before.get(file);
    if (old === text) continue;
    const a = (old ?? "").split("\n");
    const b = text.split("\n");
    expect(a.length === b.length, `${file}: line count changed`);
    out.set(
      file,
      b.filter((line, at) => line !== a[at])
    );
  }
  return out;
}

function edit(file: string, change: (json: Record<string, unknown>) => void) {
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  change(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function lockErrors(root: string, world: string): string[] {
  const file = join(root, "examples", world);
  return loadWorldV2(file, {
    store: nodeStore,
    catalogDir: join(root, "catalog"),
    assetRoot: join(root, "examples", world.split("/")[0] ?? ""),
  })
    .diagnostics.filter((diag) => diag.code === "lock")
    .map((diag) => diag.message);
}

const ARM = "arm/parts/sfab/arm-bench@1.0.0.json";
const RECORD = "examples/arm/checks/sfab/arm-bench@1.0.0.json";
const BROKEN = "fixtures/layered/broken/lock-mismatch/world.lock.json";

function citeSg90(root: string): void {
  edit(join(root, "catalog/parts/sfab/sg90@1.0.0.json"), (part) => {
    (part.sources as unknown[]).push({ title: "repin selfcheck citation" });
  });
}

try {
  // A clean tree has nothing to move.
  {
    const { opts } = copy();
    const result = repin({ ...opts, write: false });
    expect(
      result.changes.length === 0 && result.refusals.length === 0,
      `a clean copy moves nothing: ${JSON.stringify(result)}`
    );
    console.log("repin: a clean tree has every pin current");
  }

  // A citation: the part's lock rows and the arm record's fixture.lock.
  {
    const { root, opts } = copy();
    citeSg90(root);
    expect(lockErrors(root, ARM).length === 1, "the citation stales the lock");
    const snapshots = bytesUnder(join(root, "catalog/snapshots"));
    const before = bytesUnder(root);
    const dry = repin({ ...opts, write: false });
    expect(moved(before, bytesUnder(root)).size === 0, "--dry writes nothing");
    const result = repin(opts);
    expect(result.refusals.length === 0, result.refusals.join("; "));
    expect(
      JSON.stringify(dry.changes) === JSON.stringify(result.changes),
      "--dry lists what a write moves"
    );
    const files = moved(before, bytesUnder(root));
    const locks = [...files.keys()].filter((f) => f.endsWith(".lock.json"));
    expect(locks.length === 7, `7 locks resolve sfab/sg90 (${locks.length})`);
    for (const [file, lines] of files) {
      if (file.endsWith("sg90@1.0.0.json")) continue;
      expect(
        lines.every((line) => /"(sha256|lock)": "[0-9a-f]{64}"/.test(line)),
        `${file}: only hash lines move (${lines.join(" | ")})`
      );
    }
    expect(
      files.get(join(root, RECORD))?.length === 1,
      "the arm record moves its fixture.lock line only"
    );
    expect(lockErrors(root, ARM).length === 0, "the arm lock loads clean");
    expect(
      moved(snapshots, bytesUnder(join(root, "catalog/snapshots"))).size === 0,
      "no snapshot file moves"
    );
    expect(!existsSync(opts.journal), "the journal is gone after a write");
    const again = repin({ ...opts, write: false });
    expect(again.changes.length === 0, "a second run moves nothing");
    console.log(
      `repin: a citation re-stamps 7 locks and the arm record's fixture.lock (${result.changes.length} pins), hash lines only`
    );
  }

  // A type edit: type rows move; the capture signature it stales stays.
  {
    const { root, opts } = copy();
    edit(join(root, "catalog/types/hobby-servo-3wire.json"), (type) => {
      (type.plausible as Record<string, number[]>).Voltage = [-1, 13];
    });
    const snapshots = bytesUnder(join(root, "catalog/snapshots"));
    const result = repin(opts);
    expect(result.refusals.length === 0, result.refusals.join("; "));
    const types = result.changes.filter((c) => c.field === "types[].sha256");
    expect(
      types.length === 8 && types.every((c) => c.id === "hobby-servo-3wire"),
      `8 locks pin hobby-servo-3wire (${types.length})`
    );
    expect(
      moved(snapshots, bytesUnder(join(root, "catalog/snapshots"))).size === 0,
      "provenance.from.hash is not a file pin; it stays"
    );
    console.log(
      "repin: a type edit re-stamps 8 type rows and leaves every capture signature"
    );
  }

  // Refusals write nothing.
  {
    const { root, opts } = copy();
    citeSg90(root);
    edit(
      join(root, "examples/arm/parts/sfab/arm-bench@1.0.0.lock.json"),
      (lock) => {
        (lock.types as unknown[]).pop();
      }
    );
    const before = bytesUnder(root);
    const result = repin(opts);
    expect(
      result.refusals.some((why) => why.includes("types ids changed")),
      `an id-set change is refused: ${result.refusals.join("; ")}`
    );
    expect(
      !result.wrote && moved(before, bytesUnder(root)).size === 0,
      "a refusal writes nothing, not even the other locks"
    );
    console.log("repin: an id-set change is refused and nothing is written");
  }
  {
    const { root, opts } = copy();
    edit(join(root, "examples", ARM), (part) => {
      (part.play as { seed: number }).seed += 1;
    });
    const before = bytesUnder(root);
    const result = repin(opts);
    expect(
      result.refusals.some((why) => why.includes("remeasure")),
      `a changed document is a remeasure: ${result.refusals.join("; ")}`
    );
    expect(moved(before, bytesUnder(root)).size === 0, "nothing written");
    console.log("repin: a changed assembly document is refused (remeasure)");
  }

  // The broken fixture is never read, so never "fixed".
  {
    const { root, opts } = copy();
    const broken = readFileSync(join(root, BROKEN), "utf8");
    citeSg90(root);
    repin(opts);
    expect(
      readFileSync(join(root, BROKEN), "utf8") === broken,
      "the zeroed lock under broken/ stays zeroed"
    );
    console.log("repin: the broken fixture's zeroed lock stays as it is");
  }

  // Interrupted runs: before staging completes, and between renames.
  for (const at of ["stage 0", "rename 0"]) {
    const { root, opts } = copy();
    citeSg90(root);
    const crashed = (() => {
      try {
        repin({
          ...opts,
          step: (now) => {
            if (now === at) throw new Error(`crash at ${now}`);
          },
        });
        return false;
      } catch {
        return true;
      }
    })();
    expect(crashed && existsSync(opts.journal), `${at}: the journal stays`);
    const pending = repin({ ...opts, write: false });
    expect(
      pending.refusals.some((why) => why.includes("interrupted")),
      `${at}: a dry run names the pending journal`
    );
    const done: RepinResult = repin(opts);
    expect(done.wrote && done.refusals.length === 0, `${at}: resumed`);
    expect(!existsSync(opts.journal), `${at}: the journal is gone`);
    expect(lockErrors(root, ARM).length === 0, `${at}: the arm lock is clean`);
    const again = repin({ ...opts, write: false });
    expect(
      again.changes.length === 0 && again.refusals.length === 0,
      `${at}: nothing left to move`
    );
    const leftovers = [...bytesUnder(root).keys()].filter((f) =>
      f.endsWith(".repin-tmp")
    );
    expect(leftovers.length === 0, `${at}: no staged file left`);
  }
  console.log(
    "repin: a run cut off before staging completes or between renames resumes from its journal"
  );
  {
    const { root, opts } = copy();
    citeSg90(root);
    try {
      repin({
        ...opts,
        step: (now) => {
          if (now === "rename 0") throw new Error("crash");
        },
      });
    } catch {}
    const journal = JSON.parse(readFileSync(opts.journal, "utf8")) as {
      files: { file: string }[];
    };
    const last = journal.files.at(-1)?.file;
    expect(last !== undefined, "the journal lists files");
    writeFileSync(last, `${readFileSync(last, "utf8")} `);
    const before = bytesUnder(root);
    const result = repin(opts);
    expect(
      result.refusals.some((why) => why.startsWith(last)),
      `a file edited mid-re-pin is refused by name: ${result.refusals.join("; ")}`
    );
    expect(
      existsSync(opts.journal) && moved(before, bytesUnder(root)).size === 0,
      "the refused resume keeps the journal and writes nothing"
    );
    console.log(
      "repin: a file edited after the interruption is refused by name"
    );
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
console.log("repin selfcheck ok");
