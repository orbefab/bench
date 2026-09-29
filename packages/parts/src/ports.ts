/**
 * A part's ports: declared by its type, written in `expose`, or bubbled
 * from a free net. Dependents are a scan of the project; projects are
 * small, so the scan runs on every call. A cache would key on the
 * hashes of `parts/**` and the snapshot files.
 */

import type {
  Domain,
  LevelClass,
  Netlist,
  PartFile,
  PortDecl,
} from "@sfab-bench/contract";

import { isPartFile, partFilePath } from "./document";
import { join } from "./path";
import { splitPortRef } from "./si";
import type { Store } from "./store";
import { UnionFind } from "./union-find";

export type PortSource = "type" | "expose" | "auto";

/** A wire, an expose entry, or a snapshot that names this port. */
export type PortDependent = {
  kind: "wire" | "expose" | "snapshot";
  /** Part id of the parent, or the snapshot id. */
  owner: string;
  /** `a—b`, the expose ref, or the snapshot file path. */
  ref: string;
};

export type PartPort = {
  name: string;
  /** Child refs on this port's net, in lexicographic order. */
  refs: string[];
  source: PortSource;
  /** Type, expose, or at least one dependent. */
  fixed: boolean;
  dependents: PortDependent[];
};

export type PortLevel = {
  class?: LevelClass;
  variant?: string;
};

/**
 * How to read a part and its type without a library object. `part` and
 * `typePorts` are called for the part and for every child.
 */
export type PortWorld = {
  part(id: string): PartFile | null;
  typePorts(part: PartFile): Record<string, PortDecl> | null;
};

/**
 * A free net is one connected component of the composite's child ports.
 * Wires join ports. A child port that no wire touches is a net of one
 * pin. A component that an `expose` entry already names is not free.
 */
export function collectPartPorts(
  world: PortWorld,
  partId: string,
  spec?: PortLevel,
  stack: Set<string> = new Set()
): PartPort[] {
  if (stack.has(partId)) return [];
  const part = world.part(partId);
  if (!part) return [];
  stack.add(partId);
  const declared = world.typePorts(part);
  const names = declared ? Object.keys(declared) : [];
  const netlist = netlistFor(part, spec);
  if (names.length > 0) {
    const ports = names.sort().map((name) => ({
      name,
      refs: netlist ? refsOn(netlist, exposeTarget(netlist, name)) : [],
      source: "type" as const,
      fixed: true,
      dependents: [],
    }));
    stack.delete(partId);
    return ports;
  }
  if (!netlist || !compositeAt(part, spec)) {
    stack.delete(partId);
    return [];
  }
  const bubbled = bubble(world, netlist, stack);
  stack.delete(partId);
  return bubbled;
}

export function portNames(
  world: PortWorld,
  partId: string,
  spec?: PortLevel
): string[] | null {
  if (!world.part(partId)) return null;
  return collectPartPorts(world, partId, spec).map((port) => port.name);
}

/**
 * The domain a part's type declares for a port. Null when the part, or a
 * type that declares the port, is missing: a bubbled port of a composite
 * has no domain of its own.
 */
export function portDomain(
  world: PortWorld,
  partId: string,
  name: string
): Domain | null {
  const part = world.part(partId);
  if (!part) return null;
  return world.typePorts(part)?.[name]?.domain ?? null;
}

/**
 * Wires and expose entries in project parts, and snapshots under the
 * project, the personal library, and the catalog, that name a port of
 * `partId`.
 */
export function portDependents(
  store: Store,
  projectDir: string,
  opts: { catalogDir: string; libraryDir?: string },
  partId: string
): Map<string, PortDependent[]> {
  const out = new Map<string, PortDependent[]>();
  const add = (name: string, dep: PortDependent) => {
    const list = out.get(name);
    if (list) list.push(dep);
    else out.set(name, [dep]);
  };
  for (const file of walkJson(store, join(projectDir, "parts"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(store.readText(file)) as unknown;
    } catch {
      continue;
    }
    if (!isPartFile(parsed) || parsed.id === partId) continue;
    for (const netlist of netlistsOf(parsed)) {
      for (const [a, b] of netlist.wires) {
        for (const end of [a, b]) {
          const hit = dependentEnd(netlist, end, partId);
          if (hit)
            add(hit, { kind: "wire", owner: parsed.id, ref: `${a}—${b}` });
        }
      }
      for (const [name, ref] of Object.entries(netlist.expose)) {
        const hit = dependentEnd(netlist, ref, partId);
        if (hit)
          add(hit, { kind: "expose", owner: parsed.id, ref: `${name}=${ref}` });
      }
    }
  }
  const roots = [projectDir];
  if (opts.libraryDir) roots.push(opts.libraryDir);
  roots.push(opts.catalogDir);
  for (const root of roots) {
    for (const file of walkJson(store, join(root, "snapshots"))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(store.readText(file)) as unknown;
      } catch {
        continue;
      }
      const snap = parsed as {
        part?: unknown;
        provenance?: { from?: { part?: unknown } };
        ports?: { inputs?: unknown; outputs?: unknown };
        params?: { across?: unknown };
        envelope?: { bounds?: unknown };
      };
      const from = snap.provenance?.from?.part;
      if (from !== partId) continue;
      const owner = typeof snap.part === "string" ? snap.part : partId;
      for (const name of snapshotPortNames(snap)) {
        add(name, { kind: "snapshot", owner, ref: file });
      }
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) =>
      `${a.kind}|${a.owner}|${a.ref}` < `${b.kind}|${b.owner}|${b.ref}` ? -1 : 1
    );
  }
  return out;
}

