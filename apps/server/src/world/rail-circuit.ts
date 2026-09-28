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
import { type BoardStamp, boardStampOf, realize } from "./circuit-stamp";
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
   * Circuit parts for this rail, from the plan or from `boardStampOf`.
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

  constructor(spec: RailCircuitSpec) {
    const braking = spec.braking ?? "clip";
    const uno = spec.boardPath === "uno-usb";
    const snap = spec.boardPath === "snapshot-feed";
    let stamp = spec.stamp ?? null;
    let feed = spec.feed;
    if (uno && !stamp) {
      stamp = unoAliasStamp();
      feed = "usb";
    }
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
    // A knee load linearized at 0 V can report more than the supply's
    // limit when nothing else conducts. The next stamp is then two
    // currents and no voltage. With no motor, start the nodes at the
    // setpoint so that load is already in its full-current region.
    // A motor on the rail already converges from 0 V, and that path
    // stays on the frozen arm frames.
    if (this.fuse.length > 0 && motors.length === 0) {
      this.engine.seedNodes(spec.vNom);
    }
  }

  setFixed(amps: number): void {
    this.load.amps = amps;
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
}

/** Class-1 `path:uno-usb`. The same netlist class 2 stamps, cached. */
let aliasStamp: BoardStamp | null = null;
function unoAliasStamp(): BoardStamp {
  aliasStamp ??= boardStampOf("sfab/uno-r3@1.0.0", "circuits", {
    boardId: "uno",
  });
  return aliasStamp;
}

export function createRailCircuit(spec: RailCircuitSpec): RailCircuit {
  return new RailCircuit(spec);
}
