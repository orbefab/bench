/**
 * `sfab-bench repin`: re-stamp the pins a part or type edit leaves behind
 * (run 7 unit 2). A file pin is a hash that says which bytes a file had: a
 * lock row, and in an assembly check the lock it was measured with
 * (`fixture.lock`) and each child snapshot file (`children[].hash`). A
 * capture signature (`provenance.from.hash`, and an assembly child's
 * `fromHash`) says which source a snapshot's numbers came from.
 *
 * The command only replaces a pin with the hash the loader already
 * computes for the file as it is now. It never touches a measurement, and
 * it refuses (writes nothing, exit 1) when the change is more than a pin:
 *
 * - a world that does not load for a reason other than its lock;
 * - a lock whose set of ids changed (a structural edit, not a re-pin);
 * - an assembly check whose document changed (`fixture.hash`): that is a
 *   remeasure (`assembly.selfcheck --write`);
 * - an assembly check whose `fixture.lock` is neither the current lock nor
 *   the re-pinned one;
 * - a catalog snapshot whose signature moved, unless a dry capture into a
 *   temp catalog reproduces every other byte of it. A new signature over
 *   old numbers would claim the numbers came from the new source.
 *
 * A path with a `broken` segment is never read: those fixtures are wrong
 * on purpose.
 *
 * Writes are staged and recoverable, not atomic as a set. The plan, with
 * each file's old and new bytes, goes to a journal before the first
 * rename. A later run finishes a journal it finds: each file must hold
 * exactly its old or its planned new bytes, or the run refuses.
 *
 * This is the maintenance exception to ADR 0012's one edit path: it
 * changes hash fields only, never document meaning.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import type { SnapshotFile } from "@sfab-bench/contract";
import {
  contentHash,
  loadWorldV2,
  parsePartRef,
  type Store,
} from "@sfab-bench/parts";
import type { CaptureRun } from "@sfab-bench/sim/capture";
import { provenanceHash } from "@sfab-bench/sim/freshness";

import { captureFromConfig } from "./capture";
import { nodeStore } from "./world/node-store";
import { nodeStampEnv } from "./world/plan-host";

const ASSEMBLY_FORMAT = "sfab.assembly-check@1";
const JOURNAL_FORMAT = "sfab.repin-plan@1";
const LOCK_SECTIONS = ["parts", "types", "snapshots", "overlays"] as const;
const CAPTURE_CONFIG = join("fixtures", "capture.config.json");

export type RepinChange = {
  file: string;
  field: string;
  id: string;
  from: string;
  to: string;
};

export type RepinResult = {
  changes: RepinChange[];
  refusals: string[];
  /** True when files were written (or a pending journal was finished). */
  wrote: boolean;
};

export type RepinOptions = {
  /** Folders scanned for locks and assembly checks. */
  roots: string[];
  catalogDir: string;
  /** Where the plan is kept while files are written. */
  journal: string;
  write: boolean;
  /** Test hook, called at each write step; a throw is a crash there. */
  step?: (at: string) => void;
};

type Planned = { file: string; text: string };

type JournalEntry = { file: string; old: string; next: string; text: string };

type Journal = { format: string; id: string; files: JournalEntry[] };

type LockRow = { id: string; sha256: string };

type LockJson = {
  format?: string;
  world?: string;
} & Partial<Record<(typeof LOCK_SECTIONS)[number], LockRow[]>>;

type AssemblyJson = {
  format?: string;
  document: string;
  fixture: { hash: string; lock: string };
  children: { path: string; ref: string; hash: string; fromHash: string }[];
};

type CaptureConfig = { entries: { id: string }[] };

/** Planned bytes by absolute path; read before the disk. */
type Plan = Map<string, Planned>;