export function bindDependents(
  ports: PartPort[],
  deps: Map<string, PortDependent[]>
): PartPort[] {
  return ports.map((port) => {
    const dependents = deps.get(port.name) ?? [];
    return {
      ...port,
      dependents,
      fixed: port.source !== "auto" || dependents.length > 0,
    };
  });
}

export function confirmSentence(
  ports: { name: string; dependents: PortDependent[] }[]
): string {
  const count = ports.reduce((n, port) => n + port.dependents.length, 0);
  if (ports.length === 1) {
    const port = ports[0];
    if (!port) return "Nothing changed.";
    const kind = dependentWord(port.dependents);
    return `This removes port ${port.name}, used by ${count} ${kind} (${listDependents(port.dependents)}). Nothing changed. Send it again with break to break them.`;
  }
  const body = ports
    .map(
      (port) =>
        `${port.name}, used by ${port.dependents.length} ${dependentWord(port.dependents)} (${listDependents(port.dependents)})`
    )
    .join("; ");
  return `This removes ${ports.length} ports (${body}). Nothing changed. Send it again with break to break them.`;
}

function dependentWord(deps: PortDependent[]): string {
  if (deps.length === 1 && deps[0]?.kind === "snapshot") return "capture";
  if (deps.every((dep) => dep.kind === "wire"))
    return deps.length === 1 ? "wire" : "wires";
  if (deps.every((dep) => dep.kind === "snapshot")) return "captures";
  return deps.length === 1 ? "dependent" : "dependents";
}

function listDependents(deps: PortDependent[]): string {
  return deps
    .map((dep) => {
      if (dep.kind === "snapshot") return `capture ${dep.ref}`;
      const stem = dep.owner.split("/")[1]?.split("@")[0] ?? dep.owner;
      return `in ${stem}: ${dep.ref}`;
    })
    .join("; ");
}

function snapshotPortNames(snap: {
  ports?: { inputs?: unknown; outputs?: unknown };
  params?: { across?: unknown };
  envelope?: { bounds?: unknown };
}): string[] {
  const names = new Set<string>();
  const take = (value: unknown) => {
    if (typeof value !== "string") return;
    const dot = value.indexOf(".");
    const name = dot === -1 ? value : value.slice(0, dot);
    if (name.length > 0 && !name.includes(".")) names.add(name);
  };
  const inputs = snap.ports?.inputs;
  const outputs = snap.ports?.outputs;
  if (Array.isArray(inputs)) for (const item of inputs) take(item);
  if (Array.isArray(outputs)) for (const item of outputs) take(item);
  const across = snap.params?.across;
  if (Array.isArray(across)) for (const item of across) take(item);
  const bounds = snap.envelope?.bounds;
  if (bounds && typeof bounds === "object") {
    for (const key of Object.keys(bounds)) take(key);
  }
  return [...names].sort();
}

function dependentEnd(
  netlist: Netlist,
  ref: string,
  partId: string
): string | null {
  const split = splitPortRef(ref);
  if (!split) return null;
  const inst = instancePart(netlist, split.inst);
  if (!inst || inst.part !== partId) return null;
  return split.port;
}

function instancePart(netlist: Netlist, inst: string): { part: string } | null {
  const head = inst.split(".")[0] ?? inst;
  const row = netlist.instances[head];
  return row ? { part: row.part } : null;
}

function childPortNames(
  world: PortWorld,
  partId: string,
  stack: Set<string>
): string[] {
  if (!world.part(partId)) return [];
  return collectPartPorts(world, partId, undefined, stack).map(
    (port) => port.name
  );
}

