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
import { type BoardStamp, realize } from "./circuit-stamp";
import {
  BOARD_LOAD_KNEE_V,
  type BoardPathName,
  createUnoUsbPath,
  type PtcFuse,
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
   * Required together with `feed`. The rail does not load a catalog.
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
  private readonly fuse: PtcFuse | null;
  private readonly fuseR: { ohms: number } | null;
  private readonly drives: {
    bit: number;
    pin: { setMode(mode: PinMode): void };
  }[];
  private readonly ledDiodes: { path: string; diode: Diode }[];
  private readonly ledAlias: string;
  /** Seconds accumulated toward the current recording frame. */
  private ledSpan = 0;
  /** Time-weighted mean of each LED since the last `takeLedFrame`. */
  private ledMean: Record<string, number> = {};
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
  /** Plain-branch tables stamped with the board. The feed table is `src`. */
  private readonly branchLaws: LawTable[];
  private ready = false;

  constructor(spec: RailCircuitSpec) {
    const braking = spec.braking ?? "clip";
    const uno = spec.boardPath === "uno-usb";
    const snap = spec.boardPath === "snapshot-feed";
    const stamp = spec.stamp ?? null;
    if (stamp && spec.feed !== "usb" && spec.feed !== "header") {
      throw new Error("a board stamp needs feed usb or header");
    }
    const realized = stamp
      ? realize(stamp, spec.feed ?? "header", spec.pin ?? AVR_PIN)
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
    this.portNodes = stamp?.portNodes ?? {};
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
    const unoPath = uno ? createUnoUsbPath() : null;
    this.fuse = unoPath?.fuse ?? null;
    this.fuseR = unoPath?.resistor ?? null;
    this.winding = new Float64Array(motors.length);
    this.engine = new Engine(
      [
        supply,
        this.load,
        ...motors,
        ...(unoPath?.elements ?? realized?.elements ?? []),
      ],
      {
        method: "be",
        h: MASTER_S / this.substeps,
        atol: 1e-14,
        rtol: 1e-12,
      }
    );
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
    return this.fuse?.tripped ?? false;
  }

  /** Open the fuse before the next solve. No effect without the Uno path. */
  tripFuse(): void {
    this.fuse?.trip();
  }

  /** One stamped pin follows the firmware drive at this master step. */
  setDrive(bit: number, mode: PinMode): void {
    const found = this.drives.find((row) => row.bit === bit);
    found?.pin.setMode(mode);
  }

  /**
   * Solved voltage of a board port that is a node of this rail.
   * Null when the port is not in the stamp or the node was pruned.
   * `rSource` is that node's Thevenin resistance from the factored
   * Jacobian. It is 0 when the factor is gone.
   */
  probePort(port: string): { voltage: number; rSource: number } | null {
    const node = this.portNodes[port];
    if (!node) return null;
    if (node !== "0" && !this.engine.nodeNames.includes(node)) return null;
    const voltage = node === "0" ? 0 : this.engine.voltage(node);
    const r = this.engine.thevenin(node);
    return { voltage, rSource: r ?? 0 };
  }

  /** D13. Same as `setDrive` for that bit. */
  setD13(mode: PinMode): void {
    const bit = arduinoPinBit("D13");
    if (bit === undefined) return;
    this.setDrive(bit, mode);
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
  private noteNano(dt: number): void {
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
   * `pieces`, when a stamped pin changed inside this millisecond, are the
   * intervals between those edges. Their durations sum to one master step.
   * With no pieces the pin is held and the grid is the one used before.
   */
  solve(
    pieces?: readonly {
      dt: number;
      drive: readonly { bit: number; mode: PinMode }[];
    }[]
  ): void {
    const fuse = this.fuse;
    const fuseR = this.fuseR;
    if (fuse && fuseR && fuseR.ohms !== fuse.ohms) {
      fuseR.ohms = fuse.ohms;
      this.engine.dropFactor();
    }
    const frozen = this.engine.frozenSteps;
    let min = Number.POSITIVE_INFINITY;
    this.resetMarginMin = Number.POSITIVE_INFINITY;
    if (!this.ready) {
      this.engine.operatingPoint();
      this.ready = true;
      min = this.engine.voltage(this.boardNode);
      this.noteNano(0);
    } else if (pieces && pieces.length > 0) {
      min = this.runPieces(pieces);
    } else {
      const n = this.substeps;
      const dt = this.engine.h;
      for (let k = 0; k < n; k++) {
        this.engine.stepFast();
        const v = this.engine.voltage(this.boardNode);
        if (v < min) min = v;
        this.noteNano(dt);
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
    fuse?.advance(this.current, MASTER_S);
  }

  /** Pin edges inside one master step. Each chunk is at most one grid step. */
  private runPieces(
    pieces: readonly {
      dt: number;
      drive: readonly { bit: number; mode: PinMode }[];
    }[]
  ): number {
    let min = Number.POSITIVE_INFINITY;
    const h = this.engine.h;
    for (const piece of pieces) {
      for (const drive of piece.drive) this.setDrive(drive.bit, drive.mode);
      let left = piece.dt;
      while (left > h * (1 + 1e-9)) {
        this.engine.advance(h);
        const v = this.engine.voltage(this.boardNode);
        if (v < min) min = v;
        this.noteNano(h);
        left -= h;
      }
      if (left > 1e-15) {
        this.engine.advance(left);
        const v = this.engine.voltage(this.boardNode);
        if (v < min) min = v;
        this.noteNano(left);
      }
    }
    this.engine.parkGrid(this.substeps);
    return min;
  }
}

export function createRailCircuit(spec: RailCircuitSpec): RailCircuit {
  return new RailCircuit(spec);
}
