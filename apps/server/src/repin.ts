/**
 * `sfab-bench repin`: re-stamp the file pins a part or type edit leaves
 * behind (run 7 unit 2a). A pin is a hash that says which bytes a file
 * had: a lock row, and in an assembly check the lock it was measured with
 * (`fixture.lock`) and each child snapshot file (`children[].hash`).
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
 *   the re-pinned one.
 *
 * A path with a `broken` segment is never read: those fixtures are wrong
 * on purpose. A capture signature (`provenance.from.hash`) is not a file
 * pin and is left alone here.
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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { contentHash, loadWorldV2, parsePartRef } from "@sfab-bench/parts";

import { nodeStore } from "./world/node-store";

const ASSEMBLY_FORMAT = "sfab.assembly-check@1";
const JOURNAL_FORMAT = "sfab.repin-plan@1";
const LOCK_SECTIONS = ["parts", "types", "snapshots", "overlays"] as const;

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
  children: { path: string; ref: string; hash: string }[];
};

export function repin(opts: RepinOptions): RepinResult {
  if (existsSync(opts.journal)) return resume(opts);
  const changes: RepinChange[] = [];
  const refusals: string[] = [];
  const locks = new Map<string, Planned>();
  for (const file of filesUnder(opts.roots, ".lock.json")) {
    const planned = planLock(file, opts.catalogDir, changes, refusals);
    if (planned) locks.set(file, planned);
  }
  const records: Planned[] = [];
  for (const file of filesUnder(opts.roots, ".json")) {
    if (!file.split(sep).includes("checks")) continue;
    const planned = planRecord(file, opts, locks, changes, refusals);
    if (planned) records.push(planned);
  }
  const writes = [...locks.values(), ...records].filter(
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
  apply(journal, opts);
  return { changes, refusals, wrote: true };
}

/** Finish a journal an earlier run left, or refuse and keep it. */
function resume(opts: RepinOptions): RepinResult {
  const journal = JSON.parse(readFileSync(opts.journal, "utf8")) as Journal;
  const refusals: string[] = [];
  if (journal.format !== JOURNAL_FORMAT) {
    refusals.push(`${opts.journal}: not a ${JOURNAL_FORMAT} journal`);
  }
  for (const entry of journal.files ?? []) {
    if (sha256(entry.text) !== entry.next) {
      refusals.push(`${entry.file}: the journal's new bytes do not match`);
      continue;
    }
    const now = existsSync(entry.file)
      ? sha256(readFileSync(entry.file, "utf8"))
      : "missing";
    if (now !== entry.old && now !== entry.next) {
      refusals.push(
        `${entry.file}: changed since re-pin ${journal.id} was planned`
      );
    }
  }
  const changes: RepinChange[] = (journal.files ?? []).map((entry) => ({
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
  apply(journal, opts);
  return { changes, refusals, wrote: true };
}

/** Stage every file, rename in plan order, verify, drop the journal. */
function apply(journal: Journal, opts: RepinOptions): void {
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
}

function planLock(
  file: string,
  catalogDir: string,
  changes: RepinChange[],
  refusals: string[]
): Planned | null {
  const world = file.replace(/\.lock\.json$/, ".json");
  if (!existsSync(world)) {
    refusals.push(`${file}: no world ${world}`);
    return null;
  }
  const loaded = loadWorldV2(world, {
    store: nodeStore,
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
  locks: Map<string, Planned>,
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
  const planned = locks.get(lockFile);
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
    const now = contentHash(readJson(snapshot));
    if (now !== child.hash) {
      swaps.push({
        file,
        field: "children[].hash",
        id: `${child.path} ${child.ref}`,
        from: child.hash,
        to: now,
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
 * lines only. Refuses when an old hash also stands for something else in
 * the file, or maps to two new hashes.
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
  return out;
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