function bubble(
  world: PortWorld,
  netlist: Netlist,
  stack: Set<string>
): PartPort[] {
  const uf = new UnionFind();
  for (const [id, inst] of Object.entries(netlist.instances)) {
    const names = childPortNames(world, inst.part, stack);
    for (const name of names) uf.add(`${id}.${name}`);
  }
  for (const [a, b] of netlist.wires) {
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const ref of [...uf.ids()].sort()) {
    const root = uf.find(ref);
    const list = groups.get(root);
    if (list) list.push(ref);
    else groups.set(root, [ref]);
  }
  const claimed = new Map<string, string[]>();
  const ports: PartPort[] = [];
  const taken = new Set<string>();
  for (const [name, target] of Object.entries(netlist.expose)) {
    if (!uf.has(target)) uf.add(target);
    const root = uf.find(target);
    const refs = (groups.get(root) ?? [target]).slice().sort();
    groups.set(root, refs);
    claimed.set(root, refs);
    taken.add(name);
    ports.push({
      name,
      refs,
      source: "expose",
      fixed: true,
      dependents: [],
    });
  }
  const free: { refs: string[] }[] = [];
  for (const [root, refs] of groups) {
    if (claimed.has(root)) continue;
    free.push({ refs: refs.slice().sort() });
  }
  const names = assignNames(free, taken);
  for (let i = 0; i < free.length; i++) {
    const refs = free[i]?.refs ?? [];
    const name = names[i];
    if (!name) continue;
    ports.push({
      name,
      refs,
      source: "auto",
      fixed: false,
      dependents: [],
    });
  }
  ports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ports;
}

/**
 * Nets in lexicographic order of their sorted refs. The preferred name
 * is the pin name when every pin agrees, otherwise the lexicographically
 * smallest pin name (`5V` before `V+`). The first net keeps it. A
 * collision takes `<instance>_<pin>`, then `_2`, `_3`. A `.` becomes `_`.
 */