export async function repin(opts: RepinOptions): Promise<RepinResult> {
  if (existsSync(opts.journal)) return resume(opts);
  const changes: RepinChange[] = [];
  const refusals: string[] = [];
  for (const root of opts.roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      refusals.push(`${root}: not a folder`);
    }
  }
  const snapshots: Plan = new Map();
  const signatures = new Map<string, string>();
  for (const file of filesUnder(
    [join(opts.catalogDir, "snapshots")],
    ".json"
  )) {
    const planned = await planSignature(
      file,
      opts,
      signatures,
      changes,
      refusals
    );
    if (planned) snapshots.set(file, planned);
  }
  const locks: Plan = new Map();
  for (const file of filesUnder(opts.roots, ".lock.json")) {
    const planned = planLock(
      file,
      opts.catalogDir,
      snapshots,
      changes,
      refusals
    );
    if (planned) locks.set(file, planned);
  }
  const records: Planned[] = [];
  for (const file of filesUnder(opts.roots, ".json")) {
    if (!file.split(sep).includes("checks")) continue;
    const planned = planRecord(
      file,
      opts,
      { snapshots, locks, signatures },
      changes,
      refusals
    );
    if (planned) records.push(planned);
  }
  // Snapshot provenance first, then locks, then the checks that pin both.
  const writes = [...snapshots.values(), ...locks.values(), ...records].filter(
    (row) => readFileSync(row.file, "utf8") !== row.text
  );
  if (!opts.write || refusals.length > 0 || writes.length === 0) {
    return { changes, refusals, wrote: false };
  }
  const journal: Journal = {
    format: JOURNAL_FORMAT,
    id: randomUUID(),
    files: writes.map((row) => ({
      file: row.file,
      old: sha256(readFileSync(row.file, "utf8")),
      next: sha256(row.text),
      text: row.text,
    })),
  };
  mkdirSync(dirname(opts.journal), { recursive: true });
  writeFileSync(`${opts.journal}.tmp`, `${JSON.stringify(journal)}\n`);
  renameSync(`${opts.journal}.tmp`, opts.journal);
  opts.step?.("journal");
  const drift = apply(journal, opts);
  return { changes, refusals: drift, wrote: drift.length === 0 };
}

/** Finish a journal an earlier run left, or refuse and keep it. */
function resume(opts: RepinOptions): RepinResult {
  const journal = readJournal(opts.journal);
  if (typeof journal === "string") {
    return { changes: [], refusals: [journal], wrote: false };
  }
  const refusals = journal.files.flatMap((entry) =>
    sha256(entry.text) === entry.next
      ? []
      : [`${entry.file}: the journal's new bytes do not match their digest`]
  );
  refusals.push(...drifted(journal));
  const changes: RepinChange[] = journal.files.map((entry) => ({
    file: entry.file,
    field: "file",
    id: `resume ${journal.id}`,
    from: entry.old,
    to: entry.next,
  }));
  if (!opts.write || refusals.length > 0) {
    return {
      changes,
      refusals: [
        ...refusals,
        ...(opts.write
          ? []
          : [
              `re-pin ${journal.id} was interrupted; run with write to finish it`,
            ]),
      ],
      wrote: false,
    };
  }
  const drift = apply(journal, opts);
  return { changes, refusals: drift, wrote: drift.length === 0 };
}

/** The journal, or why it cannot be used; either way it stays on disk. */
function readJournal(file: string): Journal | string {
  const unusable = `${file}: not a usable ${JOURNAL_FORMAT} journal; restore the files it names or delete it`;
  try {
    const journal = JSON.parse(readFileSync(file, "utf8")) as Partial<Journal>;
    const ok =
      journal.format === JOURNAL_FORMAT &&
      typeof journal.id === "string" &&
      Array.isArray(journal.files) &&
      journal.files.every(
        (entry) =>
          typeof entry?.file === "string" &&
          typeof entry.old === "string" &&
          typeof entry.next === "string" &&
          typeof entry.text === "string"
      );
    return ok ? (journal as Journal) : unusable;
  } catch {
    return unusable;
  }
}

/** Files that hold neither their planned old bytes nor their new ones. */
function drifted(journal: Journal): string[] {
  return journal.files.flatMap((entry) => {
    if (!existsSync(entry.file)) {
      return [`${entry.file}: missing since re-pin ${journal.id} was planned`];
    }
    const now = sha256(readFileSync(entry.file, "utf8"));
    return now === entry.old || now === entry.next
      ? []
      : [`${entry.file}: changed since re-pin ${journal.id} was planned`];
  });
}

/**
 * Stage every file, rename in plan order, verify, drop the journal. A file
 * that drifted is refused before anything is staged, and the journal
 * stays.
 */
