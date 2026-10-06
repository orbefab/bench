/**
 * One frozen run context, and one side of a comparison run from it (run 7
 * unit 4, plan § 4).
 *
 * A run reads files through four surfaces: the planner's `PlanEnv`, the
 * loader's `Store`, `readInside` (the world file's own hash) and
 * `readerFor` (URDFs, meshes, firmware). `openContext` wraps all four with
 * one copy per real path. Each file is read from disk at most once,
 * and every side of the context reads that copy, so nothing that changes
 * on disk after the context opened reaches a side. A missing file stays
 * missing, so a project file still shadows the catalog and the catalog
 * still answers when it does not. A frozen context writes nothing.
 *
 * Opening plans the document as authored, with its lock, so the lock is
 * validated once. A side runs the same document, at its own path and id,
 * with its `play.levels` replaced in memory (a selection). A side hides
 * the authored lock and records the one it resolved (`report.lock`): the
 * lock pins the authored levels, not the side's. Opening also plans each
 * selection named up front, which reads every file those sides plan and
 * every file their runs read (`runInputs`), so the sides then read
 * nothing new; `late` lists anything first read after that.
 *
 * `planSide` is a side's realization: its plan, its report, and its run
 * context hash (`runContext`, the identity a stored verdict belongs to).
 * A capture's reducer reads that plan. `runSide` also runs it: a `Sim` on
 * the frozen files, observed for a horizon (`observeRun`).
 */

import {
  documentAssetDir,
  joinRel,
  type PlayBlock,
  type RunReport,
} from "@sfab-bench/contract";
import { lockPathFor, type Store, sha256Bytes } from "@sfab-bench/parts";

import type { PlanEnv, StampEnv } from "./env";
import {
  type ObservationDescriptor,
  type ObservedRun,
  observeRun,
} from "./observe";
import { type PlanResult, planWorld, type RunPlan } from "./plan";
import { Sim, type SimHost } from "./sim";

/** The file surfaces of a `SimHost`. */
export type RunFiles = Pick<
  SimHost,
  "projectReal" | "readInside" | "readerFor" | "plan"
>;
/** The rest of a `SimHost`: the clock, hashing and engine versions. */
export type RunClock = Omit<SimHost, keyof RunFiles>;

/** A side's levels: they replace the document's `play.levels`. */
export type Selection = PlayBlock["levels"];

/** A file the context holds: its path and content hash. */
export type ManifestRow = { file: string; sha256: string };

export type RunContext = {
  /** The project, real path. */
  root: string;
  /** The document, project-relative. */
  world: string;
  /** The document as held: authored, or the one the caller gave. */
  document: unknown;
  /** The document planned as authored, with its lock. */
  authored: PlanResult;
  /** Every file the context holds, by project or catalog path. */
  manifest(): ManifestRow[];
  /** Paths first asked of the disk after the context opened. */
  late(): string[];
  /** The frozen files with `overrides` served in place of the copies. */
  files(overrides?: Map<string, Uint8Array | null>): RunFiles;
  /** A stamp env whose store reads the frozen copies. */
  stampEnv(): StampEnv;
};

export type Realized = {
  plan: RunPlan;
  report: RunReport;
  /** `runContext` of this side: what a stored verdict is read against. */
  context: string;
};

export type Side = ObservedRun &
  Realized & {
    /** The report of the run, with what running it added. */
    report: RunReport;
    /** Snapshots the side ran, sorted by path and axis. */
    snapshots: { path: string; axis: string; ref: string }[];
    /** Wall milliseconds the observed steps took. */
    wallMs: number;
  };

