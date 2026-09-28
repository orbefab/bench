// Ported from layered-sim E2 src/circuit.ts and src/couple.ts @ 8731557.
/**
 * One supply rail solved with the motor stamps.
 * The circuit is built once. A step only changes the fixed load, each
 * bridge ratio, each held speed, and, when the Uno path is on, the fuse
 * resistance after the electrical solve.
 *
 * L = 0 and no board path is one backward-Euler step per millisecond.
 * A board path (it has capacitors) or L > 0 is 10 backward-Euler steps
 * with ω and the bridge ratio held. The fuse temperature moves once per
 * millisecond, after those steps, not inside them.
 * Implicit damping (E2 scheme (d)) is not applied here. It would stamp
 * ω = 0 and add B(s) on the joint.
 */

import { arduinoPinBit } from "@sfab-bench/contract";
import type { Element } from "./circuit/element";
import {
  type Braking,
  BridgeMotor,
  CurrentLoad,
  type Diode,
  TheveninLimit,
} from "./circuit/elements";
import { Engine } from "./circuit/engine";
import { LawTable } from "./circuit/law-table";
import { AVR_PIN, type AvrPinParams, type PinMode } from "./circuit/pin";
import { PmosChannel } from "./circuit/pmos-switch";
import { PtcFuseElement } from "./circuit/ptc-fuse";
import { type BoardStamp, realize } from "./circuit-stamp";
import {
  BOARD_LOAD_KNEE_V,
  type BoardPathName,
  UNO_BOARD_NODE,
  UNO_TERM_NODE,
} from "./power-path";
import type { TableLaw } from "./snapshot-law";

export type { Braking };

export type RailMotorLaw = {
  resistance: number;
  /** V·s/rad. */
  k: number;
  /** Henries. Absent or 0 is the algebraic winding. */
  inductance?: number;
  /** Board whose 5V node this winding sits on, when several boards share the rail. */
  boardId?: string;
};

export type SharedBoard = {
  id: string;
  stamp: BoardStamp;
  feed: "usb" | "header";
  pin?: AvrPinParams;
};

export type RailCircuitSpec = {
  vNom: number;
  rSeries: number;
  iLimit: number;
  motors: readonly RailMotorLaw[];
  /** Default `clip`, matching `solveRail`. */
  braking?: Braking;
  /**
   * Default `none`: the supply terminal is the rail, as in the closed form.
   * `uno-usb` inserts the Uno cable. `snapshot-feed` is the class-1 USB
   * law: a Thevenin table, no capacitors. A class-2 board passes `stamp`
   * and `feed` instead of a path name.
   */
  boardPath?: "none" | BoardPathName;
  /** Diode-law table for `snapshot-feed`. The supply setpoint is `vNom`. */
  law?: TableLaw;
  /** D13 `avr-pin@1` numbers. Absent uses the datasheet fits. */
  pin?: AvrPinParams;
  /**
   * Circuit parts for this rail, from the plan.
   * `path:uno-usb` with no stamp loads the Uno board netlist.
   */
  stamp?: BoardStamp;
  /**
   * Where the supply attaches when `stamp` is set. `usb` uses `VBUS`
   * when the stamp has that node. `header` uses the board 5V node.
   */
  feed?: "usb" | "header";
  /** `leds` key copied onto `ledCurrent`. From the stamp when omitted. */
  ledAlias?: string;
  /** V_RST / VCC. From the stamp when omitted. */
  resetFraction?: number;
  /**
   * Every board on this supply. Two or more are one circuit: one
   * source, each board's netlist under its own path. One board keeps
   * `stamp` and `feed`.
   */
  boards?: readonly SharedBoard[];
};

const MASTER_S = 0.001;
const SUBSTEPS = 10;

function missingLaw(): never {
  throw new Error("snapshot-feed needs a diode-law table");
}

