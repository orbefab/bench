/**
 * Circuit parts become rail elements. A firmware `board` netlist is the
 * same step: its children are parts, and `buildNets` names the nodes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  arduinoPinBit,
  type BehaviourImpl,
  type Domain,
  FORM_PARAMS,
  type Netlist,
  type PartFile,
  type PortDecl,
  type PortDirection,
  type PortRole,
} from "@sfab-bench/contract";

import type { Element } from "./circuit/element";
import {
  Capacitor,
  Diode,
  type DiodeParams,
  ISource,
  Resistor,
  Switch,
  VSource,
} from "./circuit/elements";
import {
  AVR_PIN,
  type AvrPinParams,
  PIN_ROFF,
  PIN_ROH,
  PIN_ROL,
  Pin,
} from "./circuit/pin";
import type { LiveNet } from "./parts/nets";

export const CIRCUIT_FORMS = ["resistor@1", "capacitor@1", "diode@1"] as const;
export type CircuitForm = (typeof CIRCUIT_FORMS)[number];

export function isCircuitForm(form: string): form is CircuitForm {
  return (CIRCUIT_FORMS as readonly string[]).includes(form);
}

export type CircuitInst = {
  path: string;
  form: CircuitForm;
  typeId: string;
  params: Record<string, number>;
  /** Port name → `path.port`. */
  ports: Record<string, string>;
};

export type AssignedPart = {
  path: string;
  form: CircuitForm;
  typeId: string;
  params: Record<string, number>;
  /** Port name → node. Ground is `"0"`. */
  nodes: Record<string, string>;
};

export type StampedPin = {
  port: string;
  bit: number;
  node: string;
};

/** One board's parts, before the feed decides which dangling parts drop. */
export type BoardStamp = {
  /** The selected firmware variant carries a board netlist. */
  netlist: boolean;
  boardNode: string;
  /** Null when the type has no `VBUS` on a net. */
  vbusNode: string | null;
  resetNode: string | null;
  parts: AssignedPart[];
  pins: StampedPin[];
};

export type RealizedCircuit = {
  elements: Element[];
  pins: { bit: number; pin: Pin }[];
  leds: { path: string; diode: Diode }[];
  feedNode: string;
  boardNode: string;
  resetNode: string | null;
  /** A capacitor survived pruning, so the rail sub-steps. */
  capacitive: boolean;
};

type NetPorts = {
  ports: { full: string; path: string; port: string }[];
};

/** Numeric form params, with an instance number winning on the same name. */
export function circuitNumbers(
  behaviour: BehaviourImpl,
  params: Record<string, number | string | boolean>
): Record<string, number> | null {
  if (behaviour.kind !== "form" || !isCircuitForm(behaviour.form)) return null;
  const form = FORM_PARAMS[behaviour.form];
  const out: Record<string, number> = {};
  for (const key of Object.keys(form.params)) {
    const value = behaviour.params[key];
    if (value !== undefined)
      out[key] = typeof value === "number" ? value : value.v;
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number" && form.params[key]) out[key] = value;
  }
  return out;
}

function nodeName(net: NetPorts, ground: ReadonlySet<string>): string {
  if (net.ports.some((port) => ground.has(port.full))) return "0";
  const names = net.ports.map((port) => port.full).sort();
  return names[0] ?? "0";
}

function netContaining(
  nets: readonly NetPorts[],
  full: string
): NetPorts | null {
  return (
    nets.find((net) => net.ports.some((port) => port.full === full)) ?? null
  );
}

/**
 * Parts on this board's nets, with a node per port. Ground is every
 * port on the feeding supply's GND net. Other nodes take the first
 * sorted port name on that net.
 */
