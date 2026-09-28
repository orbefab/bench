/**
 * Circuit parts become rail elements. A firmware `board` netlist is the
 * same step: its children are parts, and `buildNets` names the nodes.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  arduinoPinBit,
  type BehaviourImpl,
  FORM_PARAMS,
  type LevelClass,
  PART_FORMAT,
  PART_TYPE_FORMAT,
  type PartFile,
  type PortDecl,
} from "@sfab-bench/contract";

import type { Element } from "./circuit/element";
import {
  Capacitor,
  Diode,
  type DiodeParams,
  Resistor,
} from "./circuit/elements";
import { LawTable } from "./circuit/law-table";
import { AVR_PIN, type AvrPinParams, Pin } from "./circuit/pin";
import { PmosChannel } from "./circuit/pmos-switch";
import { PtcFuseElement, type PtcFuseParams } from "./circuit/ptc-fuse";
import { compileRules, type LiveInstance, resolveLevels } from "./parts/levels";
import {
  type Library,
  type LibraryOptions,
  type LoadedPart,
  type LoadedType,
  lintLibrary,
  loadPartById,
  loadTypeById,
} from "./parts/library";
import { buildNets, type LiveNet, netlistOf } from "./parts/nets";
import { chipFacts } from "./power-path";
import {
  envelopeOf,
  type SnapshotEnvelope,
  type TableLaw,
  tableLawOf,
} from "./snapshot-law";
import { loadSnapshot } from "./snapshot-load";

export const CIRCUIT_FORMS = [
  "resistor@1",
  "capacitor@1",
  "diode@1",
  "ptc-fuse@1",
  "pmos-switch@1",
] as const;
export type CircuitForm = (typeof CIRCUIT_FORMS)[number];

export function isCircuitForm(form: string): form is CircuitForm {
  return (CIRCUIT_FORMS as readonly string[]).includes(form);
}

/** A `table@1` branch stamped beside the resistor, capacitor and diode. */
export type StampedTable = {
  ref: string;
  law: TableLaw;
  envelope: SnapshotEnvelope;
};

export type StampedForm = CircuitForm | "table@1";

export type CircuitInst = {
  path: string;
  form: StampedForm;
  typeId: string;
  params: Record<string, number>;
  /** Port name → `path.port`. */
  ports: Record<string, string>;
  table?: StampedTable;
};

