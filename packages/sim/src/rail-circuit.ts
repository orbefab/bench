// Ported from layered-sim E2 src/circuit.ts and src/couple.ts @ 8731557.
/**
 * One supply rail solved with the motor stamps.
 * The circuit is built once. A step only changes the fixed load, each
 * bridge ratio, each held speed, and, when the Uno path is on, the fuse
 * resistance after the electrical solve.
 *
 * L = 0 and no capacitor is one backward-Euler step per master step
 * (1 ms unless the run names a finer one).
 * An algebraic board, including a class-1 table with no capacitor, is
 * that one step. A pin edge inside the step is its own piece, still one
 * step when the rail is algebraic. Inductance or capacitance is 10
 * backward-Euler steps with ω and the bridge ratio held. The fuse
 * temperature, and a battery's state of charge, move once per
 * master step, after those steps, not inside them.
 * Implicit damping (E2 scheme (d)) is not applied here. It would stamp
 * ω = 0 and add B(s) on the joint.
 */

import type { PinVolts } from "@sfab-bench/contract";
import {
  AVR_PIN,
  type AvrPinParams,
  BatteryElement,
  type BatteryParams,
  type Braking,
  BridgeDriver,
  BridgeMotor,
  Comparator,
  CurrentLoad,
  DcWinding,
  Diode,
  type Element,
  Engine,
  LawTable,
  LdoRegulator,
  type PinMode,
  PmosChannel,
  PtcFuseElement,
  Resistor,
  TheveninLimit,
  VSource,
} from "@sfab-bench/engine-circuit";

import {
  type AssignedPart,
  type BoardStamp,
  connectParts,
  realize,
} from "./circuit-stamp";
import { BOARD_LOAD_KNEE_V, type RailFeed } from "./power-path";

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
  feed: RailFeed;
  pin?: AvrPinParams;
};

export type RailCircuitSpec = {
  /** Master step in seconds. Default 1 ms. */
  masterS?: number;
  vNom: number;
  rSeries: number;
  iLimit: number;
  motors: readonly RailMotorLaw[];
  /** Default `clip`, matching `solveRail`. */
  braking?: Braking;
  /**
   * `battery@1` source. When set, the rail stamps this instead of
   * `vNom`, `rSeries`, and `iLimit`.
   */
  battery?: BatteryParams;
  /** D13 `avr-pin@1` numbers. Absent uses the datasheet fits. */
  pin?: AvrPinParams;
  /**
   * Circuit parts for this rail, from the plan.
   */
  stamp?: BoardStamp;
  /**
   * Where the supply attaches when `stamp` is set. `usb` uses `VBUS`
   * when the stamp has that node. `header` uses the board 5V node.
   * `vin` uses the VIN node, and the regulator on that node feeds 5V.
   */
  feed?: RailFeed;
  /** `leds` key copied onto `ledCurrent`. From the stamp when omitted. */
  ledAlias?: string;
  /** V_RST / VCC. From the stamp when omitted. */
  resetFraction?: number;
  /**
   * Nodes the feed would leave open, but another supply on this island
   * drives. A VIN feed keeps `VBUS` when USB is also wired.
   */
  keep?: readonly string[];
  /**
   * The supply stamped as `src`, when this island has several. Absent
   * means the only source, and `sourceCurrent` is that source for any id.
   */
  primaryId?: string;
  /**
   * The board instance `stamp` belongs to. It owns the pins and its own
   * draw on the board load. `boards` entries name theirs by `id`.
   */
  owner?: string;
  /**
   * `ideal-voltage@1`. The rail stamps a voltage source on the feed
   * terminal. A Thevenin limit is the supply when this is absent.
   */
  ideal?: boolean;
  /**
   * Further supplies on this island. Each is a Thevenin or a battery on
   * `node`. The primary stays `src` on the feed terminal.
   */
  also?: readonly {
    id: string;
    vNom: number;
    rSeries: number;
    iLimit: number;
    battery?: BatteryParams;
    ideal?: boolean;
    node: string;
  }[];
  /**
   * Node `src` sits on when several supplies share the island. The
   * positive pin's net names it. Absent uses the first board's feed.
   */
  primaryNode?: string;
  /**
   * Every board on this rail. One board uses the same element ids and
   * node names as a stamp. A path prefix is added only when N > 1.
   */
  boards?: readonly SharedBoard[];
  /**
   * Parts whose non-ground nets touch more than one of `boards`.
   * Stamped once, on this rail's node names.
   */
  spans?: readonly AssignedPart[];
};

const MASTER_S = 0.001;
const SUBSTEPS = 10;

/** One board's node after a solve. */
export type BoardReading = {
  voltage: number;
  /** Lowest board-node volts over the step's sub-steps. */
  min: number;
  /**
   * Lowest `V_reset − resetFraction·V_board` over the step. Negative means
   * RESET went below the chip's V_RST. Null when the board has no reset
   * node on this rail or no reset fraction.
   */
  resetMargin: number | null;
};

/**
 * A board's brownout inside one solve. At the first sub-step its node is
 * under `assertV`, the chip resets, so the motors it drives (`motors`,
 * indexes into the rail's motor list) open for the rest of the step.
 */
export type MotorTrip = {
  boardId: string;
  assertV: number;
  motors: readonly number[];
  /** Bridge drivers (element ids) whose pulse comes from that board. */
  drivers?: readonly string[];
};

/** One slice of a master step, between pin edges. */
type RailPiece = {
  dt: number;
  drive: readonly { bit: number; mode: PinMode; boardId?: string }[];
};

/** A stamped GPIO element: the drive the firmware sets and its node. */
type DrivePin = { setMode(mode: PinMode): void; readonly pinNode: string };