function assignNames(nets: { refs: string[] }[], taken: Set<string>): string[] {
  const order = nets
    .map((net, index) => ({ index, key: net.refs.join("|") }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const names = new Array<string>(nets.length);
  for (const item of order) {
    const refs = nets[item.index]?.refs ?? [];
    let name = preferredName(refs);
    if (taken.has(name) || name.length === 0) {
      const pin = preferredName(refs);
      const ref =
        refs.find((itemRef) => splitPortRef(itemRef)?.port === pin) ?? refs[0];
      const split = ref ? splitPortRef(ref) : null;
      const base = sanitize(`${split?.inst ?? "net"}_${split?.port ?? pin}`);
      name = base.length > 0 ? base : "net";
      let n = 2;
      while (taken.has(name)) {
        name = `${base}_${n}`;
        n += 1;
      }
    }
    taken.add(name);
    names[item.index] = name;
  }
  return names;
}

function preferredName(refs: string[]): string {
  const pins = refs.map((ref) => splitPortRef(ref)?.port ?? ref);
  const unique = [...new Set(pins)].sort();
  return sanitize(unique[0] ?? "net");
}

function sanitize(name: string): string {
  return name.replaceAll(".", "_");
}

function exposeTarget(netlist: Netlist, name: string): string | null {
  return netlist.expose[name] ?? null;
}

function refsOn(netlist: Netlist, target: string | null): string[] {
  if (!target) return [];
  const uf = new UnionFind();
  for (const [a, b] of netlist.wires) {
    uf.add(a);
    uf.add(b);
    uf.union(a, b);
  }
  if (!uf.has(target)) return [target];
  const root = uf.find(target);
  const refs: string[] = [];
  for (const ref of uf.ids()) {
    if (uf.find(ref) === root) refs.push(ref);
  }
  refs.sort();
  return refs;
}

function compositeAt(part: PartFile, spec?: PortLevel): boolean {
  const slot = slotOf(part, spec);
  if (!slot) return false;
  const variant = variantOf(slot, spec?.variant);
  return variant?.kind === "composite";
}

function netlistFor(part: PartFile, spec?: PortLevel): Netlist | null {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return null;
  if (spec?.class !== undefined) {
    const slot = behaviour[String(spec.class) as "0"];
    const variant = slot ? variantOf(slot, spec.variant) : undefined;
    if (!variant) return null;
    if (variant.kind === "composite") return variant.netlist;
    if (variant.kind === "firmware" && variant.board) return variant.board;
    return null;
  }
  const preferred = behaviour["2"] ?? null;
  const slots = preferred
    ? [preferred, ...Object.values(behaviour)]
    : Object.values(behaviour);
  for (const slot of slots) {
    if (!slot) continue;
    const variant = variantOf(slot);
    if (variant?.kind === "composite") return variant.netlist;
  }
  for (const slot of Object.values(behaviour)) {
    if (!slot) continue;
    const variant = variantOf(slot);
    if (variant?.kind === "firmware" && variant.board) return variant.board;
  }
  return null;
}

function slotOf(part: PartFile, spec?: PortLevel) {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return null;
  if (spec?.class !== undefined)
    return behaviour[String(spec.class) as "0"] ?? null;
  return (
    behaviour["2"] ?? Object.values(behaviour).find((slot) => slot) ?? null
  );
}

function variantOf(
  slot: NonNullable<NonNullable<PartFile["axes"]>["behaviour"]>["0"],
  name?: string
) {
  if (!slot) return undefined;
  if (name) return slot.variants[name];
  return slot.variants[slot.default] ?? Object.values(slot.variants)[0];
}

function netlistsOf(part: PartFile): Netlist[] {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return [];
  const out: Netlist[] = [];
  for (const slot of Object.values(behaviour)) {
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      if (variant.kind === "composite") out.push(variant.netlist);
      else if (variant.kind === "firmware" && variant.board)
        out.push(variant.board);
    }
  }
  return out;
}

function walkJson(store: Store, dir: string): string[] {
  const out: string[] = [];
  const visit = (path: string) => {
    let names: string[];
    try {
      names = store.list(path);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const child = join(path, name);
      if (
        name.endsWith(".json") &&
        !name.endsWith(".lock.json") &&
        !name.includes(".edit-")
      ) {
        out.push(child);
      } else if (!name.includes(".")) {
        visit(child);
      }
    }
  };
  visit(dir);
  out.sort();
  return out;
}

/**
 * Project parts, other than `skipFile`, that have a lock and that
 * instance `partId` directly or through other parts.
 */
export function lockedRootsUsing(
  store: Store,
  projectDir: string,
  opts: { catalogDir: string; libraryDir?: string },
  partId: string,
  skipFile: string
): { id: string; file: string }[] {
  const files = walkJson(store, join(projectDir, "parts"));
  const byId = new Map<string, PartFile>();
  const fileOf = new Map<string, string>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(store.readText(file)) as unknown;
    } catch {
      continue;
    }
    if (!isPartFile(parsed)) continue;
    byId.set(parsed.id, parsed);
    fileOf.set(parsed.id, file);
  }
  const loaded = new Map<string, PartFile | null>();
  const read = (id: string): PartFile | null => {
    if (loaded.has(id)) return loaded.get(id) ?? null;
    const have = byId.get(id);
    if (have) {
      loaded.set(id, have);
      return have;
    }
    const file = findPartFile(store, projectDir, opts, id);
    if (!file) {
      loaded.set(id, null);
      return null;
    }
    try {
      const parsed = JSON.parse(store.readText(file)) as unknown;
      const part = isPartFile(parsed) ? parsed : null;
      loaded.set(id, part);
      return part;
    } catch {
      loaded.set(id, null);
      return null;
    }
  };
  const uses = (id: string, seen: Set<string>): boolean => {
    if (id === partId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const part = read(id);
    if (!part) return false;
    for (const child of childPartIds(part)) {
      if (uses(child, seen)) return true;
    }
    return false;
  };
  const roots: { id: string; file: string }[] = [];
  for (const [id, file] of fileOf) {
    if (normalizePath(file) === normalizePath(skipFile)) continue;
    const lock = file.replace(/\.json$/, ".lock.json");
    if (!store.exists(lock)) continue;
    if (!uses(id, new Set())) continue;
    roots.push({ id, file });
  }
  roots.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return roots;
}

function childPartIds(part: PartFile): string[] {
  const refs: string[] = [];
  for (const netlist of netlistsOf(part)) {
    for (const inst of Object.values(netlist.instances)) refs.push(inst.part);
  }
  return refs;
}

function normalizePath(path: string): string {
  const slash = path.replace(/\\/g, "/");
  return slash.length > 1 ? slash.replace(/\/+$/, "") : slash;
}

/** Project, then personal library, then catalog. */
export function findPartFile(
  store: Store,
  projectDir: string,
  opts: { catalogDir: string; libraryDir?: string },
  partId: string
): string | null {
  const bases = [projectDir];
  if (opts.libraryDir) bases.push(opts.libraryDir);
  bases.push(opts.catalogDir);
  for (const base of bases) {
    const file = partFilePath(base, partId);
    if (file && store.exists(file)) return file;
  }
  return null;
}