export type AssignedPart = {
  path: string;
  form: StampedForm;
  typeId: string;
  params: Record<string, number>;
  /** Port name → node. Ground is `"0"`. */
  nodes: Record<string, string>;
  table?: StampedTable;
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
  /** Null when the type has no USB connector port on a net. */
  vbusNode: string | null;
  resetNode: string | null;
  /** `${boardId}.led` when that part is an LED. The rail copies it onto `ledCurrent`. */
  ledAlias: string | null;
  /** V_RST / VCC for this chip. Null when the chip is unknown here. */
  resetFraction: number | null;
  /** Board port → node. Absent when that port is not on a net. */
  portNodes: Record<string, string>;
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
 * Non-internal power inputs whose voltage rating holds `railVoltage`.
 * `VIN` on these boards is 7–12 V, so a 5 V chip does not take it.
 */
export function railPowerPorts(
  ports: Record<string, PortDecl>,
  railVoltage: number
): string[] {
  const names: string[] = [];
  for (const [name, decl] of Object.entries(ports)) {
    if (decl.internal || decl.role !== "power" || decl.direction !== "in") {
      continue;
    }
    const range = decl.ratings?.voltage;
    if (!range) continue;
    const low = typeof range[0] === "number" ? range[0] : range[0]?.v;
    const high = typeof range[1] === "number" ? range[1] : range[1]?.v;
    if (typeof low !== "number" || typeof high !== "number") continue;
    if (railVoltage < low || railVoltage > high) continue;
    names.push(name);
  }
  names.sort();
  return names;
}

/** Ground ports a wire can land on. Sorted, so the choice is stable. */
export function groundPorts(ports: Record<string, PortDecl>): string[] {
  return Object.entries(ports)
    .filter(([, decl]) => decl.role === "ground" && !decl.internal)
    .map(([name]) => name)
    .sort();
}

/** The port that says which connector it is. One connector per board today. */
export function connectorPort(
  ports: Record<string, PortDecl>,
  connector: string
): string | null {
  return (
    Object.entries(ports).find(
      ([, decl]) => decl.connector === connector
    )?.[0] ?? null
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
  /** The feeding supply's ground port, for example `usb.GND`. */
  supplyGround: string;
  /** Non-internal power input whose rating holds the chip rail. */
  powerPort: string;
  /** Logic port the chip uses as reset. Null when the variant names none. */
  resetPort: string | null;
  /** Internal port with `connector: "usb"`. Null when the type has none. */
  usbPort: string | null;
  /** V_RST / VCC. Null when this stamp has no reset threshold. */
  resetFraction: number | null;
  parts: readonly CircuitInst[];
  /**
   * Parts on this supply that share no net with the board. They still
   * belong to this rail. `realize` may prune one whose node is open.
   */
  also?: readonly CircuitInst[];
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

  const touched = input.parts.filter((part) =>
    touches(part, input.boardId, input.nets)
  );
  const seen = new Set(touched.map((part) => part.path));
  const mine = [
    ...touched,
    ...(input.also ?? []).filter((part) => !seen.has(part.path)),
  ];
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
    ...(part.table ? { table: part.table } : {}),
  }));
  assigned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const part of assigned) {
    if (part.form !== "pmos-switch@1") continue;
    const gate = part.nodes.G;
    // An unwired gate is a private node. `realize` would prune the
    // switch before `elementOf` could see it, so the miss is an error here.
    if (!gate || gate === `${part.path}.G`) {
      throw new Error(`${part.path}: pmos-switch@1 has no gate net`);
    }
  }

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

  const boardNode = named(input.powerPort) ?? boardFull(input.powerPort);
  const portNodes: Record<string, string> = {};
  for (const port of Object.keys(input.ports)) {
    const node = named(port);
    if (node) portNodes[port] = node;
  }
  const ledAlias =
    assigned.find(
      (part) => part.path === `${input.boardId}.led` && part.typeId === "led"
    )?.path ?? null;
  return {
    netlist: input.netlist,
    boardNode,
    vbusNode: input.usbPort ? named(input.usbPort) : null,
    resetNode: input.resetPort ? named(input.resetPort) : null,
    ledAlias,
    resetFraction: input.resetFraction,
    portNodes,
    parts: assigned,
    pins,
  };
}

/**
 * A part belongs to a board when it is nested there, or when one of its
 * ports shares a net with that board. A part sitting between two boards
 * on different supplies shares a net with each, so it would be stamped
 * into both rails under the same element ids. The plan rejects that:
 * one part has one rail.
 */