export class RailCircuit {
  /**
   * Winding current each motor charged to the last master step: its end
   * current, or for a tripped motor its current at the trip times
   * `onShare`, which is the step mean when the rest of the step is open.
   */
  readonly winding: Float64Array;
  /** Share of the last master step before a trip opened the motor; 1 with no trip. */
  readonly onShare: Float64Array;
  /** True when the Uno cable sits between the terminal and the board node. */
  readonly path: boolean;
  /** Supply terminal. With no path this is the rail, and the only node. */
  voltage = 0;
  current = 0;
  /** Board node at the end of the step. Equal to `voltage` when there is no path. */
  boardVoltage = 0;
  /** Lowest board-node voltage across the sub-steps. The end voltage on the first solve. */
  boardMinVoltage = 0;
  /** Electrical steps inside one master step. */
  readonly substeps: number;
  /** Master step in seconds. */
  readonly masterS: number;
  /**
   * Pin-edge pieces inside the last master step. 0 when every stamped
   * pin was held for the whole master step.
   */
  lastPieceCount = 0;
  /** Frozen-factor steps during the last master step. */
  lastFrozen = 0;
  /**
   * Amperes through `ledAlias` at the last circuit step. 0 when that LED
   * is not on this rail. The recording reads the frame mean instead.
   */
  ledCurrent = 0;
  /**
   * Forward current of every LED at the last circuit step, keyed by
   * instance path. The recording stores the frame mean from `takeLedFrame`.
   */
  leds: Record<string, number> = {};
  readonly ledPaths: readonly string[];
  /** Pin indexes that have a pin element on this rail. */
  get driveBits(): readonly number[] {
    return this.drives.map((row) => row.bit);
  }
  /**
   * Lowest `V_reset − resetFraction·V_board` over this step's sub-steps,
   * when one board is on the rail. Read it through `boardReading()`.
   */
  private resetMarginMin = 0;
  private readonly engine: Engine;
  private readonly load: CurrentLoad;
  private readonly motors: BridgeMotor[];
  private readonly termNode: string;
  private readonly boardNode: string;
  private readonly fuse: PtcFuseElement[];
  private readonly channels: PmosChannel[];
  private readonly comparators: Comparator[];
  private readonly ldos: LdoRegulator[];
  private readonly drives: {
    bit: number;
    port: string;
    pin: DrivePin;
  }[];
  private readonly ledDiodes: { path: string; diode: Diode }[];
  private readonly ledAlias: string;
  /** Seconds accumulated toward the current recording frame. */
  private ledSpan = 0;
  /** Time-weighted mean of each LED since the last `takeLedFrame`. */
  private ledMean: Record<string, number> = {};
  /** Seconds folded into `pinFrame` since the last `takePinFrame`. */
  private pinSpan = 0;
  /** Each stamped pin node since the last take: mean, lowest, highest. */
  private pinFrame = new Map<string, PinVolts>();
  /**
   * Last completed frame. The card shows this so a pulse that ended
   * before the sample is not reported as 0 A.
   */
  private ledCard: { leds: Record<string, number>; ledCurrent: number } | null =
    null;
  private readonly resetFraction: number | null;
  private readonly resetNode: string | null;
  /** Board port → circuit node. Empty when this rail has no stamp. */
  private readonly portNodes: Readonly<Record<string, string>>;
  private readonly boardPorts = new Map<
    string,
    Readonly<Record<string, string>>
  >();
  /** Plain-branch tables stamped with the board. The supply is `src`. */
  private readonly branchLaws: LawTable[];
  private ready = false;
  /** Set when this rail's source is `battery@1`. The same instance the engine stamps. */
  private battery: BatteryElement | null = null;
  /** Supply id of `src` when `also` is set. Null on a one-supply rail. */
  private primarySupply: string | null = null;
  private readonly extraNodes = new Map<string, string>();
  private diodes: Diode[] = [];
  /** Shared rails start the operating point here. One board leaves this at 0. */
  private readonly boardLoads = new Map<string, CurrentLoad>();
  private readonly boardNodes = new Map<string, string>();
  private readonly boardDrives = new Map<
    string,
    { bit: number; port: string; pin: DrivePin }[]
  >();
  private readonly readings = new Map<string, BoardReading>();
  /** Lowest reset margin of each board this step, when it has a reset node. */
  private readonly resetMins = new Map<string, number>();
  private readonly boardOrder: string[] = [];
  /** Lowest `src` terminal volts over the last solve's sub-steps. */
  private termMin = 0;
  /** Highest `src` current over the last solve's sub-steps. */
  private termMax = 0;
  /** Lowest volts and highest amperes of each `also` source over the last solve. */
  private readonly extraMins = new Map<string, number>();
  private readonly extraMaxes = new Map<string, number>();
  /** Trips armed for the next solve. `solve` clears them. */
  private trips: readonly MotorTrip[] = [];
  private readonly boardResets = new Map<
    string,
    { node: string; fraction: number | null }
  >();

  constructor(spec: RailCircuitSpec) {
    const built = assembleRail(spec);
    this.winding = built.winding;
    this.onShare = new Float64Array(built.winding.length).fill(1);
    this.path = built.path;
    this.substeps = built.substeps;
    this.masterS = spec.masterS ?? MASTER_S;
    this.ledPaths = built.ledPaths;
    this.engine = built.engine;
    this.load = built.load;
    this.motors = built.motors;
    this.termNode = built.termNode;
    this.boardNode = built.boardNode;
    this.fuse = built.fuse;
    this.channels = built.channels;
    this.comparators = built.comparators;
    this.ldos = built.ldos;
    this.drives = built.drives;
    this.ledDiodes = built.ledDiodes;
    this.ledAlias = built.ledAlias;
    this.resetFraction = built.resetFraction;
    // A RESET net with no element on this rail (a class-1 shared rail
    // stamps no pins, so another board's pin is not here) has no voltage.
    // Its margin stays null rather than read as a low pin.
    const solved = (node: string) =>
      node === "0" || built.engine.nodeNames.includes(node);
    this.resetNode =
      built.resetNode && solved(built.resetNode) ? built.resetNode : null;
    this.branchLaws = built.branchLaws;
    this.battery = built.battery;
    this.diodes = built.diodes;
    this.primarySupply = built.primarySupply;
    this.portNodes = built.portNodes;
    this.boardOrder.push(...built.boardOrder);
    for (const [id, load] of built.boardLoads) this.boardLoads.set(id, load);
    for (const [id, node] of built.boardNodes) this.boardNodes.set(id, node);
    for (const [id, rows] of built.boardDrives) this.boardDrives.set(id, rows);
    for (const [id, reset] of built.boardResets)
      if (solved(reset.node)) this.boardResets.set(id, reset);
    for (const [id, ports] of built.boardPorts) this.boardPorts.set(id, ports);
    for (const [id, node] of built.extraNodes) this.extraNodes.set(id, node);
    this.pruned = built.pruned;
    for (const [id, owner] of built.owners) this.owners.set(id, owner);
    for (const [owner, load] of built.ownedLoads) {
      this.ownedLoads.set(load.id, { owner, load, own: 0 });
    }
    for (const [id, nodes] of built.partNodes) this.partNodes.set(id, nodes);
    for (const [full, node] of built.stampedPorts)
      this.stampedPorts.set(full, node);
    for (const el of built.engine.elements) {
      if (el instanceof BridgeDriver) this.drivers.push(el);
      if (el instanceof DcWinding) this.windings.push(el);
    }
  }