export class RailCircuit {
  readonly winding: Float64Array;
  /** True when the Uno cable sits between the terminal and the board node. */
  readonly path: boolean;
  /** Supply terminal. With no path this is the rail, and the only node. */
  voltage = 0;
  current = 0;
  /** Board node at the end of the step. Equal to `voltage` when there is no path. */
  boardVoltage = 0;
  /** Lowest board-node voltage across the sub-steps. The end voltage on the first solve. */
  boardMinVoltage = 0;
  /** Electrical steps inside one 1 ms master step. */
  readonly substeps: number;
  /** Frozen-factor steps during the last master step. */
  lastFrozen = 0;
  /**
   * Amperes through `ledAlias`. 0 when that LED is not on this rail.
   * Prefer `leds`. This field stays for the D13 card and the gauge.
   */
  ledCurrent = 0;
  /** Forward current of every LED on this rail, keyed by instance path. */
  leds: Record<string, number> = {};
  readonly ledPaths: readonly string[];
  /** Arduino bits that have a pin element on this rail. */
  get driveBits(): readonly number[] {
    return this.drives.map((row) => row.bit);
  }
  /** Volts on the RESET node. 0 when this rail has no Nano path. */
  resetVoltage = 0;
  /**
   * Lowest `V_reset − 0.9·V_board` over this step's sub-steps.
   * Positive means RESET stayed above the external threshold.
   */
  resetMarginMin = 0;
  private readonly engine: Engine;
  private readonly load: CurrentLoad;
  private readonly motors: BridgeMotor[];
  private readonly termNode: string;
  private readonly boardNode: string;
  private readonly fuse: PtcFuseElement[];
  private readonly channels: PmosChannel[];
  private readonly drives: {
    bit: number;
    pin: { setMode(mode: PinMode): void };
  }[];
  private readonly ledDiodes: { path: string; diode: Diode }[];
  private readonly ledAlias: string;
  private readonly resetFraction: number | null;
  private readonly resetNode: string | null;
  /** Plain-branch tables stamped with the board. The feed table is `src`. */
  private readonly branchLaws: LawTable[];
  private ready = false;
  private shared = false;
  /** Shared rails start the operating point here. One board leaves this at 0. */
  private seedVolts = 0;
  private readonly boardLoads = new Map<string, CurrentLoad>();
  private readonly boardNodes = new Map<string, string>();
  private readonly boardDrives = new Map<
    string,
    { bit: number; pin: { setMode(mode: PinMode): void } }[]
  >();
  private readonly readings = new Map<
    string,
    { voltage: number; min: number }
  >();
  private readonly boardOrder: string[] = [];
  private readonly boardResets = new Map<
    string,
    { node: string; fraction: number | null }
  >();