export function touches(
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
  opts?: {
    pins?: boolean;
    keep?: readonly string[];
    /** Pin element id. Absent is `pin.${port}`, one board on the rail. */
    pinId?: (port: string) => string;
  }
): RealizedCircuit {
  const feedNode =
    feed === "usb" && stamp.vbusNode ? stamp.vbusNode : stamp.boardNode;
  const anchors = new Set<string>(["0", feedNode, stamp.boardNode]);
  for (const node of opts?.keep ?? []) anchors.add(node);
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
          opts?.pinId?.(row.port) ?? `pin.${row.port}`,
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
  // One removal per scan, in path order, so a part that only opens after
  // another drop is still caught. O(n²) in the part count, on purpose.
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
  if (part.form === "table@1") {
    const law = part.table?.law;
    if (!law) throw new Error(`${part.path} table is missing its law`);
    return {
      elements: [
        new LawTable(
          part.path,
          need(part, law.across[0]),
          need(part, law.across[1]),
          law,
          0
        ),
      ],
      capacitive: false,
    };
  }
  if (part.form === "ptc-fuse@1") {
    const params: PtcFuseParams = {
      rCold: needNum(part, "rCold"),
      rHot: needNum(part, "rHot"),
      iHold: needNum(part, "iHold"),
      iTrip: needNum(part, "iTrip"),
      tripPower: needNum(part, "tripPower"),
      tau: needNum(part, "tau"),
      uReset: needNum(part, "uReset"),
    };
    return {
      elements: [
        new PtcFuseElement(part.path, need(part, "A"), need(part, "B"), params),
      ],
      capacitive: false,
    };
  }
  if (part.form === "pmos-switch@1") {
    const gate = part.nodes.G;
    if (!gate || gate === `${part.path}.G`) {
      throw new Error(`${part.path}: pmos-switch@1 has no gate net`);
    }
    const source = need(part, "S");
    const drain = need(part, "D");
    const diode: DiodeParams = {
      Is: needNum(part, "Is"),
      N: needNum(part, "N"),
      Rs: part.params.Rs ?? 0,
      tempC: 25,
    };
    return {
      elements: [
        new PmosChannel(
          part.path,
          source,
          drain,
          gate,
          needNum(part, "rds"),
          needNum(part, "vth")
        ),
        new Diode(`${part.path}#d`, drain, source, diode),
      ],
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

export type BoardStampOptions = {
  /** Catalog root. Defaults to this package's catalog. */
  catalogDir?: string;
  /** Personal library. A part here shadows the catalog. */
  libraryDir?: string;
  /** Project directory. Defaults to a directory with no parts. */
  worldDir?: string;
  /** Where relative lock paths would be counted from. */
  assetRoot?: string;
  /**
   * Instance path of the board. Node names are `<boardId>.<port>`.
   * Default `board`.
   */
  boardId?: string;
  /**
   * Composite port pair. The first port is the anchored node. A firmware
   * board ignores this and uses its declared power port.
   */
  across?: readonly [string, string];
};

const CLASS_KEYS = ["0", "1", "2", "3"] as const;

function defaultCatalog(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

function asPart(value: LoadedPart | { message: string }): LoadedPart {
  if ("part" in value) return value;
  throw new Error(value.message);
}

function asType(value: LoadedType | { message: string }): LoadedType {
  if ("type" in value) return value;
  throw new Error(value.message);
}

function childIds(part: PartFile): string[] {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return [];
  const ids: string[] = [];
  for (const key of CLASS_KEYS) {
    const slot = behaviour[key];
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      const netlist =
        variant.kind === "composite"
          ? variant.netlist
          : variant.kind === "firmware"
            ? variant.board
            : null;
      if (!netlist) continue;
      for (const inst of Object.values(netlist.instances)) ids.push(inst.part);
    }
  }
  return ids;
}

/**
 * The class whose `variant` is a firmware board or a circuit composite.
 * Throws when the variant is missing or is neither.
 */
function variantSlot(
  part: PartFile,
  variant: string
): { key: (typeof CLASS_KEYS)[number]; kind: "firmware" | "composite" } {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) throw new Error(`${part.id} has no behaviour`);
  let saw = false;
  for (const key of CLASS_KEYS) {
    const impl = behaviour[key]?.variants[variant];
    if (!impl) continue;
    saw = true;
    if (impl.kind === "firmware" && impl.board)
      return { key, kind: "firmware" };
    if (impl.kind === "composite") return { key, kind: "composite" };
  }
  if (!saw) throw new Error(`${part.id} has no variant ${variant}`);
  throw new Error(`${part.id} variant ${variant} is not a circuit assembly`);
}

/** A `table@1` behaviour, stamped on its `across` ports. */
function snapshotInstOf(
  inst: LiveInstance,
  catalogDir: string,
  worldDir: string
): CircuitInst | null {
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (behaviour?.kind !== "snapshot") return null;
  const found = loadSnapshot(
    worldDir,
    { catalogDir, assetRoot: catalogDir },
    behaviour.ref,
    inst.type
  );
  if (!found.loaded) {
    const text = found.diagnostics.map((diag) => diag.message).join("; ");
    throw new Error(
      text || `${inst.path} snapshot ${behaviour.ref} did not load`
    );
  }
  const law = tableLawOf(found.loaded.file);
  const envelope = envelopeOf(found.loaded.file);
  if (!law || !envelope || found.loaded.file.form !== "table@1") {
    throw new Error(`${inst.path} snapshot ${behaviour.ref} is not table@1`);
  }
  const ports: Record<string, string> = {};
  for (const name of law.across) ports[name] = `${inst.path}.${name}`;
  return {
    path: inst.path,
    form: "table@1",
    typeId: inst.type.id,
    params: {},
    ports,
    table: { ref: behaviour.ref, law, envelope },
  };
}

function circuitInstOf(inst: {
  path: string;
  params: Record<string, number | string | boolean>;
  type: { id: string; ports: Record<string, PortDecl> };
  axes: { behaviour: { impl: unknown } };
}): CircuitInst | null {
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (
    !behaviour ||
    behaviour.kind !== "form" ||
    !isCircuitForm(behaviour.form)
  ) {
    return null;
  }
  const params = circuitNumbers(behaviour, inst.params);
  if (!params) return null;
  const ports: Record<string, string> = {};
  for (const [name, decl] of Object.entries(inst.type.ports)) {
    if (decl.internal) continue;
    ports[name] = `${inst.path}.${name}`;
  }
  return {
    path: inst.path,
    form: behaviour.form,
    typeId: inst.type.id,
    params,
    ports,
  };
}

/**
 * Resolve one firmware board and stamp its netlist.
 * Parts and types come from the library (project, then personal, then
 * catalog), with template expansion and `buildNets`. `boardId` is the
 * instance path, so a world that names the board `nano` matches.
 */
/** Firmware board. A composite variant is `assemblyStampOf`. */
export function boardStampOf(
  partId: string,
  variant: string,
  opts: BoardStampOptions = {}
): BoardStamp {
  return stampOf(partId, variant, opts, true);
}

/**
 * Circuit leaves of a firmware board or a composite, one loader.
 * A composite leaf that is not a circuit part throws, naming the path.
 */
export function assemblyStampOf(
  partId: string,
  variant: string,
  opts: BoardStampOptions = {}
): BoardStamp {
  return stampOf(partId, variant, opts, false);
}

function stampOf(
  partId: string,
  variant: string,
  opts: BoardStampOptions,
  firmwareOnly: boolean
): BoardStamp {
  const catalogDir = opts.catalogDir ?? defaultCatalog();
  const worldDir = opts.worldDir ?? join(catalogDir, ".board-stamp-world");
  const assetRoot = opts.assetRoot ?? catalogDir;
  const boardId = opts.boardId ?? "board";
  const libOpts: LibraryOptions = {
    catalogDir,
    assetRoot,
    ...(opts.libraryDir ? { libraryDir: opts.libraryDir } : {}),
  };
  const parts = new Map<string, LoadedPart>();
  const types = new Map<string, LoadedType>();
  const queue = [partId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || parts.has(id)) continue;
    const found = asPart(loadPartById(worldDir, libOpts, id));
    parts.set(id, found);
    const typeId = found.part.type;
    if (typeof typeId === "string" && !types.has(typeId)) {
      types.set(typeId, asType(loadTypeById(worldDir, libOpts, typeId)));
    }
    for (const child of childIds(found.part)) {
      if (!parts.has(child)) queue.push(child);
    }
  }
  const loaded = parts.get(partId);
  if (!loaded) throw new Error(`${partId} did not load`);
  const slot = variantSlot(loaded.part, variant);
  if (firmwareOnly && slot.kind !== "firmware") {
    throw new Error(`${partId} variant ${variant} is not a firmware board`);
  }
  const classKey = slot.key;
  const part = structuredClone(loaded.part);
  const chosen = part.axes?.behaviour?.[classKey];
  if (chosen) chosen.default = variant;
  parts.set(partId, { ...loaded, part });

  const wrapper: PartFile = {
    format: PART_FORMAT,
    id: "sfab/board-stamp@0",
    type: {
      format: PART_TYPE_FORMAT,
      id: "board-stamp-root",
      ports: {},
    },
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["stamp root"],
              netlist: {
                instances: { [boardId]: { part: partId } },
                wires: [],
                expose: {},
              },
            },
          },
        },
      },
      body: {
        "0": {
          default: "none",
          variants: { none: { kind: "none", omits: ["none"] } },
        },
      },
      visual: {
        "0": {
          default: "none",
          variants: { none: { kind: "none", omits: ["none"] } },
        },
      },
    },
  };
  const lib: Library = {
    worldDir,
    worldName: "board-stamp",
    assetRoot,
    parts,
    types,
    world: {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: {
        seed: 1,
        levels: {
          default: { behaviour: 2, body: 0, visual: 0 },
          paths: { [boardId]: { behaviour: Number(classKey) as LevelClass } },
        },
      },
      root: { id: "stamp", part: wrapper },
    },
  };
  const errors = lintLibrary(lib).filter((diag) => diag.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((diag) => diag.message).join("; "));
  }
  const { instances } = resolveLevels(lib, compileRules(lib.world));
  const board = instances.find((inst) => inst.path === boardId);
  if (!board || !netlistOf(board)) {
    throw new Error(
      firmwareOnly
        ? `${partId} variant ${variant} is not a firmware board`
        : `${partId} variant ${variant} is not a circuit assembly`
    );
  }
  const circuitParts: CircuitInst[] = [];
  for (const inst of instances) {
    const row =
      circuitInstOf(inst) ?? snapshotInstOf(inst, catalogDir, worldDir);
    if (row) circuitParts.push(row);
  }
  const built = buildNets(instances, undefined);
  if (slot.kind === "composite") {
    for (const inst of instances) {
      if (inst.path === "$root" || inst.path === boardId) continue;
      const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
      if (behaviour?.kind === "composite") continue;
      if (circuitParts.some((part) => part.path === inst.path)) continue;
      throw new Error(`${partId}: ${inst.path} is not a circuit leaf`);
    }
  }
  const behaviour = board.axes.behaviour.impl as BehaviourImpl | null;
  const facts =
    behaviour?.kind === "firmware" ? chipFacts(behaviour.chip) : null;
  const ground = groundPorts(board.type.ports)[0];
  if (!ground) throw new Error(`${partId} has no ground port`);
  let powerPort: string | undefined;
  let resetFraction: number | null = null;
  if (slot.kind === "firmware") {
    if (!facts) throw new Error(`${partId} has no chip rail`);
    powerPort = railPowerPorts(board.type.ports, facts.railVoltage)[0];
    resetFraction = facts.resetFraction;
    if (!powerPort) throw new Error(`${partId} has no power port`);
  } else {
    const across = opts.across;
    if (!across) throw new Error(`${partId} has no across pair`);
    for (const name of across) {
      if (!board.type.ports[name]) {
        throw new Error(
          `${partId} across port ${name} is not on ${board.type.id}`
        );
      }
    }
    powerPort = across[0];
  }
  const resetPort =
    behaviour?.kind === "firmware" ? (behaviour.resetPort ?? null) : null;
  const stamp = stampBoard({
    boardId,
    netlist: slot.kind === "firmware",
    ports: board.type.ports,
    supplyGround: `${boardId}.${ground}`,
    powerPort,
    resetPort,
    usbPort: connectorPort(board.type.ports, "usb"),
    resetFraction,
    parts: circuitParts,
    nets: liveNets(built.nets),
  });
  if (!stamp) throw new Error(`${partId} variant ${variant} stamped nothing`);
  return stamp;
}

/** Flattened front end. Capacitors are included; they are open at DC. */
export function describeNetlist(
  stamp: BoardStamp,
  rSeries: number,
  feed: "usb" | "header"
): unknown {
  const realized = realize(stamp, feed, AVR_PIN);
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
