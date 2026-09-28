/** Ported from layered-sim E7 (318b899). */

import {
  type BehaviourImpl,
  type Diagnostic,
  DOMAIN_QUANTITIES,
  type Netlist,
  type PartFile,
  type PortDecl,
  type Ratings,
} from "@sfab-bench/contract";

import { behaviourNetlist, type LiveInstance } from "./levels";
import { collectPartPorts, type PortWorld } from "./ports";
import { makeDiag, splitPortRef } from "./si";

export type LivePort = {
  full: string;
  path: string;
  port: string;
  domain: string;
  role?: string;
  direction?: string;
  ratings: Ratings;
  across: string;
};

export type LiveNet = {
  id: string;
  domain: string;
  ports: LivePort[];
  level: string;
  reason: string;
};

export type WireEnd = { path: string; port: string; full: string };
export type Wire = { a: WireEnd; b: WireEnd };

function mergeRatings(base?: Ratings, over?: Ratings): Ratings {
  if (!base && !over) return {};
  const a = base ?? {};
  const b = over ?? {};
  const logic = a.logic || b.logic ? { ...a.logic, ...b.logic } : undefined;
  const out: Ratings = { ...a, ...b };
  if (logic) out.logic = logic;
  return out;
}

function portRatings(inst: LiveInstance, port: string): Ratings {
  return mergeRatings(
    inst.type.ports[port]?.ratings,
    inst.part.ratings?.[port]
  );
}

export function collectPorts(instances: LiveInstance[]): Map<string, LivePort> {
  const ports = new Map<string, LivePort>();
  for (const inst of instances) {
    for (const [name, decl] of Object.entries(inst.type.ports)) {
      const full = `${inst.path}.${name}`;
      const across = DOMAIN_QUANTITIES[decl.domain].across[0] ?? "Port";
      ports.set(full, {
        full,
        path: inst.path,
        port: name,
        domain: decl.domain,
        role: decl.role,
        direction: decl.direction,
        ratings: portRatings(inst, name),
        across,
      });
    }
  }
  return ports;
}

class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) throw new Error(`unknown port ${id}`);
    if (p !== id) {
      const root = this.find(p);
      this.parent.set(id, root);
      return root;
    }
    return id;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const pa = this.find(a);
    const pb = this.find(b);
    if (pa === pb) return;
    if (pa < pb) this.parent.set(pb, pa);
    else this.parent.set(pa, pb);
  }
}

function behaviourOf(inst: LiveInstance): BehaviourImpl | null {
  const impl = inst.axes.behaviour.impl;
  if (!impl || typeof impl !== "object") return null;
  return impl as BehaviourImpl;
}

/** Composite children, a firmware board, or the class-2 netlist `path:uno-usb` names. */
export function netlistOf(inst: LiveInstance): Netlist | null {
  return behaviourNetlist(inst.part, behaviourOf(inst));
}