  constructor(spec: RailCircuitSpec) {
    if ((spec.boards?.length ?? 0) > 1) {
      const built = sharedRail(spec);
      this.winding = built.winding;
      this.path = built.path;
      this.substeps = built.substeps;
      this.ledPaths = built.ledPaths;
      this.engine = built.engine;
      this.load = built.load;
      this.motors = built.motors;
      this.termNode = built.termNode;
      this.boardNode = built.boardNode;
      this.fuse = built.fuse;
      this.channels = built.channels;
      this.drives = built.drives;
      this.ledDiodes = built.ledDiodes;
      this.ledAlias = built.ledAlias;
      this.resetFraction = built.resetFraction;
      this.resetNode = built.resetNode;
      this.branchLaws = built.branchLaws;
      this.shared = true;
      this.seedVolts = spec.vNom;
      this.boardOrder.push(...built.boardOrder);
      for (const [id, load] of built.boardLoads) this.boardLoads.set(id, load);
      for (const [id, node] of built.boardNodes) this.boardNodes.set(id, node);
      for (const [id, rows] of built.boardDrives)
        this.boardDrives.set(id, rows);
      for (const [id, reset] of built.boardResets)
        this.boardResets.set(id, reset);
      return;
    }
    const braking = spec.braking ?? "clip";
    const uno = spec.boardPath === "uno-usb";
    const snap = spec.boardPath === "snapshot-feed";
    const stamp = spec.stamp ?? null;
    const feed = spec.feed;
    if (stamp && feed !== "usb" && feed !== "header") {
      throw new Error("a board stamp needs feed usb or header");
    }
    const realized = stamp
      ? realize(stamp, feed ?? "header", spec.pin ?? AVR_PIN)
      : null;
    const nano = realized !== null && stamp?.netlist === true;
    const board = uno || nano;
    this.path = board;
    this.termNode = realized
      ? realized.feedNode
      : snap
        ? UNO_BOARD_NODE
        : board
          ? UNO_TERM_NODE
          : "rail";
    this.boardNode = realized
      ? realized.boardNode
      : board || snap
        ? UNO_BOARD_NODE
        : "rail";
    this.drives = realized?.pins ?? [];
    this.ledDiodes = realized?.leds ?? [];
    this.ledPaths = this.ledDiodes.map((led) => led.path);
    this.ledAlias = spec.ledAlias ?? stamp?.ledAlias ?? "";
    this.resetNode = realized?.resetNode ?? null;
    this.resetFraction = spec.resetFraction ?? stamp?.resetFraction ?? null;
    let inductive = false;
    const motors: BridgeMotor[] = [];
    for (let i = 0; i < spec.motors.length; i++) {
      const law = spec.motors[i]!;
      const inductance = law.inductance ?? 0;
      if (inductance > 0) inductive = true;
      motors.push(
        new BridgeMotor(
          `m${i}`,
          this.boardNode,
          law.resistance,
          inductance,
          law.k,
          braking
        )
      );
    }
    this.motors = motors;
    this.branchLaws = (realized?.elements ?? []).filter(
      (el): el is LawTable => el instanceof LawTable
    );
    this.substeps = inductive || board || realized?.capacitive ? SUBSTEPS : 1;
    // The snapshot replaces the USB front end. The board load still
    // has its knee: full current down to 1 V, then linear to 0 A at 0 V.
    this.load = new CurrentLoad(
      "load",
      this.boardNode,
      "0",
      board || snap ? BOARD_LOAD_KNEE_V : 0
    );
    const supply = snap
      ? new LawTable(
          "src",
          this.boardNode,
          "0",
          spec.law ?? missingLaw(),
          spec.vNom,
          spec.iLimit
        )
      : new TheveninLimit(
          "src",
          this.termNode,
          "0",
          spec.vNom,
          spec.rSeries,
          spec.iLimit
        );
    const stamped = realized?.elements ?? [];
    this.fuse = stamped.filter(
      (el): el is PtcFuseElement => el instanceof PtcFuseElement
    );
    this.channels = stamped.filter(
      (el): el is PmosChannel => el instanceof PmosChannel
    );
    this.winding = new Float64Array(motors.length);
    this.engine = new Engine([supply, this.load, ...motors, ...stamped], {
      method: "be",
      h: MASTER_S / this.substeps,
      atol: 1e-14,
      rtol: 1e-12,
    });
  }

  /**
   * Set every node to `volts` before the first operating point. The
   * polyfuse trip with a fixed load and no motor needs this: a knee
   * linearized at 0 V asks for more than the supply limit, and the next
   * stamp has no voltage unknown.
   */
  seedNodes(volts: number): void {
    this.engine.seedNodes(volts);
  }

  setFixed(amps: number): void {
    if (this.shared) {
      const first = this.boardOrder[0];
      const load = first ? this.boardLoads.get(first) : undefined;
      if (load) load.amps = amps;
      return;
    }
    this.load.amps = amps;
  }

  get sharedRail(): boolean {
    return this.shared;
  }

  /** One board's knee load, when several boards share this rail. */
  setBoardLoad(id: string, amps: number): void {
    const load = this.boardLoads.get(id);
    if (!load) throw new Error(`no board ${id}`);
    load.amps = amps;
  }

  driveBitsOf(id: string): readonly number[] {
    return (this.boardDrives.get(id) ?? []).map((row) => row.bit);
  }

  setBoardDrive(id: string, bit: number, mode: PinMode): void {
    const found = this.boardDrives.get(id)?.find((row) => row.bit === bit);
    found?.pin.setMode(mode);
  }

  /**
   * This board's node. One board on the rail is `boardVoltage` /
   * `boardMinVoltage`.
   */
  boardReading(id: string): { voltage: number; min: number } {
    return (
      this.readings.get(id) ?? {
        voltage: this.boardVoltage,
        min: this.boardMinVoltage,
      }
    );
  }

  /** Axis current and voltage of one plain-branch table, after a solve. */
  tableReading(id: string): { amps: number; volts: number } | null {
    const law = this.branchLaws.find((item) => item.id === id);
    if (!law) return null;
    return { amps: law.seenAxis, volts: law.seenVolts };
  }