export function stampBoard(input: {
  boardId: string;
  netlist: boolean;
  /** Expanded type ports. `internal` ports are not chip pins. */
  ports: Record<string, PortDecl>;
  /** `usb.GND`, the feeding supply's ground port. */
  supplyGround: string;
  parts: readonly CircuitInst[];
  nets: readonly NetPorts[];
}): BoardStamp | null {
  const groundNet = netContaining(input.nets, input.supplyGround);
  const ground = new Set<string>();
  if (groundNet) {
    for (const port of groundNet.ports) ground.add(port.full);
  } else {
    ground.add(input.supplyGround);
  }
  const nodeByFull = new Map<string, string>();
  for (const net of input.nets) {
    const node = nodeName(net, ground);
    for (const port of net.ports) nodeByFull.set(port.full, node);
  }

  const mine = input.parts.filter((part) =>
    touches(part, input.boardId, input.nets)
  );
  if (mine.length === 0 && !input.netlist) return null;

  const assigned: AssignedPart[] = mine.map((part) => ({
    path: part.path,
    form: part.form,
    typeId: part.typeId,
    params: part.params,
    nodes: Object.fromEntries(
      Object.entries(part.ports).map(([name, full]) => [
        name,
        nodeByFull.get(full) ?? `${part.path}.${name}`,
      ])
    ),
  }));
  assigned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const boardFull = (port: string) => `${input.boardId}.${port}`;
  const named = (port: string): string | null => {
    const full = boardFull(port);
    return nodeByFull.get(full) ?? null;
  };

  const pins: StampedPin[] = [];
  for (const [port, decl] of Object.entries(input.ports)) {
    if (decl.internal) continue;
    const bit = arduinoPinBit(port);
    if (bit === undefined) continue;
    const full = boardFull(port);
    const net = netContaining(input.nets, full);
    if (!net) continue;
    const hit = net.ports.some((end) =>
      mine.some((part) => Object.values(part.ports).includes(end.full))
    );
    if (!hit) continue;
    const node = nodeByFull.get(full);
    if (!node || node === "0") continue;
    pins.push({ port, bit, node });
  }
  pins.sort((a, b) => a.bit - b.bit || (a.port < b.port ? -1 : 1));

  const boardNode = named("5V") ?? boardFull("5V");
  return {
    netlist: input.netlist,
    boardNode,
    vbusNode: input.ports.VBUS ? named("VBUS") : null,
    resetNode: named("RESET"),
    parts: assigned,
    pins,
  };
}