export function buildNets(
  instances: LiveInstance[],
  netRules: Record<string, "digital" | "analog"> | undefined
): { nets: LiveNet[]; wires: Wire[]; broken: Diagnostic[] } {
  const ports = collectPorts(instances);
  const uf = new UnionFind();
  for (const full of ports.keys()) uf.add(full);
  const wires: Wire[] = [];
  const broken: Diagnostic[] = [];
  const world = portWorld(instances);
  const seen = new Set<string>();

  const locate = (parent: string, ref: string): WireEnd | null => {
    const split = splitPortRef(ref);
    if (!split) return null;
    const instPath =
      parent === "$root" ? split.inst : `${parent}.${split.inst}`;
    return {
      path: instPath,
      port: split.port,
      full: `${instPath}.${split.port}`,
    };
  };

  const concrete = (end: WireEnd, stack: Set<string>): string[] | null => {
    if (ports.has(end.full)) return [end.full];
    if (stack.has(end.full)) return null;
    const inst = instances.find((item) => item.path === end.path);
    if (!inst) return null;
    stack.add(end.full);
    const found = collectPartPorts(world, inst.part.id).find(
      (port) => port.name === end.port
    );
    if (!found) return null;
    const fulls: string[] = [];
    for (const ref of found.refs) {
      const inner = locate(inst.path, ref);
      if (!inner) continue;
      const nested = concrete(inner, stack);
      if (!nested) continue;
      for (const full of nested) {
        if (!fulls.includes(full)) fulls.push(full);
      }
    }
    return fulls.length > 0 ? fulls : null;
  };

  const noteBroken = (parent: LiveInstance, wire: string, missing: string) => {
    const key = `${parent.part.id}|${wire}|${missing}`;
    if (seen.has(key)) return;
    seen.add(key);
    broken.push(
      makeDiag({
        severity: "warning",
        code: "broken-port",
        path: parent.part.id,
        port: missing,
        quantity: "Port",
        left: wire,
        right: "missing",
        detail: `wire ${wire} names missing port ${missing}`,
      })
    );
  };

  for (const inst of instances) {
    const netlist = netlistOf(inst);
    if (!netlist) continue;
    for (const [outer, inner] of Object.entries(netlist.expose)) {
      const outerFull = `${inst.path}.${outer}`;
      const innerEnd = locate(inst.path, inner);
      if (innerEnd && ports.has(outerFull) && ports.has(innerEnd.full)) {
        uf.union(outerFull, innerEnd.full);
      }
    }
    for (const [a, b] of netlist.wires) {
      const fa = locate(inst.path, a);
      const fb = locate(inst.path, b);
      if (!fa || !fb) continue;
      const left = concrete(fa, new Set());
      const right = concrete(fb, new Set());
      if (!left || !right) {
        if (!left) noteBroken(inst, `${a}—${b}`, fa.full);
        if (!right) noteBroken(inst, `${a}—${b}`, fb.full);
        continue;
      }
      const direct = ports.has(fa.full) && ports.has(fb.full);
      if (direct) wires.push({ a: fa, b: fb });
      const fulls = [...left, ...right];
      for (let i = 1; i < fulls.length; i++) {
        const head = fulls[0];
        const tail = fulls[i];
        if (head && tail) uf.union(head, tail);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const full of [...ports.keys()].sort()) {
    const root = uf.find(full);
    const list = groups.get(root);
    if (list) list.push(full);
    else groups.set(root, [full]);
  }

  const nets: LiveNet[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort();
    const live = members.map((full) => ports.get(full)!);
    const domain = live[0]?.domain ?? "electrical";
    const id = members.join(",");
    const classified = classify(live, domain, id, netRules);
    nets.push({
      id,
      domain,
      ports: live,
      level: classified.level,
      reason: classified.reason,
    });
  }
  nets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nets, wires, broken };
}

function portWorld(instances: LiveInstance[]): PortWorld {
  const parts = new Map<string, PartFile>();
  const types = new Map<string, Record<string, PortDecl>>();
  for (const inst of instances) {
    if (!parts.has(inst.part.id)) parts.set(inst.part.id, inst.part);
    if (!types.has(inst.part.id)) types.set(inst.part.id, inst.type.ports);
  }
  return {
    part(id) {
      return parts.get(id) ?? null;
    },
    typePorts(part) {
      return types.get(part.id) ?? null;
    },
  };
}

function classify(
  ports: LivePort[],
  domain: string,
  id: string,
  netRules: Record<string, "digital" | "analog"> | undefined
): { level: string; reason: string } {
  if (domain !== "electrical") {
    return { level: domain, reason: `domain ${domain}` };
  }
  if (netRules) {
    if (netRules[id]) return { level: netRules[id], reason: `net rule ${id}` };
    for (const port of ports) {
      const ruled = netRules[port.full] ?? netRules[port.port];
      if (ruled) {
        const key = netRules[port.full] ? port.full : port.port;
        return { level: ruled, reason: `net rule ${key}` };
      }
    }
  }
  const forcing = ports.find(
    (port) =>
      port.role === "power" || port.role === "ground" || port.role === "analog"
  );
  if (forcing) {
    return { level: "analog", reason: `${forcing.role} port ${forcing.full}` };
  }
  return { level: "digital", reason: "only logic ports" };
}