  /** Scene parts this rail dropped because a node was open. */
  readonly pruned: readonly string[] = [];
  /**
   * Element id → the instance path that owns it: a stamped part's
   * elements, a board's pins. Readings at an instance's ports sum what it
   * owns; an element id is never parsed for its owner.
   */
  private readonly owners = new Map<string, string>();
  /**
   * A board load is one aggregate element: the board's own draw plus the
   * quiescent draw of parts and rangers it carries. Its owner is credited
   * with `own / amps` of it; the rest is attributed to no instance.
   */
  private readonly ownedLoads = new Map<
    string,
    { owner: string; load: CurrentLoad; own: number }
  >();
  private readonly partNodes = new Map<string, readonly string[]>();
  private readonly stampedPorts = new Map<string, string>();
  private readonly drivers: BridgeDriver[] = [];
  private readonly windings: DcWinding[] = [];
  /** Each winding's charge over the solve in progress, coulombs. */
  private charge = new Float64Array(0);
  /** Mean current of each winding over the last solve, by element id. */
  private readonly charged = new Map<string, number>();

  /** A stamped element by id. Null when this rail does not have it. */
  element(id: string): Element | null {
    return this.engine.elements.find((item) => item.id === id) ?? null;
  }

  /**
   * Amperes a `dc-motor@1` winding carried over the last master step, the
   * time mean of its sub-steps. A bridge opened mid-step by a trip
   * carries the share before it. Null when the winding is not here.
   */
  windingCurrent(id: string): number | null {
    return this.charged.get(id) ?? null;
  }

  elementCurrent(id: string): number | null {
    const el = this.engine.elements.find((item) => item.id === id);
    if (!el) return null;
    if (el.branches().includes(id)) return this.engine.branchCurrent(id);
    if (el instanceof Resistor) {
      return (
        (this.engine.voltage(el.aName) - this.engine.voltage(el.bName)) / el.R
      );
    }
    return null;
  }

  nodeVoltage(name: string): number {
    if (name === "0") return 0;
    return this.engine.voltage(name);
  }

  elementNodes(id: string): readonly string[] | null {
    return this.partNodes.get(id) ?? null;
  }

  /** The node a stamped part's `path.port` sits on. Null when not here. */
  stampedNode(full: string): string | null {
    return this.stampedPorts.get(full) ?? null;
  }

  /**
   * The stamped elements owned by the instance at `path` and everything
   * under it. A board load is not one of them: see `currentInto`.
   */
  elementsUnder(path: string): Element[] {
    return this.engine.elements.filter((el) =>
      isUnder(this.owners.get(el.id), path)
    );
  }

  /** True when this rail holds anything the instance at `path` owns. */
  owns(path: string): boolean {
    if (this.elementsUnder(path).length > 0) return true;
    for (const row of this.ownedLoads.values()) {
      if (isUnder(row.owner, path)) return true;
    }
    return false;
  }

  /**
   * Amperes the instance at `path` (and everything under it) drew out of
   * `node` at the end of the last solve: its elements, plus its own share
   * of a board load on that node.
   */
  currentInto(path: string, node: string): number {
    let amps = this.engine.currentLeaving(this.elementsUnder(path), node);
    for (const row of this.ownedLoads.values()) {
      if (!isUnder(row.owner, path) || !(row.load.amps > 0)) continue;
      const share = Math.min(1, row.own / row.load.amps);
      amps += this.engine.currentLeaving([row.load], node) * share;
    }
    return amps;
  }

  /** Amperes `elements` drew out of `node` at the end of the last solve. */
  currentLeaving(elements: readonly Element[], node: string): number {
    return this.engine.currentLeaving(elements, node);
  }

  /**
   * The rail's aggregate load. `draws` is each board's own draw, by board
   * id: the board that owns this load is credited with its entry, and the
   * rest of `amps` (other parts' quiescent draw) with no instance.
   */
  setFixed(amps: number, draws?: ReadonlyMap<string, number>): void {
    if (this.boardOrder.length > 1) {
      const first = this.boardOrder[0];
      const load = first ? this.boardLoads.get(first) : undefined;
      if (load) this.setLoad(load, amps, draws);
      return;
    }
    this.setLoad(this.load, amps, draws);
  }

  private setLoad(
    load: CurrentLoad,
    amps: number,
    draws?: ReadonlyMap<string, number>
  ): void {
    load.amps = amps;
    const row = this.ownedLoads.get(load.id);
    if (row) row.own = draws?.get(row.owner) ?? 0;
  }

  /** Boards on this rail. Empty when one board keeps the unprefixed names. */
  get boardIds(): readonly string[] {
    return this.boardOrder;
  }

