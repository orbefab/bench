/**
 * `sfab-bench repin` on temp copies of the examples, fixtures and catalog
 * (run 7 unit 2). A citation edit leaves stale lock rows; the command
 * re-stamps them and the assembly check's `fixture.lock`, hash lines only.
 * A type edit that moves a capture signature is accepted only when a dry
 * capture reproduces every other byte of the snapshot; an edit that moves
 * a fitted number, or that the capture cannot reach, is refused and
 * nothing is written. It refuses an id-set change and a changed document,
 * never reads a `broken` fixture, and finishes or refuses an interrupted
 * run.
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

import type { SnapshotFile } from "@sfab-bench/contract";
import { loadWorldV2 } from "@sfab-bench/parts";
import { provenanceHash } from "@sfab-bench/sim/freshness";

import { type RepinOptions, type RepinResult, repin } from "./repin";
import { nodeStore } from "./world/node-store";
import { nodeStampEnv } from "./world/plan-host";

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

/** Catalog snapshots whose recorded signature is not their source's today. */
function staleSnapshots(root: string): string[] {
  const catalogDir = join(root, "catalog");
  return [...bytesUnder(join(catalogDir, "snapshots")).entries()].flatMap(
    ([file, text]) => {
      const snap = JSON.parse(text) as SnapshotFile;
      const fresh = provenanceHash(
        snap,
        { catalogDir, worldDir: catalogDir },
        nodeStampEnv
      );
      return fresh.checked && fresh.hash !== snap.provenance.from?.hash
        ? [file]
        : [];
    }
  );
}