function touches(
  part: CircuitInst,
  boardId: string,
  nets: readonly NetPorts[]
): boolean {
  if (part.path === boardId || part.path.startsWith(`${boardId}.`)) return true;
  for (const full of Object.values(part.ports)) {
    const net = netContaining(nets, full);
    if (!net) continue;
    if (
      net.ports.some(
        (port) => port.path === boardId || port.path.startsWith(`${boardId}.`)
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Drop a part that has a node nothing else drives. A USB feed anchors
 * `VBUS`, so the Schottky stays. A header feed anchors `5V` only, so
 * that diode's open anode drops it. No extra conductance is added.
 */
export function realize(
  stamp: BoardStamp,
  feed: "usb" | "header",
  drive: AvrPinParams,
  opts?: { pins?: boolean }
): RealizedCircuit {
  const feedNode =
    feed === "usb" && stamp.vbusNode ? stamp.vbusNode : stamp.boardNode;
  const anchors = new Set<string>(["0", feedNode, stamp.boardNode]);
  const withPins = opts?.pins !== false;
  for (const pin of stamp.pins) anchors.add(pin.node);
  const alive = prune(stamp.parts, anchors);
  const made: Element[] = [];
  const leds: { path: string; diode: Diode }[] = [];
  let capacitive = false;
  for (const part of alive) {
    const built = elementOf(part);
    if (built.capacitive) capacitive = true;
    made.push(...built.elements);
    if (built.led) leds.push(built.led);
  }
  made.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pins = withPins
    ? stamp.pins.map((row) => ({
        bit: row.bit,
        pin: new Pin(
          `pin.${row.port}`,
          row.node,
          stamp.boardNode,
          drive.roh,
          drive.rol,
          drive.rpu,
          drive.rLeak
        ),
      }))
    : [];
  return {
    elements: [...made, ...pins.flatMap((row) => row.pin.elements())],
    pins,
    leds,
    feedNode,
    boardNode: stamp.boardNode,
    resetNode: stamp.resetNode,
    capacitive,
  };
}

function prune(
  parts: readonly AssignedPart[],
  anchors: ReadonlySet<string>
): AssignedPart[] {
  let alive = [...parts];
  let changed = true;
  while (changed) {
    changed = false;
    const count = new Map<string, number>();
    for (const part of alive) {
      for (const node of Object.values(part.nodes)) {
        count.set(node, (count.get(node) ?? 0) + 1);
      }
    }
    for (const part of alive) {
      const open = Object.values(part.nodes).some(
        (node) => !anchors.has(node) && (count.get(node) ?? 0) < 2
      );
      if (!open) continue;
      alive = alive.filter((item) => item.path !== part.path);
      changed = true;
      break;
    }
  }
  return alive;
}

function elementOf(part: AssignedPart): {
  elements: Element[];
  capacitive: boolean;
  led?: { path: string; diode: Diode };
} {
  if (part.form === "resistor@1") {
    const a = need(part, "A");
    const b = need(part, "B");
    return {
      elements: [new Resistor(part.path, a, b, needNum(part, "R"))],
      capacitive: false,
    };
  }
  if (part.form === "capacitor@1") {
    const a = need(part, "A");
    const b = need(part, "B");
    const esr = part.params.esr ?? 0;
    const c = needNum(part, "C");
    if (esr > 0) {
      const mid = `${part.path}#j`;
      return {
        elements: [
          new Resistor(`${part.path}#esr`, a, mid, esr),
          new Capacitor(part.path, mid, b, c),
        ],
        capacitive: true,
      };
    }
    return {
      elements: [new Capacitor(part.path, a, b, c)],
      capacitive: true,
    };
  }
  const params: DiodeParams = {
    Is: needNum(part, "Is"),
    N: needNum(part, "N"),
    Rs: part.params.Rs ?? 0,
    tempC: 25,
  };
  const diode = new Diode(part.path, need(part, "A"), need(part, "K"), params);
  return {
    elements: [diode],
    capacitive: false,
    ...(part.typeId === "led" ? { led: { path: part.path, diode } } : {}),
  };
}

function need(part: AssignedPart, port: string): string {
  const node = part.nodes[port];
  if (!node) throw new Error(`${part.path} has no ${port} node`);
  return node;
}

function needNum(part: AssignedPart, key: string): number {
  const value = part.params[key];
  if (!(typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`${part.path} is missing ${key}`);
  }
  return value;
}

function catalogDir(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

/** The Nano class-2 board, parent path `nano`, for rails built without a world. */
export function catalogNanoStamp(): BoardStamp {
  const root = catalogDir();
  const part = JSON.parse(
    readFileSync(join(root, "parts", "sfab", "nano-ch340@1.0.0.json"), "utf8")
  ) as PartFile;
  const behaviour = part.axes?.behaviour?.["2"]?.variants.circuits;
  if (!behaviour || behaviour.kind !== "firmware" || !behaviour.board) {
    throw new Error("nano class 2 has no board netlist");
  }
  const type = JSON.parse(
    readFileSync(join(root, "types", "arduino-nano.json"), "utf8")
  ) as {
    ports: Record<string, PortDecl>;
    templates?: {
      id: string;
      n: [number, number];
      domain: Domain;
      role?: PortRole;
      direction?: PortDirection;
    }[];
  };
  const ports = expandNano(type);
  const boardId = "nano";
  const parts = instancesOf(root, boardId, behaviour.board);
  const nets = netsOf(boardId, behaviour.board, parts, ports);
  const stamp = stampBoard({
    boardId,
    netlist: true,
    ports,
    supplyGround: `${boardId}.GND`,
    parts,
    nets,
  });
  if (!stamp) throw new Error("nano board stamp is empty");
  return stamp;
}

function expandNano(type: {
  ports: Record<string, PortDecl>;
  templates?: {
    id: string;
    n: [number, number];
    domain: PortDecl["domain"];
    role?: PortDecl["role"];
    direction?: PortDecl["direction"];
  }[];
}): Record<string, PortDecl> {
  const ports: Record<string, PortDecl> = { ...type.ports };
  for (const template of type.templates ?? []) {
    const [lo, hi] = template.n;
    for (let n = lo; n <= hi; n++) {
      const id = template.id.replaceAll("{n}", String(n));
      if (ports[id]) continue;
      ports[id] = {
        domain: template.domain,
        ...(template.role ? { role: template.role } : {}),
        ...(template.direction ? { direction: template.direction } : {}),
      };
    }
  }
  return ports;
}

function instancesOf(
  root: string,
  boardId: string,
  netlist: Netlist
): CircuitInst[] {
  const out: CircuitInst[] = [];
  for (const [id, child] of Object.entries(netlist.instances)) {
    const loaded = JSON.parse(
      readFileSync(join(root, "parts", `${child.part}.json`), "utf8")
    ) as PartFile;
    const slot = loaded.axes?.behaviour?.["1"];
    const variant = slot?.variants[slot.default];
    if (!variant || variant.kind !== "form" || !isCircuitForm(variant.form)) {
      throw new Error(`${child.part} is not a circuit part`);
    }
    const form = FORM_PARAMS[variant.form];
    const params: Record<string, number> = {};
    for (const key of Object.keys(form.params)) {
      const value = variant.params[key];
      if (typeof value === "number") params[key] = value;
    }
    for (const [key, value] of Object.entries(child.params ?? {})) {
      if (typeof value === "number" && form.params[key]) params[key] = value;
    }
    const typeName =
      typeof loaded.type === "string" ? loaded.type : loaded.type.id;
    const type = JSON.parse(
      readFileSync(join(root, "types", `${typeName}.json`), "utf8")
    ) as { ports: Record<string, PortDecl> };
    const path = `${boardId}.${id}`;
    const ports: Record<string, string> = {};
    for (const name of Object.keys(type.ports)) ports[name] = `${path}.${name}`;
    out.push({ path, form: variant.form, typeId: typeName, params, ports });
  }
  return out;
}

function netsOf(
  boardId: string,
  netlist: Netlist,
  parts: readonly CircuitInst[],
  boardPorts: Record<string, PortDecl>
): NetPorts[] {
  const parent = new Map<string, string>();
  const add = (full: string) => {
    if (!parent.has(full)) parent.set(full, full);
  };
  const find = (full: string): string => {
    const p = parent.get(full);
    if (p === undefined) throw new Error(`unknown port ${full}`);
    if (p !== full) {
      const root = find(p);
      parent.set(full, root);
      return root;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    const pa = find(a);
    const pb = find(b);
    if (pa === pb) return;
    if (pa < pb) parent.set(pb, pa);
    else parent.set(pa, pb);
  };
  for (const part of parts) {
    for (const full of Object.values(part.ports)) add(full);
  }
  for (const name of Object.keys(boardPorts)) add(`${boardId}.${name}`);
  const endOf = (ref: string): string => {
    const dot = ref.indexOf(".");
    const inst = ref.slice(0, dot);
    const port = ref.slice(dot + 1);
    return `${boardId}.${inst}.${port}`;
  };
  for (const [outer, inner] of Object.entries(netlist.expose)) {
    union(`${boardId}.${outer}`, endOf(inner));
  }
  for (const [a, b] of netlist.wires) union(endOf(a), endOf(b));
  const groups = new Map<string, string[]>();
  for (const full of [...parent.keys()].sort()) {
    const root = find(full);
    const list = groups.get(root);
    if (list) list.push(full);
    else groups.set(root, [full]);
  }
  const nets: NetPorts[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort();
    nets.push({
      ports: members.map((full) => {
        const port = full.slice(full.lastIndexOf(".") + 1);
        const path = full.slice(0, full.lastIndexOf("."));
        return { full, path, port };
      }),
    });
  }
  return nets;
}

/** USB trace stimulus on the netlist. Capacitors stay; the probe is named by the caller. */
export function nanoTraceStimulus(kind: "usb" | "d13"): {
  elements: Element[];
  probe: string;
} {
  const stamp = catalogNanoStamp();
  const realized = realize(stamp, "usb", AVR_PIN, { pins: false });
  const d13 = stamp.pins.find((pin) => pin.port === "D13")?.node;
  if (!d13) throw new Error("nano trace has no D13");
  const board = realized.boardNode;
  const leak = new Resistor("d13leak", d13, "0", AVR_PIN.rLeak);
  const head: Element[] = [
    new VSource("vusb", "src", "0", { kind: "dc", value: 5 }),
    new Resistor("rs", "src", realized.feedNode, 0.5),
    ...realized.elements,
    leak,
  ];
  if (kind === "usb") {
    return {
      probe: board,
      elements: [
        ...head,
        new Resistor("roh", board, d13, PIN_ROH),
        new ISource("iboard", board, "0", { kind: "dc", value: 0.0252 }),
        new ISource("iload", board, "0", {
          kind: "step",
          t0: 1e-3,
          v0: 0,
          v1: 0.7,
        }),
      ],
    };
  }
  const period = 1e-3;
  return {
    probe: d13,
    elements: [
      ...head,
      new Switch("d13h", board, d13, PIN_ROH, PIN_ROFF, {
        kind: "pwm",
        period,
        duty: 0.5,
        low: 0,
        high: 1,
      }),
      new Switch("d13l", d13, "0", PIN_ROL, PIN_ROFF, {
        kind: "pwm",
        period,
        duty: 0.5,
        low: 1,
        high: 0,
      }),
      new ISource("iboard", board, "0", { kind: "dc", value: 0.0252 }),
    ],
  };
}

/** Flattened USB front end, capacitors included. They are open at DC. */
export function describeNetlist(rSeries: number): unknown {
  const stamp = catalogNanoStamp();
  const realized = realize(stamp, "usb", AVR_PIN);
  return {
    rSeries,
    feed: realized.feedNode,
    board: realized.boardNode,
    elements: realized.elements.map((el) => describeElement(el)),
  };
}

function describeElement(el: Element): unknown {
  if (el instanceof Resistor) {
    return { id: el.id, form: el.form, R: el.R, nodes: [...el.nodes()] };
  }
  if (el instanceof Capacitor) {
    return { id: el.id, form: el.form, C: el.C, nodes: [...el.nodes()] };
  }
  if (el instanceof Diode) {
    return {
      id: el.id,
      form: el.form,
      Is: el.params.Is,
      N: el.params.N,
      Rs: el.params.Rs,
      nodes: [...el.nodes()],
    };
  }
  return { id: el.id, form: el.form, nodes: [...el.nodes()] };
}

export function liveNets(nets: readonly LiveNet[]): NetPorts[] {
  return nets.map((net) => ({
    ports: net.ports.map((port) => ({
      full: port.full,
      path: port.path,
      port: port.port,
    })),
  }));
}