  setMotor(
    index: number,
    fraction: number,
    omega: number,
    connected: boolean
  ): void {
    const motor = this.motors[index];
    if (!motor) throw new Error(`no motor ${index}`);
    motor.s = fraction;
    motor.omega = omega;
    motor.connected = connected;
  }

  get tripped(): boolean {
    return this.fuse.some((fuse) => fuse.tripped);
  }

  /** Open every fuse on this rail before the next solve. */
  tripFuse(): void {
    for (const fuse of this.fuse) fuse.trip();
  }

  /** One stamped pin follows the firmware drive at this master step. */
  setDrive(bit: number, mode: PinMode): void {
    const found = this.drives.find((row) => row.bit === bit);
    found?.pin.setMode(mode);
  }

  /** D13. Same as `setDrive` for that bit. */
  setD13(mode: PinMode): void {
    const bit = arduinoPinBit("D13");
    if (bit === undefined) return;
    this.setDrive(bit, mode);
  }

  private noteNano(): void {
    const leds: Record<string, number> = {};
    for (const led of this.ledDiodes) leds[led.path] = led.diode.amps;
    this.leds = leds;
    this.ledCurrent = this.ledAlias ? (leds[this.ledAlias] ?? 0) : 0;
    if (!this.resetNode) return;
    const board = this.engine.voltage(this.boardNode);
    const reset = this.engine.voltage(this.resetNode);
    this.resetVoltage = reset;
    if (this.resetFraction === null) return;
    const margin = reset - this.resetFraction * board;
    if (margin < this.resetMarginMin) this.resetMarginMin = margin;
  }

  /**
   * Solve the rail. Writes the terminal, the board node, and `winding`.
   * The fuse, when there is one, takes one thermal step from this current.
   */
  solve(): void {
    if (this.shared) {
      this.solveShared();
      return;
    }
    let drop = false;
    for (const fuse of this.fuse) if (fuse.pull()) drop = true;
    for (const channel of this.channels) if (channel.apply()) drop = true;
    if (drop) this.engine.dropFactor();
    const frozen = this.engine.frozenSteps;
    let min = Number.POSITIVE_INFINITY;
    this.resetMarginMin = Number.POSITIVE_INFINITY;
    if (!this.ready) {
      this.engine.operatingPoint();
      this.ready = true;
      min = this.engine.voltage(this.boardNode);
      this.noteNano();
    } else {
      const n = this.substeps;
      for (let k = 0; k < n; k++) {
        this.engine.stepFast();
        const v = this.engine.voltage(this.boardNode);
        if (v < min) min = v;
        this.noteNano();
      }
    }
    this.lastFrozen = this.engine.frozenSteps - frozen;
    this.voltage = this.engine.voltage(this.termNode);
    this.boardVoltage = this.engine.voltage(this.boardNode);
    this.boardMinVoltage = min;
    this.current = -this.engine.branchCurrent("src");
    const motors = this.motors;
    const winding = this.winding;
    for (let i = 0; i < motors.length; i++) {
      const motor = motors[i]!;
      winding[i] = motor.connected ? this.engine.branchCurrent(motor.id) : 0;
    }
    const voltage = (node: string) => this.engine.voltage(node);
    for (const fuse of this.fuse) fuse.advance(fuse.current(voltage), MASTER_S);
    for (const channel of this.channels) channel.latch(voltage);
  }