/** Each changed line is a 64-hex hash field. */
function hashLinesOnly(files: Map<string, string[]>, skip: string): void {
  for (const [file, lines] of files) {
    if (file.endsWith(skip)) continue;
    expect(
      lines.every((line) =>
        /"(sha256|lock|hash|fromHash)": "[0-9a-f]{64}"/.test(line)
      ),
      `${file}: only hash lines move (${lines.join(" | ")})`
    );
  }
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
    const result = await repin({ ...opts, write: false });
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
    const dry = await repin({ ...opts, write: false });
    expect(moved(before, bytesUnder(root)).size === 0, "--dry writes nothing");
    const result = await repin(opts);
    expect(result.refusals.length === 0, result.refusals.join("; "));
    expect(
      JSON.stringify(dry.changes) === JSON.stringify(result.changes),
      "--dry lists what a write moves"
    );
    const files = moved(before, bytesUnder(root));
    const locks = [...files.keys()].filter((f) => f.endsWith(".lock.json"));
    expect(locks.length === 7, `7 locks resolve sfab/sg90 (${locks.length})`);
    hashLinesOnly(files, "sg90@1.0.0.json");
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
    const again = await repin({ ...opts, write: false });
    expect(again.changes.length === 0, "a second run moves nothing");
    console.log(
      `repin: a citation re-stamps 7 locks and the arm record's fixture.lock (${result.changes.length} pins), hash lines only`
    );
  }

  // A type edit that stales a signature: a dry capture reproduces every
  // other byte, so the signature and the pins that follow it move.
  {
    const { root, opts } = copy();
    edit(join(root, "catalog/types/hobby-servo-3wire.json"), (type) => {
      (type.plausible as Record<string, number[]>).Voltage = [-1, 13];
    });
    expect(
      staleSnapshots(root).length === 1,
      "the plausible edit stales the servo group signature"
    );
    const before = bytesUnder(root);
    const result = await repin(opts);
    expect(result.refusals.length === 0, result.refusals.join("; "));
    const fields = (name: string) =>
      result.changes.filter((c) => c.field === name);
    expect(
      fields("types[].sha256").length === 8 &&
        fields("provenance.from.hash").length === 1 &&
        fields("provenance.from.hash")[0]?.id === "sfab/sg90-servo@1.0.0" &&
        fields("children[].fromHash").length === 1,
      `type rows, the servo signature and the record's fromHash move: ${result.changes.map((c) => c.field).join(", ")}`
    );
    const files = moved(before, bytesUnder(root));
    hashLinesOnly(files, "hobby-servo-3wire.json");
    expect(
      files.get(join(root, "catalog/snapshots/sfab/sg90-servo@1.0.0.json"))
        ?.length === 1,
      "the servo snapshot moves its from.hash line only"
    );
    expect(staleSnapshots(root).length === 0, "every snapshot is fresh");
    expect(lockErrors(root, ARM).length === 0, "the arm lock loads clean");
    const again = await repin({ ...opts, write: false });
    expect(again.changes.length === 0, "a second run moves nothing");
    console.log(
      "repin: a type edit the dry capture reproduces moves the servo signature, its lock rows and the record's pins, hash lines only"
    );
  }

  // Edits whose numbers move: refused, and nothing is written.
  for (const [label, file, change, needle] of [
    [
      "a fitted LED resistance",
      "catalog/parts/sfab/led-red@1.0.0.json",
      (text: string) => text.replace('"Rs": 13.37110059679469', '"Rs": 15'),
      "led-module-red@1.0.0.json: a dry capture moves params",
    ],
    [
      "a shaft torque rating past the fixture's sweep",
      "catalog/parts/sfab/sg90@1.0.0.json",
      (text: string) => text.replaceAll("0.176", "0.177"),
      "sg90-hinge@1.0.0.json: the dry capture failed",
    ],
  ] as const) {
    const { root, opts } = copy();
    const at = join(root, file);
    const text = readFileSync(at, "utf8");
    expect(change(text) !== text, `${label}: the edit applies`);
    writeFileSync(at, change(text));
    const before = bytesUnder(root);
    const result = await repin(opts);
    expect(
      result.refusals.some((why) => why.includes(needle)),
      `${label}: refused (${result.refusals.join("; ")})`
    );
    expect(
      !result.wrote && moved(before, bytesUnder(root)).size === 0,
      `${label}: nothing written, the old signature and numbers stay`
    );
  }
  console.log(
    "repin: a moved fitted number and an unreachable rating are refused; nothing is written"
  );

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
    const result = await repin(opts);
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
    const result = await repin(opts);
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
    await repin(opts);
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
    const crashed = await (async () => {
      try {
        await repin({
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
    const pending = await repin({ ...opts, write: false });
    expect(
      pending.refusals.some((why) => why.includes("interrupted")),
      `${at}: a dry run names the pending journal`
    );
    const done: RepinResult = await repin(opts);
    expect(done.wrote && done.refusals.length === 0, `${at}: resumed`);
    expect(!existsSync(opts.journal), `${at}: the journal is gone`);
    expect(lockErrors(root, ARM).length === 0, `${at}: the arm lock is clean`);
    const again = await repin({ ...opts, write: false });
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
      await repin({
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
    const result = await repin(opts);
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
  // Review round 1: a snapshot whose numbers moved is not a file pin.
  {
    const { root, opts } = copy();
    const file = join(root, "catalog/snapshots/sfab/sg90-servo@1.0.0.json");
    const text = readFileSync(file, "utf8");
    const edited = text.replace("0.00539279", "0.00939279");
    expect(edited !== text, "the servo snapshot states that error row");
    writeFileSync(file, edited);
    const before = bytesUnder(root);
    const result = await repin(opts);
    expect(
      result.refusals.some((why) =>
        why.includes(
          "servo sfab/sg90-servo@1.0.0 changed since the record was measured"
        )
      ),
      `an edited snapshot error row is a remeasure: ${result.refusals.join("; ")}`
    );
    expect(moved(before, bytesUnder(root)).size === 0, "nothing written");
    console.log(
      "repin: a snapshot whose stated numbers moved is refused for the record that measured it"
    );
  }

  // An escaped copy of an old hash elsewhere in a file is refused.
  {
    const { root, opts } = copy();
    citeSg90(root);
    const record = join(root, RECORD);
    const json = JSON.parse(readFileSync(record, "utf8")) as {
      fixture: { lock: string };
    };
    const escaped = [...json.fixture.lock]
      .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    writeFileSync(
      record,
      readFileSync(record, "utf8").replace(
        '"format"',
        `"note": "${escaped}",\n  "format"`
      )
    );
    const before = bytesUnder(root);
    const result = await repin(opts);
    expect(
      result.refusals.some((why) => why.includes("would change another value")),
      `an escaped copy is refused: ${result.refusals.join("; ")}`
    );
    expect(moved(before, bytesUnder(root)).size === 0, "nothing written");
    console.log("repin: an escaped copy of an old hash is refused");
  }

  // A journal that does not parse, or whose bytes do not match their digest.
  for (const [label, spoil] of [
    ["a corrupt journal", () => "{"],
    [
      "a journal whose bytes do not match their digest",
      (text: string) => {
        const journal = JSON.parse(text) as { files: { text: string }[] };
        const first = journal.files[0];
        if (first) first.text = `${first.text} `;
        return JSON.stringify(journal);
      },
    ],
  ] as const) {
    const { root, opts } = copy();
    citeSg90(root);
    try {
      await repin({
        ...opts,
        step: (now) => {
          if (now === "journal") throw new Error("crash");
        },
      });
    } catch {}
    writeFileSync(opts.journal, spoil(readFileSync(opts.journal, "utf8")));
    const before = bytesUnder(root);
    const result = await repin(opts);
    expect(
      !result.wrote && result.refusals.length > 0,
      `${label}: refused (${result.refusals.join("; ")})`
    );
    expect(
      existsSync(opts.journal) && moved(before, bytesUnder(root)).size === 0,
      `${label}: kept, and nothing written`
    );
  }
  console.log(
    "repin: a corrupt journal and one whose bytes fail their digest are refused and kept"
  );

  // A file that drifts after the journal is written, in the same run.
  {
    const { root, opts } = copy();
    citeSg90(root);
    const arm = join(root, "examples", ARM.replace(/\.json$/, ".lock.json"));
    const result = await repin({
      ...opts,
      step: (now) => {
        if (now === "journal") {
          writeFileSync(arm, `${readFileSync(arm, "utf8")} `);
        }
      },
    });
    expect(
      !result.wrote && result.refusals.some((why) => why.startsWith(arm)),
      `a file edited mid-run is refused by name: ${result.refusals.join("; ")}`
    );
    expect(existsSync(opts.journal), "the journal stays");
    expect(
      ![...bytesUnder(root).keys()].some((f) => f.endsWith(".repin-tmp")),
      "nothing was staged"
    );
    console.log("repin: a file edited during a run is refused before staging");
  }

  // A folder the user names must exist.
  {
    const { root, opts } = copy();
    const result = await repin({
      ...opts,
      roots: [join(root, "no-such-folder")],
    });
    expect(
      result.refusals.some((why) => why.includes("not a folder")),
      "a missing folder is refused, not reported current"
    );
    console.log("repin: a named folder that does not exist is refused");
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
console.log("repin selfcheck ok");
