/**
 * One frozen run context, and one side of a comparison run from it (run 7
 * unit 4, plan § 4).
 *
 * A run reads files through four surfaces: the planner's `PlanEnv`, the
 * loader's `Store`, `readInside` (the world file's own hash) and
 * `readerFor` (URDFs, meshes, firmware). `openContext` wraps all four with
 * one copy per absolute path. Each file is read from disk at most once,
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
  /** Files first read after the context opened. */
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

class Frozen {
  readonly bytes = new Map<string, Uint8Array | null>();
  readonly found = new Map<string, boolean>();
  readonly real = new Map<string, string | null>();
  readonly lists = new Map<string, string[] | null>();
  readonly inside = new Map<string, boolean>();
  readonly lateReads = new Set<string>();
  sealed = false;

  constructor(readonly host: RunFiles) {}

  key(file: string): string {
    return this.host.plan.absolutePath(file);
  }

  private first(key: string) {
    if (this.sealed) this.lateReads.add(key);
  }

  read(file: string): Uint8Array | null {
    const key = this.key(file);
    if (this.bytes.has(key)) return this.bytes.get(key) ?? null;
    this.first(key);
    let got: Uint8Array | null = null;
    try {
      const env = this.host.plan;
      if (env.exists(key)) {
        got = env.readBytes
          ? new Uint8Array(env.readBytes(key))
          : encoder.encode(env.readText(key));
      }
    } catch {
      got = null;
    }
    this.bytes.set(key, got);
    return got;
  }

  exists(file: string): boolean {
    const key = this.key(file);
    const known = this.found.get(key);
    if (known !== undefined) return known;
    if (this.bytes.get(key)) {
      this.found.set(key, true);
      return true;
    }
    this.first(key);
    const is = this.host.plan.exists(key);
    this.found.set(key, is);
    return is;
  }

  list(file: string): string[] {
    const key = this.key(file);
    if (!this.lists.has(key)) {
      this.first(key);
      let names: string[] | null = null;
      try {
        names = this.host.plan.store.list(key);
      } catch {
        names = null;
      }
      this.lists.set(key, names);
    }
    const names = this.lists.get(key);
    if (!names) throw new Error(`${key}: not a directory`);
    return [...names];
  }

  realpath(file: string): string {
    const key = this.key(file);
    if (!this.real.has(key)) {
      this.first(key);
      let got: string | null = null;
      try {
        got = this.host.plan.realpath(key);
      } catch {
        got = null;
      }
      this.real.set(key, got);
    }
    const got = this.real.get(key);
    if (!got) throw new Error(`${key}: no such file`);
    return got;
  }

  /**
   * The real host says whether `rel` stays inside the project; the bytes
   * are the context's copy.
   */
  readInside(root: string, rel: string): Uint8Array | null {
    const clean = cleanRel(rel);
    const at = `${root}\0${clean}`;
    const key = this.key(this.host.plan.resolve(root, clean));
    if (!this.inside.has(at)) {
      const got = this.host.readInside(root, rel);
      this.inside.set(at, got !== null);
      if (got !== null && !this.bytes.has(key)) {
        this.first(key);
        this.bytes.set(key, new Uint8Array(got));
      }
    }
    return this.inside.get(at) ? (this.bytes.get(key) ?? null) : null;
  }

  manifest(root: string): ManifestRow[] {
    const env = this.host.plan;
    const catalog = env.absolutePath(env.catalogDir());
    const shown = (abs: string) => {
      for (const [base, prefix] of [
        [root, ""],
        [catalog, "catalog/"],
      ] as const) {
        const rel = env.relative(base, abs);
        if (rel && !rel.startsWith("..") && !env.isAbsolute(rel)) {
          return `${prefix}${rel.split(env.sep).join("/")}`;
        }
      }
      return abs;
    };
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
      .map(([abs, sha256]) => ({ file: shown(abs), sha256 }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /** The four surfaces, with `overrides` (by absolute path) served first. */
  view(overrides: Map<string, Uint8Array | null>): RunFiles {
    const env = this.host.plan;
    const over = (file: string) => {
      const key = this.key(file);
      return overrides.has(key) ? { bytes: overrides.get(key) ?? null } : null;
    };
    const read = (file: string): Uint8Array => {
      const held = over(file);
      const bytes = held ? held.bytes : this.read(file);
      if (!bytes) throw new Error(`${this.key(file)}: no such file`);
      return bytes;
    };
    const exists = (file: string): boolean => {
      const held = over(file);
      return held ? held.bytes !== null : this.exists(file);
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
    const readInside = (root: string, rel: string) => {
      const held = over(env.resolve(root, cleanRel(rel)));
      if (held) return held.bytes;
      return this.readInside(root, rel);
    };
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
export function frozenStore(host: RunFiles): Store {
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
  host: RunFiles,
  project: string,
  world: string,
  options: { document?: unknown; selections?: readonly Selection[] } = {}
): RunContext {
  const frozen = new Frozen(host);
  const env = host.plan;
  const root = frozen.view(new Map()).projectReal(project);
  if (!root) throw new Error(`${project}: the project folder is gone`);
  const rel = cleanRel(world);
  const asked = frozen.key(env.resolve(root, rel));
  const worldAbs = frozen.key(frozen.realpath(asked));
  const lockAbs = frozen.key(lockPathFor(worldAbs));
  const given = options.document !== undefined;
  const text = given ? null : frozen.read(worldAbs);
  if (!given && !text) throw new Error(`${world}: no such document`);
  const document = given
    ? structuredClone(options.document)
    : (JSON.parse(decoder.decode(text ?? new Uint8Array())) as unknown);
  const served = (doc: unknown) => {
    const bytes = encoder.encode(JSON.stringify(doc));
    return new Map<string, Uint8Array | null>([
      [asked, bytes],
      [worldAbs, bytes],
      [lockAbs, null],
    ]);
  };
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
    late: () => [...frozen.lateReads].sort(),
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