  /**
   * Current out of one supply on this island. A one-supply rail returns
   * the `src` current for every id.
   */
  sourceCurrent(id: string): number {
    if (this.primarySupply !== null && id !== this.primarySupply) {
      return -this.engine.branchCurrent(id);
    }
    return this.current;
  }

  /** Lowest terminal volts of one supply over the last solve's sub-steps. */
  sourceMin(id: string): number {
    if (this.primarySupply !== null && id !== this.primarySupply) {
      const min = this.extraMins.get(id);
      if (min !== undefined) return min;
    }
    return this.termMin;
  }

  /** Highest current out of one supply over the last solve's sub-steps. */
  sourceMax(id: string): number {
    if (this.primarySupply !== null && id !== this.primarySupply) {
      const max = this.extraMaxes.get(id);
      if (max !== undefined) return max;
    }
    return this.termMax;
  }

  /** Terminal voltage of one supply. A one-supply rail returns `voltage`. */
  sourceVoltage(id: string): number {
    if (this.primarySupply !== null && id !== this.primarySupply) {
      const node = this.extraNodes.get(id);
      if (node) return this.engine.voltage(node);
    }
    return this.voltage;
  }

  /** Forward current of a stamped diode, by id or by an id suffix. */
  diodeCurrent(suffix: string): number | null {
    const found = this.diodes.find(
      (diode) => diode.id === suffix || diode.id.endsWith(suffix)
    );
    return found ? found.amps : null;
  }

  /** The P-channel switch, when this rail stamped one. */
  pmosOn(): boolean | null {
    const channel = this.channels[0];
    return channel ? channel.on : null;
  }

  /** True when `id` is the supply whose state of charge this rail tracks. */
  batteryOf(id: string): boolean {
    if (!this.battery) return false;
    return this.primarySupply === null || id === this.primarySupply;
  }

  /** State of charge after this step. Absent when the source is not a battery. */
  get soc(): number | undefined {
    return this.battery ? this.battery.soc : undefined;
  }

  /** State of charge the source stamped for this step. */
  get stampedSoc(): number | undefined {
    return this.battery ? this.battery.stampedSoc : undefined;
  }

  batteryWarning(): string | null {
    return this.battery?.warning ?? null;
  }

  batteryWarnings(): number {
    return this.battery?.warnCount ?? 0;
  }

  /**
   * One board's knee load, when several boards share this rail. `draws`
   * as in `setFixed`.
   */
  setBoardLoad(
    id: string,
    amps: number,
    draws?: ReadonlyMap<string, number>
  ): void {
    const load = this.boardLoads.get(id);
    if (!load) throw new Error(`no board ${id}`);
    this.setLoad(load, amps, draws);
  }

  /** One board's pins. A one-board rail answers for any id with its own. */
  private pinsOf(id: string) {
    return this.boardOrder.length === 0
      ? this.drives
      : (this.boardDrives.get(id) ?? []);
  }

  driveBitsOf(id: string): readonly number[] {
    return this.pinsOf(id).map((row) => row.bit);
  }

  /** Solved voltage of each stamped pin of board `id`, after the last solve. */
  pinVolts(
    id: string
  ): { bit: number; port: string; node: string; volts: number }[] {
    return this.pinsOf(id).map((row) => ({
      bit: row.bit,
      port: row.port,
      node: row.pin.pinNode,
      volts: this.engine.voltage(row.pin.pinNode),
    }));
  }

  setBoardDrive(id: string, bit: number, mode: PinMode): void {
    this.pinsOf(id)
      .find((row) => row.bit === bit)
      ?.pin.setMode(mode);
  }