  /** Several boards, one source. Each board keeps its own node and load. */
  private solveShared(): void {
    let drop = false;
    for (const fuse of this.fuse) if (fuse.pull()) drop = true;
    for (const channel of this.channels) if (channel.apply()) drop = true;
    if (drop) this.engine.dropFactor();
    const frozen = this.engine.frozenSteps;
    const mins = new Map<string, number>();
    for (const id of this.boardOrder) mins.set(id, Number.POSITIVE_INFINITY);
    this.resetMarginMin = Number.POSITIVE_INFINITY;
    const note = () => {
      for (const id of this.boardOrder) {
        const node = this.boardNodes.get(id);
        if (!node) continue;
        const v = this.engine.voltage(node);
        const soFar = mins.get(id) ?? v;
        if (v < soFar) mins.set(id, v);
      }
      this.noteShared();
    };
    if (!this.ready) {
      // Two capacitive boards on one rail do not converge from 0 V.
      // The same circuit from the supply voltage does. One board does
      // not take this path.
      this.engine.seedNodes(this.seedVolts);
      this.engine.operatingPoint();
      this.ready = true;
      note();
    } else {
      const n = this.substeps;
      for (let k = 0; k < n; k++) {
        this.engine.stepFast();
        note();
      }
    }
    this.lastFrozen = this.engine.frozenSteps - frozen;
    this.voltage = this.engine.voltage(this.termNode);
    this.current = -this.engine.branchCurrent("src");
    const first = this.boardOrder[0];
    const firstNode = first ? this.boardNodes.get(first) : undefined;
    this.boardVoltage = firstNode ? this.engine.voltage(firstNode) : 0;
    this.boardMinVoltage = first ? (mins.get(first) ?? this.boardVoltage) : 0;
    for (const id of this.boardOrder) {
      const node = this.boardNodes.get(id);
      if (!node) continue;
      this.readings.set(id, {
        voltage: this.engine.voltage(node),
        min: mins.get(id) ?? this.engine.voltage(node),
      });
    }
    const motors = this.motors;
    const winding = this.winding;
    for (let i = 0; i < motors.length; i++) {
      const motor = motors[i]!;
      winding[i] = motor.connected ? this.engine.branchCurrent(motor.id) : 0;
    }
    const voltage = (node: string) => this.engine.voltage(node);
    for (const fuse of this.fuse) fuse.advance(fuse.current(voltage), MASTER_S);
    for (const channel of this.channels) channel.latch(voltage);
  }

  private noteShared(): void {
    const leds: Record<string, number> = {};
    for (const led of this.ledDiodes) leds[led.path] = led.diode.amps;
    this.leds = leds;
    this.ledCurrent = this.ledAlias ? (leds[this.ledAlias] ?? 0) : 0;
    for (const [id, reset] of this.boardResets) {
      const boardNode = this.boardNodes.get(id);
      if (!boardNode || reset.fraction === null) continue;
      const board = this.engine.voltage(boardNode);
      const volts = this.engine.voltage(reset.node);
      this.resetVoltage = volts;
      const margin = volts - reset.fraction * board;
      if (margin < this.resetMarginMin) this.resetMarginMin = margin;
    }
  }
}

const TERM = "term";

function mapNodes(
  stamp: BoardStamp,
  map: (node: string) => string
): BoardStamp {
  const node = (name: string) => (name === "0" ? "0" : map(name));
  return {
    ...stamp,
    boardNode: node(stamp.boardNode),
    vbusNode: stamp.vbusNode ? node(stamp.vbusNode) : null,
    resetNode: stamp.resetNode ? node(stamp.resetNode) : null,
    portNodes: Object.fromEntries(
      Object.entries(stamp.portNodes).map(([key, value]) => [key, node(value)])
    ),
    parts: stamp.parts.map((part) => ({
      ...part,
      nodes: Object.fromEntries(
        Object.entries(part.nodes).map(([key, value]) => [key, node(value)])
      ),
    })),
    pins: stamp.pins.map((pin) => ({ ...pin, node: node(pin.node) })),
  };
}

/**
 * One Thevenin for the supply. A usb feed ties every `VBUS` to that
 * terminal. A header feed ties every board node, because the supply
 * lands on each `5V` pin.
 */