function apply(journal: Journal, opts: RepinOptions): string[] {
  const drift = drifted(journal);
  if (drift.length > 0) return drift;
  const pending = journal.files.filter(
    (entry) => sha256(readFileSync(entry.file, "utf8")) !== entry.next
  );
  pending.forEach((entry, at) => {
    writeFileSync(`${entry.file}.repin-tmp`, entry.text);
    opts.step?.(`stage ${at}`);
  });
  pending.forEach((entry, at) => {
    renameSync(`${entry.file}.repin-tmp`, entry.file);
    opts.step?.(`rename ${at}`);
  });
  const wrong = journal.files.filter(
    (entry) => sha256(readFileSync(entry.file, "utf8")) !== entry.next
  );
  if (wrong.length > 0) {
    throw new Error(
      `re-pin ${journal.id}: ${wrong.map((row) => row.file).join(", ")} did not land`
    );
  }
  rmSync(opts.journal);
  return [];
}

/**
 * A catalog snapshot whose recorded signature is not its source's today.
 * Accepted only when a dry capture of it into a temp catalog differs from
 * the committed file in `provenance.from.hash` alone.
 */
async function planSignature(
  file: string,
  opts: RepinOptions,
  signatures: Map<string, string>,
  changes: RepinChange[],
  refusals: string[]
): Promise<Planned | null> {
  const text = readFileSync(file, "utf8");
  const snap = JSON.parse(text) as SnapshotFile;
  const fresh = provenanceHash(
    snap,
    { catalogDir: opts.catalogDir, worldDir: opts.catalogDir },
    nodeStampEnv
  );
  const old = snap.provenance.from?.hash;
  if (!fresh.checked || old === undefined || fresh.hash === old) return null;
  const id = snapshotId(opts.catalogDir, file);
  const config = JSON.parse(
    readFileSync(join(opts.catalogDir, CAPTURE_CONFIG), "utf8")
  ) as CaptureConfig;
  const entry = config.entries.find((row) => row.id === id);
  if (!entry) {
    refusals.push(`${file}: stale signature and no capture recipe for ${id}`);
    return null;
  }
  const temp = mkdtempSync(join(tmpdir(), "sfab-repin-capture-"));
  try {
    cpSync(opts.catalogDir, temp, { recursive: true });
    await captureFromConfig({
      catalogDir: temp,
      config: { ...config, entries: [entry] } as CaptureRun["config"],
    });
    const again = JSON.parse(
      readFileSync(join(temp, file.slice(opts.catalogDir.length)), "utf8")
    ) as SnapshotFile;
    const moved = differences(withoutSource(snap), withoutSource(again));
    if (moved.length > 0) {
      refusals.push(
        `${file}: a dry capture moves ${moved.join(", ")}; re-capture it (pnpm capture) and review the numbers`
      );
      return null;
    }
    if (again.provenance.from?.hash !== fresh.hash) {
      refusals.push(`${file}: the dry capture signs another source`);
      return null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refusals.push(`${file}: the dry capture failed (${message})`);
    return null;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const swap = {
    file,
    field: "provenance.from.hash",
    id,
    from: old,
    to: fresh.hash,
  };
  const next = swapHex(text, [swap], file, refusals);
  if (next === null) return null;
  changes.push(swap);
  signatures.set(id, fresh.hash);
  return { file, text: next };
}

function planLock(
  file: string,
  catalogDir: string,
  snapshots: Plan,
  changes: RepinChange[],
  refusals: string[]
): Planned | null {
  const world = file.replace(/\.lock\.json$/, ".json");
  if (!existsSync(world)) {
    refusals.push(`${file}: no world ${world}`);
    return null;
  }
  const loaded = loadWorldV2(world, {
    store: planStore(snapshots),
    catalogDir,
    assetRoot: projectOf(world, "parts"),
  });
  const errors = loaded.diagnostics.filter(
    (diag) => diag.severity === "error" && diag.code !== "lock"
  );
  if (errors.length > 0 || !loaded.lock) {
    refusals.push(
      `${world}: does not load (${errors.map((diag) => diag.message).join("; ") || "no lock"})`
    );
    return null;
  }
  const text = readFileSync(file, "utf8");
  const stored = JSON.parse(text) as LockJson;
  const expected = loaded.lock as LockJson;
  if (stored.format !== expected.format || stored.world !== expected.world) {
    refusals.push(`${file}: format or world name differs; not a re-pin`);
    return null;
  }
  const swaps: RepinChange[] = [];
  for (const section of LOCK_SECTIONS) {
    const have = new Map((stored[section] ?? []).map((r) => [r.id, r.sha256]));
    const want = new Map(
      (expected[section] ?? []).map((r) => [r.id, r.sha256])
    );
    const added = [...want.keys()].filter((id) => !have.has(id));
    const dropped = [...have.keys()].filter((id) => !want.has(id));
    if (added.length > 0 || dropped.length > 0) {
      refusals.push(
        `${file}: ${section} ids changed (${[
          ...added.map((id) => `+${id}`),
          ...dropped.map((id) => `-${id}`),
        ].join(" ")}); not a re-pin`
      );
      return null;
    }
    for (const [id, sha] of want) {
      const old = have.get(id);
      if (old !== undefined && old !== sha) {
        swaps.push({
          file,
          field: `${section}[].sha256`,
          id,
          from: old,
          to: sha,
        });
      }
    }
  }
  const next = swapHex(text, swaps, file, refusals);
  if (next === null) return null;
  changes.push(...swaps);
  return { file, text: next };
}

function planRecord(
  file: string,
  opts: RepinOptions,
  plans: { snapshots: Plan; locks: Plan; signatures: Map<string, string> },
  changes: RepinChange[],
  refusals: string[]
): Planned | null {
  let record: AssemblyJson;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as AssemblyJson;
  } catch {
    return null;
  }
  if (record.format !== ASSEMBLY_FORMAT) return null;
  const project = projectOf(file, "checks");
  const document = join(project, record.document);
  const lockFile = document.replace(/\.json$/, ".lock.json");
  if (!existsSync(document) || !existsSync(lockFile)) {
    refusals.push(`${file}: its document or lock is missing`);
    return null;
  }
  if (contentHash(readJson(document)) !== record.fixture.hash) {
    refusals.push(
      `${file}: ${record.document} changed since the record was measured; remeasure it (assembly.selfcheck --write)`
    );
    return null;
  }
  const lockNow = contentHash(readJson(lockFile));
  const planned = plans.locks.get(lockFile);
  const lockNext = planned ? contentHash(JSON.parse(planned.text)) : lockNow;
  if (record.fixture.lock !== lockNow && record.fixture.lock !== lockNext) {
    refusals.push(
      `${file}: fixture.lock is neither the current lock nor the re-pinned one`
    );
    return null;
  }
  const swaps: RepinChange[] = [];
  if (record.fixture.lock !== lockNext) {
    swaps.push({
      file,
      field: "fixture.lock",
      id: record.document,
      from: record.fixture.lock,
      to: lockNext,
    });
  }
  for (const child of record.children) {
    const snapshot = snapshotFile(project, opts.catalogDir, child.ref);
    if (!snapshot) {
      refusals.push(`${file}: ${child.ref} has no snapshot file`);
      return null;
    }
    const planned = plans.snapshots.get(snapshot);
    const onDisk = readFileSync(snapshot, "utf8");
    const now = contentHash(JSON.parse(planned?.text ?? onDisk));
    if (now !== child.hash) {
      // Only a signature this run re-stamps may move the pin: the snapshot
      // as it is on disk must still be the bytes the record measured.
      if (!planned || contentHash(JSON.parse(onDisk)) !== child.hash) {
        refusals.push(
          `${file}: ${child.path} ${child.ref} changed since the record was measured (${snapshot}); remeasure it (assembly.selfcheck --write)`
        );
        return null;
      }
      swaps.push({
        file,
        field: "children[].hash",
        id: `${child.path} ${child.ref}`,
        from: child.hash,
        to: now,
      });
    }
    const signed = plans.signatures.get(child.ref);
    const was = planned
      ? (JSON.parse(onDisk) as SnapshotFile).provenance.from?.hash
      : undefined;
    if (signed !== undefined && child.fromHash === was) {
      swaps.push({
        file,
        field: "children[].fromHash",
        id: `${child.path} ${child.ref}`,
        from: child.fromHash,
        to: signed,
      });
    }
  }
  const text = readFileSync(file, "utf8");
  const next = swapHex(text, swaps, file, refusals);
  if (next === null) return null;
  changes.push(...swaps);
  return { file, text: next };
}

/**
 * Replace each old hash with its new one, as text, so the diff is hash
 * lines only. Refuses when an old hash maps to two new hashes, and unless
 * the parsed result differs from the parsed original in exactly the
 * swapped string values (an escaped copy of a hash is a string too).
 */
function swapHex(
  text: string,
  swaps: RepinChange[],
  file: string,
  refusals: string[]
): string | null {
  const byOld = new Map<string, { to: string; count: number }>();
  for (const swap of swaps) {
    const seen = byOld.get(swap.from);
    if (seen && seen.to !== swap.to) {
      refusals.push(`${file}: ${swap.from.slice(0, 8)} maps to two new hashes`);
      return null;
    }
    byOld.set(swap.from, { to: swap.to, count: (seen?.count ?? 0) + 1 });
  }
  let out = text;
  for (const [from, { to, count }] of byOld) {
    const found = out.split(from).length - 1;
    if (found !== count) {
      refusals.push(
        `${file}: ${from.slice(0, 8)} appears ${found} times, ${count} expected`
      );
      return null;
    }
    out = out.split(from).join(to);
  }
  if (!swappedOnly(JSON.parse(text), JSON.parse(out), byOld)) {
    refusals.push(`${file}: a hash swap would change another value`);
    return null;
  }
  return out;
}

/** `after` is `before` with each old hash string swapped, `count` times. */
function swappedOnly(
  before: unknown,
  after: unknown,
  byOld: Map<string, { to: string; count: number }>
): boolean {
  const seen = new Map<string, number>();
  const walk = (a: unknown, b: unknown): boolean => {
    if (typeof a === "string" && typeof b === "string") {
      if (a === b) return !byOld.has(a);
      if (byOld.get(a)?.to !== b) return false;
      seen.set(a, (seen.get(a) ?? 0) + 1);
      return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, at) => walk(v, b[at]));
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const left = a as Record<string, unknown>;
      const right = b as Record<string, unknown>;
      const keys = Object.keys(left);
      const same = keys.join("\0") === Object.keys(right).join("\0");
      return same && keys.every((key) => walk(left[key], right[key]));
    }
    return a === b;
  };
  return (
    walk(before, after) &&
    [...byOld].every(([from, { count }]) => seen.get(from) === count)
  );
}