  /**
   * This board's node. One board on the rail is `boardVoltage` /
   * `boardMinVoltage` / `resetMarginMin`.
   */
  boardReading(id: string): BoardReading {
    return (
      this.readings.get(id) ?? {
        voltage: this.boardVoltage,
        min: this.boardMinVoltage,
        resetMargin:
          this.resetNode && this.resetFraction !== null
            ? this.resetMarginMin
            : null,
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

  /**
   * Trips for the next solve only. Set after `setMotor`: a trip opens a
   * motor that `setMotor` connected.
   */
  armTrips(trips: readonly MotorTrip[]): void {
    this.trips = trips;
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

  /**
   * Pass current of the regulator whose OUT is this board's 5V node.
   * Zero when that node is not a regulator output.
   */
  regulatorOut(boardId?: string): number {
    const node =
      (boardId ? this.boardNodes.get(boardId) : undefined) ?? this.boardNode;
    let sum = 0;
    for (const ldo of this.ldos) {
      if (ldo.outName !== node) continue;
      sum += this.engine.branchCurrent(ldo.id);
    }
    return sum;
  }

  /**
   * Solved voltage of a board port that is a node of this rail.
   * Null when the port is not in the stamp or the node was pruned.
   * `rSource` is that node's Thevenin resistance from the factored
   * Jacobian. It is 0 when the factor is gone.
   */
  probePort(
    port: string,
    boardId?: string
  ): { voltage: number; rSource: number } | null {
    const ports =
      (boardId ? this.boardPorts.get(boardId) : undefined) ?? this.portNodes;
    const node = ports[port];
    if (!node) return null;
    if (node !== "0" && !this.engine.nodeNames.includes(node)) return null;
    const voltage = node === "0" ? 0 : this.engine.voltage(node);
    const r = this.engine.thevenin(node);
    return { voltage, rSource: r ?? 0 };
  }

  /** The stamped pin named `port`. Same as `setDrive` for that pin's index. */
  setPin(port: string, mode: PinMode): void {
    const found = this.drives.find((row) => row.port === port);
    found?.pin.setMode(mode);
  }

  /**
   * Time-weighted mean of each LED since the previous take, then a new
   * frame. Weight is the circuit step length, so a 0.1 ms sub-step and a
   * 1 ms master step both count for the time they covered. With no timed
   * step yet, this is the last sample. `end` is that last sample, the
   * value a frame-end recording would have kept.
   */
  takeLedFrame(): {
    leds: Record<string, number>;
    ledCurrent: number;
    end: Record<string, number>;
  } {
    const end = { ...this.leds };
    const leds: Record<string, number> = {};
    if (this.ledSpan === 0) {
      for (const led of this.ledDiodes) leds[led.path] = end[led.path] ?? 0;
    } else {
      for (const led of this.ledDiodes) {
        leds[led.path] = this.ledMean[led.path] ?? 0;
      }
    }
    const ledCurrent = this.ledAlias ? (leds[this.ledAlias] ?? 0) : 0;
    this.ledCard = { leds, ledCurrent };
    this.ledSpan = 0;
    this.ledMean = {};
    return { leds, ledCurrent, end };
  }

  /**
   * LED currents for the live card: the last completed frame's mean, or
   * the last circuit step before the first frame.
   */
  ledCardReading(): { leds: Record<string, number>; ledCurrent: number } {
    if (this.ledCard) return this.ledCard;
    return { leds: this.leds, ledCurrent: this.ledCurrent };
  }

  /**
   * Fold one circuit step into the frame mean. `dt` is that step's length.
   * A steady current stays bit-identical: the update is zero when the
   * sample equals the mean. The operating point passes `dt` 0 and does
   * not enter the mean.
   */
  private noteBoard(dt: number): void {
    this.foldLeds(dt);
    this.foldPins(dt);
    if (!this.resetNode) return;
    const board = this.engine.voltage(this.boardNode);
    const reset = this.engine.voltage(this.resetNode);
    if (this.resetFraction === null) return;
    const margin = reset - this.resetFraction * board;
    if (margin < this.resetMarginMin) this.resetMarginMin = margin;
  }

  /**
   * One step's stamped pin nodes, folded into the frame by `dt`. Edges end
   * a piece, so the step ends include each edge: a square wave's extremes.
   */
  private foldPins(dt: number): void {
    if (!(dt > 0) || this.drives.length === 0) return;
    const span = this.pinSpan;
    const next = span + dt;
    const folded = new Set<string>();
    for (const row of this.drives) {
      const node = row.pin.pinNode;
      // Two pins on one net share a node: fold it once per step.
      if (folded.has(node)) continue;
      folded.add(node);
      const v = this.engine.voltage(node);
      const seen = span === 0 ? undefined : this.pinFrame.get(node);
      if (!seen) {
        this.pinFrame.set(node, { v, lo: v, hi: v });
        continue;
      }
      seen.v += (v - seen.v) * (dt / next);
      if (v < seen.lo) seen.lo = v;
      if (v > seen.hi) seen.hi = v;
    }
    this.pinSpan = next;
  }

  /**
   * The rail's stamped pin nodes over the frame since the previous take,
   * keyed by node. With no timed step yet, each is the node now. Call once
   * per frame for the whole rail: it starts the next frame.
   */
  takePinFrame(): Map<string, PinVolts> {
    const out = new Map<string, PinVolts>();
    for (const row of this.drives) {
      const node = row.pin.pinNode;
      const seen = this.pinSpan > 0 ? this.pinFrame.get(node) : undefined;
      if (seen) {
        out.set(node, { ...seen });
        continue;
      }
      const v = this.engine.voltage(node);
      out.set(node, { v, lo: v, hi: v });
    }
    this.pinSpan = 0;
    this.pinFrame = new Map();
    return out;
  }

  /** One step's LED currents, folded into the frame mean by `dt`. */
  private foldLeds(dt: number): void {
    const leds: Record<string, number> = {};
    const span = this.ledSpan;
    const next = dt > 0 ? span + dt : span;
    for (const led of this.ledDiodes) {
      const amps = led.diode.amps;
      leds[led.path] = amps;
      if (!(dt > 0)) continue;
      const prev = this.ledMean[led.path] ?? 0;
      this.ledMean[led.path] =
        span === 0 ? amps : prev + (amps - prev) * (dt / next);
    }
    if (dt > 0) this.ledSpan = next;
    this.leds = leds;
    this.ledCurrent = this.ledAlias ? (leds[this.ledAlias] ?? 0) : 0;
  }

  /**
   * Solve the rail. Writes the terminal, the board node, and `winding`.
   * The fuse, when there is one, takes one thermal step from this current.
   * `pieces`, when a stamped pin changed inside this master step, are the
   * intervals between those edges. Their durations sum to one master step.
   * With no pieces the pin is held and the grid is the one used before.
   */
  solve(pieces?: readonly RailPiece[]): void {
    let drop = false;
    for (const fuse of this.fuse) if (fuse.pull()) drop = true;
    for (const cmp of this.comparators) if (cmp.apply()) drop = true;
    for (const channel of this.channels) if (channel.apply()) drop = true;
    if (this.battery?.pull()) drop = true;
    if (drop) this.engine.dropFactor();
    const frozen = this.engine.frozenSteps;
    const many = this.boardOrder.length > 1;
    const mins = new Map<string, number>();
    let min = Number.POSITIVE_INFINITY;
    if (many) {
      for (const id of this.boardOrder) mins.set(id, Number.POSITIVE_INFINITY);
    }
    this.resetMarginMin = Number.POSITIVE_INFINITY;
    this.resetMins.clear();
    const motors = this.motors;
    const winding = this.winding;
    const onShare = this.onShare;
    onShare.fill(1);
    const pending = this.trips.filter(
      (trip) => trip.motors.length > 0 || (trip.drivers?.length ?? 0) > 0
    );
    this.trips = [];
    const opened: number[] = [];
    let elapsed = 0;
    const windings = this.windings;
    if (this.charge.length !== windings.length) {
      this.charge = new Float64Array(windings.length);
    }
    const charge = this.charge;
    charge.fill(0);
    // Before the step is noted: a trip at this sub-step keeps the current
    // the motor ran on, and opens it for the sub-steps after.
    const trip = (dt: number) => {
      elapsed += dt;
      if (!(dt > 0) || pending.length === 0) return;
      for (let j = pending.length - 1; j >= 0; j--) {
        const armed = pending[j]!;
        const node = this.boardNodes.get(armed.boardId) ?? this.boardNode;
        if (!(this.engine.voltage(node) < armed.assertV)) continue;
        pending.splice(j, 1);
        for (const index of armed.motors) {
          const motor = motors[index];
          if (!motor?.connected) continue;
          winding[index] = this.engine.branchCurrent(motor.id);
          onShare[index] = Math.min(1, elapsed / this.masterS);
          motor.connected = false;
          opened.push(index);
        }
        for (const id of armed.drivers ?? []) {
          const driver = this.drivers.find((item) => item.id === id);
          if (driver) driver.connected = false;
        }
      }
    };
    this.termMin = Number.POSITIVE_INFINITY;
    this.termMax = Number.NEGATIVE_INFINITY;
    this.extraMins.clear();
    this.extraMaxes.clear();
    const noteSources = () => {
      const v = this.engine.voltage(this.termNode);
      if (v < this.termMin) this.termMin = v;
      const amps = -this.engine.branchCurrent("src");
      if (amps > this.termMax) this.termMax = amps;
      for (const [id, node] of this.extraNodes) {
        const volts = this.engine.voltage(node);
        const low = this.extraMins.get(id);
        if (low === undefined || volts < low) this.extraMins.set(id, volts);
        const out = -this.engine.branchCurrent(id);
        const high = this.extraMaxes.get(id);
        if (high === undefined || out > high) this.extraMaxes.set(id, out);
      }
    };
    const note = (dt: number) => {
      for (let i = 0; i < windings.length; i++) {
        charge[i] =
          (charge[i] as number) +
          this.engine.branchCurrent((windings[i] as DcWinding).id) * dt;
      }
      trip(dt);
      noteSources();
      if (!many) {
        const v = this.engine.voltage(this.boardNode);
        if (v < min) min = v;
        this.noteBoard(dt);
        return;
      }
      for (const id of this.boardOrder) {
        const node = this.boardNodes.get(id);
        if (!node) continue;
        const v = this.engine.voltage(node);
        const soFar = mins.get(id) ?? v;
        if (v < soFar) mins.set(id, v);
      }
      this.noteShared(dt);
    };
    if (!this.ready) {
      this.engine.operatingPoint();
      this.ready = true;
      note(0);
    } else if (pieces && pieces.length > 0) {
      this.runPieces(pieces, note);
    } else {
      const n = this.substeps;
      const dt = this.engine.h;
      for (let k = 0; k < n; k++) {
        this.engine.stepFast();
        note(dt);
      }
    }
    this.lastFrozen = this.engine.frozenSteps - frozen;
    this.lastPieceCount = pieces?.length ?? 0;
    this.voltage = this.engine.voltage(this.termNode);
    this.current = -this.engine.branchCurrent("src");
    if (many) {
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
          resetMargin: this.resetMins.get(id) ?? null,
        });
      }
    } else {
      this.boardVoltage = this.engine.voltage(this.boardNode);
      this.boardMinVoltage = min;
    }
    for (let i = 0; i < motors.length; i++) {
      const motor = motors[i]!;
      if (opened.includes(i)) {
        winding[i] = (winding[i] as number) * (onShare[i] as number);
        continue;
      }
      winding[i] = motor.connected ? this.engine.branchCurrent(motor.id) : 0;
    }
    const voltage = (node: string) => this.engine.voltage(node);
    for (const fuse of this.fuse)
      fuse.advance(fuse.current(voltage), this.masterS);
    for (const channel of this.channels) channel.latch(voltage);
    for (const cmp of this.comparators) cmp.latch(voltage);
    for (const driver of this.drivers) driver.latch(voltage);
    for (let i = 0; i < windings.length; i++) {
      const id = (windings[i] as DcWinding).id;
      this.charged.set(
        id,
        elapsed > 0
          ? (charge[i] as number) / elapsed
          : this.engine.branchCurrent(id)
      );
    }
    this.battery?.advance(this.current, this.masterS);
  }

  private noteShared(dt: number): void {
    this.foldLeds(dt);
    this.foldPins(dt);
    for (const [id, reset] of this.boardResets) {
      const boardNode = this.boardNodes.get(id);
      if (!boardNode || reset.fraction === null) continue;
      const board = this.engine.voltage(boardNode);
      const volts = this.engine.voltage(reset.node);
      const margin = volts - reset.fraction * board;
      const soFar = this.resetMins.get(id);
      if (soFar === undefined || margin < soFar) this.resetMins.set(id, margin);
    }
  }

  /** Pin edges inside one master step. Each chunk is at most one grid step. */
  private runPieces(
    pieces: readonly RailPiece[],
    note: (dt: number) => void
  ): void {
    const h = this.engine.h;
    for (const piece of pieces) {
      for (const drive of piece.drive) {
        if (drive.boardId)
          this.setBoardDrive(drive.boardId, drive.bit, drive.mode);
        else this.setDrive(drive.bit, drive.mode);
      }
      let left = piece.dt;
      while (left > h * (1 + 1e-9)) {
        this.engine.advance(h);
        note(h);
        left -= h;
      }
      if (left > 1e-15) {
        this.engine.advance(left);
        note(left);
      }
    }
    this.engine.parkGrid(this.substeps);
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
    regulatorNode: stamp.regulatorNode ? node(stamp.regulatorNode) : null,
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

type Assembled = {
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
  comparators: Comparator[];
  ldos: LdoRegulator[];
  drives: {
    bit: number;
    port: string;
    pin: DrivePin;
  }[];
  ledDiodes: { path: string; diode: Diode }[];
  ledAlias: string;
  resetFraction: number | null;
  resetNode: string | null;
  branchLaws: LawTable[];
  battery: BatteryElement | null;
  diodes: Diode[];
  primarySupply: string | null;
  portNodes: Readonly<Record<string, string>>;
  boardOrder: string[];
  boardLoads: Map<string, CurrentLoad>;
  boardNodes: Map<string, string>;
  boardDrives: Map<string, { bit: number; port: string; pin: DrivePin }[]>;
  boardResets: Map<string, { node: string; fraction: number | null }>;
  boardPorts: Map<string, Readonly<Record<string, string>>>;
  extraNodes: Map<string, string>;
  pruned: string[];
  partNodes: Map<string, readonly string[]>;
  /** A stamped part's `path.port` → node, on a board or a span. */
  stampedPorts: Map<string, string>;
  /** Element id → owning instance path. */
  owners: Map<string, string>;
  /** Board instance path → its board load element. */
  ownedLoads: Map<string, CurrentLoad>;
};

/** `owner` is the instance at `path` or one under it. */
function isUnder(owner: string | undefined, path: string): boolean {
  return (
    owner !== undefined && (owner === path || owner.startsWith(`${path}.`))
  );
}

function supplyElement(
  id: string,
  node: string,
  row: {
    vNom: number;
    rSeries: number;
    iLimit: number;
    battery?: BatteryParams;
    ideal?: boolean;
  }
): Element {
  if (row.battery) return new BatteryElement(id, node, "0", row.battery);
  if (row.ideal) {
    return new VSource(id, node, "0", { kind: "dc", value: row.vNom });
  }
  return new TheveninLimit(id, node, "0", row.vNom, row.rSeries, row.iLimit);
}

/**
 * One rail for N boards and M supplies. Pin and load ids gain the board
 * path only when N > 1, so one board keeps the stamp's element ids and
 * node names. Several boards on one supply tie the feed the way they
 * always have. Several supplies each sit on the node their positive
 * pin reaches.
 */
function assembleRail(spec: RailCircuitSpec): Assembled {
  const fromBoards = spec.boards ?? [];
  const listed: SharedBoard[] =
    fromBoards.length > 0
      ? [...fromBoards]
      : spec.stamp &&
          (spec.feed === "usb" || spec.feed === "header" || spec.feed === "vin")
        ? [{ id: "", stamp: spec.stamp, feed: spec.feed, pin: spec.pin }]
        : [];
  if (
    spec.stamp &&
    listed.length === 0 &&
    spec.feed !== "usb" &&
    spec.feed !== "header" &&
    spec.feed !== "vin"
  ) {
    throw new Error("a board stamp needs feed usb, header, or vin");
  }
  const many = listed.length > 1;
  const multiSupply = (spec.also?.length ?? 0) > 0;
  const braking = spec.braking ?? "clip";
  let prepared = listed;
  let tiedTerm: string | null = null;
  let tiedBoard: string | null = null;
  const rename = new Map<string, string>();
  const remember = (
    before: string | null | undefined,
    after: string | null | undefined
  ) => {
    if (before && after && before !== after) rename.set(before, after);
  };
  if (many && !multiSupply) {
    const feeds = new Set(listed.map((board) => board.feed));
    if (feeds.size > 1) {
      throw new Error("one supply mixes a usb feed and a header feed");
    }
    const sorted = [...listed].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const usb = sorted[0]?.feed === "usb";
    const vin = sorted[0]?.feed === "vin";
    const mapped = sorted.map((board) => {
      const regulatorNode = board.stamp.regulatorNode;
      const stamp = usb
        ? mapNodes(board.stamp, (node) =>
            node === board.stamp.vbusNode ? TERM : node
          )
        : vin
          ? mapNodes(board.stamp, (node) =>
              node === regulatorNode ? TERM : node
            )
          : board.stamp;
      remember(board.stamp.vbusNode, stamp.vbusNode);
      remember(regulatorNode, stamp.regulatorNode);
      remember(board.stamp.boardNode, stamp.boardNode);
      return { ...board, stamp };
    });
    const headerNode = mapped[0]?.stamp.boardNode ?? "rail";
    prepared =
      usb || vin
        ? mapped
        : mapped.map((board) => {
            const stamp = mapNodes(board.stamp, (node) =>
              node === board.stamp.boardNode ? headerNode : node
            );
            remember(board.stamp.boardNode, stamp.boardNode);
            return { ...board, stamp };
          });
    tiedTerm = usb || vin ? TERM : headerNode;
    tiedBoard = prepared[0]?.stamp.boardNode ?? headerNode;
  } else if (many) {
    prepared = [...listed].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
  }

  const boardLoads = new Map<string, CurrentLoad>();
  const boardNodes = new Map<string, string>();
  const boardDrives = new Map<
    string,
    { bit: number; port: string; pin: DrivePin }[]
  >();
  const boardResets = new Map<
    string,
    { node: string; fraction: number | null }
  >();
  const boardPorts = new Map<string, Readonly<Record<string, string>>>();
  const feedOf = new Map<string, string>();
  const ledDiodes: { path: string; diode: Diode }[] = [];
  const drives: {
    bit: number;
    port: string;
    pin: DrivePin;
  }[] = [];
  const loads: CurrentLoad[] = [];
  let stamped: Element[] = [];
  let capacitive = false;
  let single: ReturnType<typeof realize> | null = null;
  const pruned: string[] = [];
  const partNodes = new Map<string, readonly string[]>();
  const stampedPorts = new Map<string, string>();
  const owners = new Map<string, string>();
  const ownedLoads = new Map<string, CurrentLoad>();
  for (const board of prepared) {
    const owner = board.id || spec.owner || "";
    const realized = realize(
      board.stamp,
      board.feed,
      board.pin ?? spec.pin ?? AVR_PIN,
      {
        ...(owner ? { owner } : {}),
        ...(many ? { pinId: (port: string) => `pin.${board.id}.${port}` } : {}),
        ...(!many && spec.keep && spec.keep.length > 0
          ? { keep: spec.keep }
          : {}),
      }
    );
    if (!many) single = realized;
    if (realized.capacitive) capacitive = true;
    pruned.push(...realized.pruned);
    for (const [full, node] of realized.ports) stampedPorts.set(full, node);
    for (const [id, path] of realized.owners) owners.set(id, path);
    feedOf.set(board.id, realized.feedNode);
    boardNodes.set(board.id, realized.boardNode);
    const netlist = board.stamp.netlist === true;
    const knee = netlist ? BOARD_LOAD_KNEE_V : 0;
    const load = new CurrentLoad(
      many ? `load.${board.id}` : "load",
      realized.boardNode,
      "0",
      knee
    );
    loads.push(load);
    if (owner) ownedLoads.set(owner, load);
    if (many) {
      boardLoads.set(board.id, load);
      boardDrives.set(board.id, realized.pins);
      boardPorts.set(board.id, board.stamp.portNodes);
      if (realized.resetNode) {
        boardResets.set(board.id, {
          node: realized.resetNode,
          fraction: board.stamp.resetFraction,
        });
      }
    }
    drives.push(...realized.pins);
    ledDiodes.push(...realized.leds);
    stamped.push(...realized.elements);
  }
  const anchors = new Set<string>(["0"]);
  for (const board of prepared) {
    const feed = feedOf.get(board.id);
    if (feed) anchors.add(feed);
    const node = boardNodes.get(board.id);
    if (node) anchors.add(node);
    for (const pin of board.stamp.pins) anchors.add(pin.node);
  }
  for (const node of spec.keep ?? []) anchors.add(node);
  const joined = connectParts(
    (spec.spans ?? []).map((part) => ({
      ...part,
      nodes: Object.fromEntries(
        Object.entries(part.nodes).map(([key, value]) => [
          key,
          rename.get(value) ?? value,
        ])
      ),
    })),
    anchors
  );
  pruned.push(...joined.pruned);
  if (joined.capacitive) capacitive = true;
  for (const [id, nodes] of joined.nodes) partNodes.set(id, nodes);
  for (const [full, node] of joined.ports) stampedPorts.set(full, node);
  for (const [id, path] of joined.owners) owners.set(id, path);
  stamped.push(...joined.elements);
  if (many) {
    stamped = [...stamped].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
  }

  const first = prepared[0];
  const boardNode =
    listed.length === 0
      ? "rail"
      : many
        ? (tiedBoard ?? boardNodes.get(first?.id ?? "") ?? "rail")
        : (single?.boardNode ?? "rail");
  const termNode =
    listed.length === 0
      ? "rail"
      : many
        ? multiSupply
          ? (spec.primaryNode ?? feedOf.get(first?.id ?? "") ?? boardNode)
          : (tiedTerm ?? boardNode)
        : (single?.feedNode ?? boardNode);
  let inductive = false;
  const motors: BridgeMotor[] = [];
  for (let i = 0; i < spec.motors.length; i++) {
    const law = spec.motors[i]!;
    const inductance = law.inductance ?? 0;
    if (inductance > 0) inductive = true;
    const node = many
      ? ((law.boardId ? boardNodes.get(law.boardId) : undefined) ?? boardNode)
      : boardNode;
    motors.push(
      new BridgeMotor(`m${i}`, node, law.resistance, inductance, law.k, braking)
    );
  }
  const substeps = inductive || capacitive ? SUBSTEPS : 1;
  const load = loads[0] ?? new CurrentLoad("load", boardNode, "0", 0);
  const battery = spec.battery
    ? new BatteryElement("src", termNode, "0", spec.battery)
    : null;
  const supply =
    battery ??
    supplyElement("src", termNode, {
      vNom: spec.vNom,
      rSeries: spec.rSeries,
      iLimit: spec.iLimit,
      ...(spec.ideal ? { ideal: true } : {}),
    });
  const extraNodes = new Map<string, string>();
  const extras: Element[] = [];
  for (const src of spec.also ?? []) {
    extraNodes.set(src.id, src.node);
    extras.push(supplyElement(src.id, src.node, src));
  }
  const primarySupply =
    (spec.also?.length ?? 0) > 0 && spec.primaryId ? spec.primaryId : null;
  const elements = many
    ? [supply, ...loads, ...motors, ...stamped, ...extras]
    : [supply, load, ...motors, ...stamped, ...extras];
  const engine = new Engine(elements, {
    method: "be",
    h: (spec.masterS ?? MASTER_S) / substeps,
    atol: 1e-14,
    rtol: 1e-12,
  });
  const path = many
    ? first?.feed === "usb"
    : single !== null && first?.stamp.netlist === true;
  return {
    winding: new Float64Array(motors.length),
    path,
    substeps,
    ledPaths: ledDiodes.map((led) => led.path),
    engine,
    load,
    motors,
    termNode,
    boardNode,
    fuse: stamped.filter(
      (el): el is PtcFuseElement => el instanceof PtcFuseElement
    ),
    channels: stamped.filter(
      (el): el is PmosChannel => el instanceof PmosChannel
    ),
    comparators: stamped.filter(
      (el): el is Comparator => el instanceof Comparator
    ),
    ldos: stamped.filter(
      (el): el is LdoRegulator => el instanceof LdoRegulator
    ),
    drives,
    ledDiodes,
    ledAlias: spec.ledAlias ?? first?.stamp.ledAlias ?? "",
    resetFraction: many
      ? (first?.stamp.resetFraction ?? null)
      : (spec.resetFraction ?? first?.stamp.resetFraction ?? null),
    resetNode: many
      ? (first?.stamp.resetNode ?? null)
      : (single?.resetNode ?? null),
    branchLaws: stamped.filter((el): el is LawTable => el instanceof LawTable),
    battery,
    diodes: stamped.filter((el): el is Diode => el instanceof Diode),
    primarySupply,
    portNodes: many
      ? (boardPorts.get(first?.id ?? "") ?? {})
      : (first?.stamp.portNodes ?? {}),
    boardOrder: many ? prepared.map((board) => board.id) : [],
    boardLoads,
    boardNodes: many ? boardNodes : new Map(),
    boardDrives,
    boardResets,
    boardPorts,
    extraNodes,
    pruned,
    partNodes,
    stampedPorts,
    owners,
    ownedLoads,
  };
}

export function createRailCircuit(spec: RailCircuitSpec): RailCircuit {
  return new RailCircuit(spec);
}