function sharedRail(spec: RailCircuitSpec): {
  winding: Float64Array;
  path: boolean;
  substeps: number;
  ledPaths: readonly string[];
  engine: Engine;
  load: CurrentLoad;
  motors: BridgeMotor[];
  termNode: string;
  boardNode: string;
  fuse: PtcFuseElement[];
  channels: PmosChannel[];
  drives: { bit: number; pin: { setMode(mode: PinMode): void } }[];
  ledDiodes: { path: string; diode: Diode }[];
  ledAlias: string;
  resetFraction: number | null;
  resetNode: string | null;
  branchLaws: LawTable[];
  boardOrder: string[];
  boardLoads: Map<string, CurrentLoad>;
  boardNodes: Map<string, string>;
  boardDrives: Map<
    string,
    { bit: number; pin: { setMode(mode: PinMode): void } }[]
  >;
  boardResets: Map<string, { node: string; fraction: number | null }>;
} {
  const boards = [...(spec.boards ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const feeds = new Set(boards.map((board) => board.feed));
  if (feeds.size > 1) {
    throw new Error("one supply mixes a usb feed and a header feed");
  }
  const usb = boards[0]?.feed === "usb";
  const prepared = boards.map((board) => {
    const stamp = usb
      ? mapNodes(board.stamp, (node) =>
          node === board.stamp.vbusNode ? TERM : node
        )
      : board.stamp;
    return { ...board, stamp };
  });
  const headerNode = prepared[0]?.stamp.boardNode ?? "rail";
  const tied = usb
    ? prepared
    : prepared.map((board) => ({
        ...board,
        stamp: mapNodes(board.stamp, (node) =>
          node === board.stamp.boardNode ? headerNode : node
        ),
      }));
  const termNode = usb ? TERM : headerNode;
  const boardNode = tied[0]?.stamp.boardNode ?? headerNode;
  const braking = spec.braking ?? "clip";
  const boardLoads = new Map<string, CurrentLoad>();
  const boardNodes = new Map<string, string>();
  const boardDrives = new Map<
    string,
    { bit: number; pin: { setMode(mode: PinMode): void } }[]
  >();
  const boardResets = new Map<
    string,
    { node: string; fraction: number | null }
  >();
  const ledDiodes: { path: string; diode: Diode }[] = [];
  const drives: { bit: number; pin: { setMode(mode: PinMode): void } }[] = [];
  const stamped: Element[] = [];
  let capacitive = false;
  for (const board of tied) {
    const realized = realize(board.stamp, board.feed, board.pin ?? AVR_PIN, {
      pinId: (port) => `pin.${board.id}.${port}`,
    });
    if (realized.capacitive || board.stamp.netlist) capacitive = true;
    boardNodes.set(board.id, realized.boardNode);
    const load = new CurrentLoad(
      `load.${board.id}`,
      realized.boardNode,
      "0",
      board.stamp.netlist ? BOARD_LOAD_KNEE_V : 0
    );
    boardLoads.set(board.id, load);
    boardDrives.set(board.id, realized.pins);
    drives.push(...realized.pins);
    ledDiodes.push(...realized.leds);
    if (realized.resetNode) {
      boardResets.set(board.id, {
        node: realized.resetNode,
        fraction: board.stamp.resetFraction,
      });
    }
    stamped.push(...realized.elements);
  }
  stamped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let inductive = false;
  const motors: BridgeMotor[] = [];
  for (let i = 0; i < spec.motors.length; i++) {
    const law = spec.motors[i]!;
    const inductance = law.inductance ?? 0;
    if (inductance > 0) inductive = true;
    const node =
      (law.boardId ? boardNodes.get(law.boardId) : undefined) ?? boardNode;
    motors.push(
      new BridgeMotor(`m${i}`, node, law.resistance, inductance, law.k, braking)
    );
  }
  const loads = [...boardLoads.values()];
  const supply = new TheveninLimit(
    "src",
    termNode,
    "0",
    spec.vNom,
    spec.rSeries,
    spec.iLimit
  );
  const substeps = inductive || capacitive ? SUBSTEPS : 1;
  const first = tied[0];
  const engine = new Engine([supply, ...loads, ...motors, ...stamped], {
    method: "be",
    h: MASTER_S / substeps,
    atol: 1e-14,
    rtol: 1e-12,
  });
  return {
    winding: new Float64Array(motors.length),
    path: usb,
    substeps,
    ledPaths: ledDiodes.map((led) => led.path),
    engine,
    load: loads[0] ?? new CurrentLoad("load", boardNode, "0", 0),
    motors,
    termNode,
    boardNode,
    fuse: stamped.filter(
      (el): el is PtcFuseElement => el instanceof PtcFuseElement
    ),
    channels: stamped.filter(
      (el): el is PmosChannel => el instanceof PmosChannel
    ),
    drives,
    ledDiodes,
    ledAlias: first?.stamp.ledAlias ?? "",
    resetFraction: first?.stamp.resetFraction ?? null,
    resetNode: first?.stamp.resetNode ?? null,
    branchLaws: stamped.filter((el): el is LawTable => el instanceof LawTable),
    boardOrder: tied.map((board) => board.id),
    boardLoads,
    boardNodes,
    boardDrives,
    boardResets,
  };
}

export function createRailCircuit(spec: RailCircuitSpec): RailCircuit {
  return new RailCircuit(spec);
}