function cleanRel(rel: string): string {
  return rel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

/** What a context freezes: the planner's file surface, asked through. */
export type FileSource = Pick<RunFiles, "plan">;

/**
 * Every file answer, asked of the host once. A path is first resolved to
 * its real path, once, so two spellings of one file share one copy; its
 * presence, bytes and directory listing are then held by that real path.
 * `readInside` applies the host's rule (project-relative, no `..`, inside
 * the project after symlinks, a file) to the held answers, so it agrees
 * with `exists` and `read` whatever the disk does later.
 */
class Frozen {
  /** Each path asked, to its real path: null when it did not resolve. */
  readonly real = new Map<string, string | null>();
  /** By real path: whether it exists. */
  readonly found = new Map<string, boolean>();
  /** By real path: its bytes, null when missing or not a file. */
  readonly bytes = new Map<string, Uint8Array | null>();
  readonly lists = new Map<string, string[] | null>();
  readonly lateReads = new Set<string>();
  sealed = false;

  constructor(readonly host: FileSource) {}

  key(file: string): string {
    return this.host.plan.absolutePath(file);
  }

  private first(key: string) {
    if (this.sealed) this.lateReads.add(key);
  }

  /** The real path `file` names; the path itself when it does not resolve. */
  canonical(file: string): string {
    const key = this.key(file);
    if (!this.real.has(key)) {
      this.first(key);
      let got: string | null = null;
      try {
        got = this.key(this.host.plan.realpath(key));
      } catch {
        got = null;
      }
      this.real.set(key, got);
      if (got && !this.real.has(got)) this.real.set(got, got);
    }
    return this.real.get(key) ?? key;
  }

  exists(file: string): boolean {
    const at = this.canonical(file);
    const known = this.found.get(at);
    if (known !== undefined) return known;
    this.first(at);
    const is = this.host.plan.exists(at);
    this.found.set(at, is);
    return is;
  }

  read(file: string): Uint8Array | null {
    const at = this.canonical(file);
    if (this.bytes.has(at)) return this.bytes.get(at) ?? null;
    let got: Uint8Array | null = null;
    if (this.exists(at)) {
      this.first(at);
      try {
        const env = this.host.plan;
        got = env.readBytes
          ? new Uint8Array(env.readBytes(at))
          : encoder.encode(env.readText(at));
      } catch {
        got = null;
      }
    }
    this.bytes.set(at, got);
    return got;
  }

  list(file: string): string[] {
    const at = this.canonical(file);
    if (!this.lists.has(at)) {
      this.first(at);
      let names: string[] | null = null;
      try {
        names = this.host.plan.store.list(at);
      } catch {
        names = null;
      }
      this.lists.set(at, names);
    }
    const names = this.lists.get(at);
    if (!names) throw new Error(`${at}: not a directory`);
    return [...names];
  }

  realpath(file: string): string {
    const at = this.canonical(file);
    if (!this.real.get(this.key(file))) throw new Error(`${at}: no such file`);
    return at;
  }

  /** `rel` under `root`, by the host's `resolveInside` rule, from `read`. */
  inside(
    root: string,
    rel: string,
    read: (file: string) => Uint8Array | null
  ): Uint8Array | null {
    const env = this.host.plan;
    const clean = cleanRel(rel);
    if (!clean || clean.split("/").includes("..") || env.isAbsolute(clean)) {
      return null;
    }
    const at = this.canonical(env.resolve(root, clean));
    const under = env.relative(this.canonical(root), at);
    if (under.startsWith("..") || env.isAbsolute(under)) return null;
    return read(at);
  }

  /** A held path as the project or the catalog names it. */
  shown(root: string, abs: string): string {
    const env = this.host.plan;
    for (const [base, prefix] of [
      [root, ""],
      [this.canonical(env.catalogDir()), "catalog/"],
    ] as const) {
      const rel = env.relative(base, abs);
      if (rel && !rel.startsWith("..") && !env.isAbsolute(rel)) {
        return `${prefix}${rel.split(env.sep).join("/")}`;
      }
    }
    return abs;
  }

  manifest(root: string): ManifestRow[] {
    // A file looked for and not found is held too: it is why a layer
    // further down answered.
    const rows = new Map<string, string>();
    for (const [abs, bytes] of this.bytes) {
      rows.set(abs, bytes ? sha256Bytes(bytes) : "missing");
    }
    for (const [abs, is] of this.found) {
      if (!is && !rows.has(abs)) rows.set(abs, "missing");
    }
    return [...rows]
      .map(([abs, sha256]) => ({ file: this.shown(root, abs), sha256 }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /**
   * The four surfaces, with `overrides` (by real path) served first: a
   * file, or null for one hidden.
   */
  view(overrides: Map<string, Uint8Array | null>): RunFiles {
    const env = this.host.plan;
    const bytesOf = (file: string): Uint8Array | null => {
      const at = this.canonical(file);
      return overrides.has(at) ? (overrides.get(at) ?? null) : this.read(at);
    };
    const read = (file: string): Uint8Array => {
      const bytes = bytesOf(file);
      if (!bytes) throw new Error(`${this.key(file)}: no such file`);
      return bytes;
    };
    const exists = (file: string): boolean => {
      const at = this.canonical(file);
      return overrides.has(at) ? overrides.get(at) !== null : this.exists(at);
    };
    const refuse = (what: string) => () => {
      throw new Error(`a frozen run context does not ${what}`);
    };
    const store: Store = {
      readText: (file) => decoder.decode(read(file)),
      exists,
      list: (file) => this.list(file),
      writeText: refuse("write"),
      rename: refuse("rename"),
      remove: refuse("remove"),
    };
    const plan: PlanEnv = {
      store,
      catalogDir: () => env.catalogDir(),
      exists,
      readText: (file) => decoder.decode(read(file)),
      readBytes: (file) => read(file),
      realpath: (file) => this.realpath(file),
      resolve: (...parts) => env.resolve(...parts),
      relative: (from, to) => env.relative(from, to),
      dirname: (file) => env.dirname(file),
      isAbsolute: (file) => env.isAbsolute(file),
      absolutePath: (file) => env.absolutePath(file),
      sep: env.sep,
    };
    const readInside = (root: string, rel: string) =>
      this.inside(root, rel, bytesOf);
    return {
      plan,
      projectReal: (project) => {
        try {
          return this.realpath(project);
        } catch {
          return null;
        }
      },
      readInside,
      readerFor: (root, worldRel) => {
        const dir = documentAssetDir(worldRel);
        return {
          read(rel: string) {
            const full = joinRel(dir, rel);
            return full ? readInside(root, full) : null;
          },
        };
      },
    };
  }
}

/**
 * A store over frozen copies of `host`'s files, with no document: what a
 * capture's fitter reads its source part through. Each file is read once.
 */
export function frozenStore(host: FileSource): Store {
  return new Frozen(host).view(new Map()).plan.store;
}

/** Each context's side files: the document served, the lock hidden. */
const sidesOf = new WeakMap<RunContext, (document: unknown) => RunFiles>();

/** The document with `selection` as its play levels. */
function withLevels(document: unknown, selection: Selection): unknown {
  const doc = structuredClone(document) as { play?: { levels?: unknown } };
  if (!doc.play || typeof doc.play !== "object") {
    throw new Error("the document has no play block to select levels in");
  }
  doc.play.levels = structuredClone(selection);
  return doc;
}

/**
 * Open `world` in `project` for comparison runs. `document`, when given,
 * is served at the world's own path in place of the file (an edited
 * document; the authored lock is not its lock). `selections` are planned
 * now, so their sides read only what the context already holds.
 */
export function openContext(
  host: FileSource,
  project: string,
  world: string,
  options: { document?: unknown; selections?: readonly Selection[] } = {}
): RunContext {
  const frozen = new Frozen(host);
  const env = host.plan;
  const root = frozen.view(new Map()).projectReal(project);
  if (!root) throw new Error(`${project}: the project folder is gone`);
  frozen.canonical(env.catalogDir());
  const rel = cleanRel(world);
  const worldAbs = frozen.canonical(env.resolve(root, rel));
  const lockAbs = frozen.canonical(lockPathFor(worldAbs));
  const given = options.document !== undefined;
  const text = given ? null : frozen.read(worldAbs);
  if (!given && !text) throw new Error(`${world}: no such document`);
  const document = given
    ? structuredClone(options.document)
    : (JSON.parse(decoder.decode(text ?? new Uint8Array())) as unknown);
  const served = (doc: unknown) =>
    new Map<string, Uint8Array | null>([
      [worldAbs, encoder.encode(JSON.stringify(doc))],
      [lockAbs, null],
    ]);
  // The authored document plans with its lock; the context hash reads
  // every file its run reads (firmware, URDFs, meshes) into the copies.
  const authoredFiles = frozen.view(given ? served(document) : new Map());
  const authored = planWorld(root, rel, authoredFiles.plan, { context: true });
  authoredFiles.readInside(root, rel);
  const context: RunContext = {
    root,
    world: rel,
    document,
    authored,
    manifest: () => frozen.manifest(root),
    late: () =>
      [...frozen.lateReads].map((abs) => frozen.shown(root, abs)).sort(),
    files: (overrides) => frozen.view(overrides ?? new Map()),
    stampEnv: () => ({
      store: frozen.view(new Map()).plan.store,
      absolutePath: (file) => env.absolutePath(file),
      defaultCatalog: () => env.absolutePath(env.catalogDir()),
      join: (...parts) => env.resolve(...parts),
    }),
  };
  sidesOf.set(context, (doc) => frozen.view(served(doc)));
  for (const selection of options.selections ?? [])
    planSide(context, selection);
  frozen.sealed = true;
  return context;
}

/**
 * The files one side reads: the context's copies, with the document at
 * `selection` served at its path and the authored lock hidden.
 */
export function sideFiles(
  context: RunContext,
  selection: Selection | undefined
): RunFiles {
  const files = sidesOf.get(context);
  if (!files) throw new Error("not an open run context");
  return files(
    selection ? withLevels(context.document, selection) : context.document
  );
}

/**
 * Plan one side: the document at `selection` (its own levels when
 * absent). Throws when it does not plan.
 */
export function planSide(context: RunContext, selection?: Selection): Realized {
  const files = sideFiles(context, selection);
  const planned = planWorld(context.root, context.world, files.plan, {
    context: true,
  });
  if (!planned.ok) {
    throw new Error(planned.errors.map((row) => row.message).join("; "));
  }
  const { plan } = planned;
  if (!plan.report || plan.context === undefined) {
    throw new Error(`${context.world}: the side has no report`);
  }
  return { plan, report: plan.report, context: plan.context };
}

/**
 * Run one side for `ms` and take `observations`. The side is planned and
 * built from the context's copies only.
 */
export async function runSide(
  context: RunContext,
  selection: Selection | undefined,
  observations: readonly ObservationDescriptor[],
  options: { ms: number; host: RunClock }
): Promise<Side> {
  const realized = planSide(context, selection);
  const sim = new Sim({ ...options.host, ...sideFiles(context, selection) });
  try {
    const loaded = await sim.load({
      project: context.root,
      world: context.world,
      generation: 1,
    });
    if (!loaded.ok) {
      throw new Error(
        `${context.world}: ${loaded.errors.map((row) => row.message).join("; ")}`
      );
    }
    const start = options.host.now();
    const observed = await observeRun(sim, observations, options.ms).catch(
      (err: unknown) => {
        throw new Error(`${context.world}: ${String(err)}`);
      }
    );
    const wallMs = options.host.now() - start;
    const report = sim.report();
    if (!report) throw new Error(`${context.world}: no report`);
    const snapshots = report.snapshots
      .map((row) => ({ path: row.path, axis: row.axis, ref: row.ref }))
      .sort((a, b) =>
        `${a.path} ${a.axis}`.localeCompare(`${b.path} ${b.axis}`)
      );
    return { ...realized, ...observed, report, snapshots, wallMs };
  } finally {
    sim.dispose();
  }
}