/** Node file access that reads planned bytes first. */
function planStore(plan: Plan): Store {
  return {
    ...nodeStore,
    readText: (file) => plan.get(file)?.text ?? nodeStore.readText(file),
  };
}

/** `snapshots/<publisher>/<name>@<version>.json` → its id. */
function snapshotId(catalogDir: string, file: string): string {
  const rel = file.slice(join(catalogDir, "snapshots").length + 1);
  return rel
    .split(sep)
    .join("/")
    .replace(/\.json$/, "");
}

/** The snapshot with its source signature blanked. */
function withoutSource(snap: SnapshotFile): unknown {
  const copy = JSON.parse(JSON.stringify(snap)) as SnapshotFile;
  if (copy.provenance.from) copy.provenance.from.hash = "";
  return copy;
}

/** Paths (to depth 3) whose canonical value differs. */
function differences(a: unknown, b: unknown, at = "", depth = 0): string[] {
  if (contentHash(a) === contentHash(b)) return [];
  const object = (v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (depth >= 3 || !object(a) || !object(b)) return [at || "(root)"];
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = [
    ...new Set([...Object.keys(left), ...Object.keys(right)]),
  ].sort();
  return keys.flatMap((key) =>
    differences(left[key], right[key], at ? `${at}.${key}` : key, depth + 1)
  );
}

/** The folder above the last `segment` in a path, else the file's folder. */
function projectOf(file: string, segment: string): string {
  const parts = dirname(file).split(sep);
  const at = parts.lastIndexOf(segment);
  return at > 0 ? parts.slice(0, at).join(sep) : dirname(file);
}

function snapshotFile(
  project: string,
  catalogDir: string,
  ref: string
): string | null {
  const parsed = parsePartRef(ref);
  if (!parsed) return null;
  const rel = join(
    "snapshots",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
  for (const base of [project, catalogDir]) {
    if (existsSync(join(base, rel))) return join(base, rel);
  }
  return null;
}

/** Files ending in `suffix` under the roots, never under a `broken` folder. */
function filesUnder(roots: string[], suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (ent.name === "node_modules" || ent.name === "broken") continue;
      const at = join(dir, ent.name);
      if (ent.isDirectory()) walk(at);
      else if (ent.name.endsWith(suffix)) out.push(at);
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
