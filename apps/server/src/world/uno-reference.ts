/**
 * The hand-built Uno USB network. The run stamps `sfab/uno-r3@1.0.0`
 * class 2 instead. This deck stays so the ngspice trace and the 1e-12
 * check still have the previous element list.
 */
import {
  type Braking,
  BridgeMotor,
  CurrentLoad,
  capacitor,
  diode,
  type Element,
  Engine,
  iSource,
  MF_MSMF050,
  PtcFuseElement,
  resistor,
  TheveninLimit,
  vSource,
} from "@sfab-bench/engine-circuit";
import {
  BOARD_LOAD_KNEE_V,
  UNO_BOARD_NODE,
  UNO_DECOUPLE_C,
  UNO_F1_R,
  UNO_PC2_C,
  UNO_PC2_ESR,
  UNO_SW_NODE,
  UNO_T1_DIODE,
  UNO_T1_RDS,
  UNO_TERM_NODE,
} from "./power-path";

const PC2_NODE = "pc2";
const DECOUPLE = ["c2", "c4", "c6", "c7"] as const;
const MASTER_S = 0.001;
const SUBSTEPS = 10;

/** PC2 with its ESR, and the four +5V ceramics. The header keeps these. */
function unoHeaderCaps(board: string): Element[] {
  return [
    resistor("pc2r", board, PC2_NODE, UNO_PC2_ESR),
    capacitor("pc2", PC2_NODE, "0", UNO_PC2_C),
    ...DECOUPLE.map((id) => capacitor(id, board, "0", UNO_DECOUPLE_C)),
  ];
}

/** T1, and the capacitors on the board node. */
function unoBoardElements(sw: string, board: string): Element[] {
  return [
    resistor("t1", sw, board, UNO_T1_RDS),
    diode("t1d", board, sw, UNO_T1_DIODE),
    ...unoHeaderCaps(board),
  ];
}

/**
 * ngspice deck. F1 is the cold class-1 resistance, not the thermal model.
 * USB preset (5 V, 0.5 Ω), T1, the +5V capacitors, the 50 mA board load,
 * and a 0 → 0.714 A step at 1 ms. The probe is the board node.
 */
export function unoUsbTrace(): Element[] {
  const board = 0.05;
  return [
    vSource("vusb", "src", "0", { kind: "dc", value: 5 }),
    resistor("rs", "src", UNO_TERM_NODE, 0.5),
    resistor("f1", UNO_TERM_NODE, UNO_SW_NODE, UNO_F1_R),
    ...unoBoardElements(UNO_SW_NODE, UNO_BOARD_NODE),
    iSource("iboard", UNO_BOARD_NODE, "0", { kind: "dc", value: board }),
    iSource("iload", UNO_BOARD_NODE, "0", {
      kind: "step",
      t0: 1e-3,
      v0: 0,
      v1: 0.714,
    }),
  ];
}

export type UnoReferenceSpec = {
  vNom: number;
  rSeries: number;
  iLimit: number;
  motors: readonly { resistance: number; k: number }[];
  braking?: Braking;
  /** Header: the supply attaches at the board node. No fuse and no switch. */
  header?: boolean;
};

/**
 * The cable the catalog netlist replaces. One thermal step per
 * millisecond, after the electrical solve, matching the rail.
 */
export class UnoReferenceRail {
  readonly path: boolean;
  voltage = 0;
  current = 0;
  boardVoltage = 0;
  private readonly engine: Engine;
  private readonly load: CurrentLoad;
  private readonly motors: BridgeMotor[];
  private readonly termNode: string;
  private readonly boardNode: string;
  private readonly fuse: PtcFuseElement | null;
  private ready = false;

  constructor(spec: UnoReferenceSpec) {
    const header = spec.header === true;
    this.path = !header;
    this.termNode = header ? UNO_BOARD_NODE : UNO_TERM_NODE;
    this.boardNode = UNO_BOARD_NODE;
    const fuse = header
      ? null
      : new PtcFuseElement("f1", UNO_TERM_NODE, UNO_SW_NODE, MF_MSMF050);
    this.fuse = fuse;
    const braking = spec.braking ?? "clip";
    const motors: BridgeMotor[] = [];
    for (let i = 0; i < spec.motors.length; i++) {
      const law = spec.motors[i]!;
      motors.push(
        new BridgeMotor(
          `m${i}`,
          this.boardNode,
          law.resistance,
          0,
          law.k,
          braking
        )
      );
    }
    this.motors = motors;
    this.load = new CurrentLoad("load", this.boardNode, "0", BOARD_LOAD_KNEE_V);
    const supply = new TheveninLimit(
      "src",
      this.termNode,
      "0",
      spec.vNom,
      spec.rSeries,
      spec.iLimit
    );
    this.engine = new Engine(
      [
        supply,
        this.load,
        ...motors,
        ...(fuse
          ? [fuse, ...unoBoardElements(UNO_SW_NODE, UNO_BOARD_NODE)]
          : unoHeaderCaps(UNO_BOARD_NODE)),
      ],
      {
        method: "be",
        h: MASTER_S / SUBSTEPS,
        atol: 1e-14,
        rtol: 1e-12,
      }
    );
  }

  setFixed(amps: number): void {
    this.load.amps = amps;
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

  tripFuse(): void {
    this.fuse?.trip();
  }

  solve(): void {
    const fuse = this.fuse;
    if (fuse?.pull()) this.engine.dropFactor();
    const n = SUBSTEPS;
    if (!this.ready) {
      this.engine.operatingPoint();
      this.ready = true;
    } else {
      for (let k = 0; k < n; k++) this.engine.stepFast();
    }
    this.voltage = this.engine.voltage(this.termNode);
    this.boardVoltage = this.engine.voltage(this.boardNode);
    this.current = -this.engine.branchCurrent("src");
    if (fuse)
      fuse.advance(
        fuse.current((node) => this.engine.voltage(node)),
        MASTER_S
      );
  }
}
