// Uno R3 USB path for the circuit rail (ADR 0010, D-020). Not ported from an experiment file.
// The Nano USB function is `nanoRail` in circuit/circuits.ts (E1 @ 031dc5e). World v1
// has no Nano board, so that function waits for one.
/**
 * A `usb-a-port` wired to an Uno's `5V` is the cable into the USB connector.
 * That is how the arm examples are drawn. A bench supply on `5V` is the
 * header, and the rail stays the supply terminal. Servos on `uno.5V` load
 * the board node. The power walk cannot tell a part on the header from a
 * part on the board, so every motor of that supply sits on the node when
 * the path is on.
 *
 * Schematic: "Arduino Uno Rev3", arduino.cc, CC-BY-SA (A000066). Parts are
 * the Rev3e bill of materials (arduino_Uno_Rev3-02-TH). Datasheets cited
 * on the constants. A value marked assumed is not in those documents.
 */

import {
  gStamp,
  type PowerSplit,
  type StampCtx,
  volt,
} from "./circuit/context";
import type { Element } from "./circuit/element";
import {
  capacitor,
  type DiodeParams,
  diode,
  iSource,
  resistor,
  thermalVoltage,
  vSource,
} from "./circuit/elements";

/** Supply side of F1. The rail's Thevenin terminal when the path is on. */
export const UNO_TERM_NODE = "term";
/** Between F1 and T1. */
export const UNO_SW_NODE = "sw";
/** The Uno +5V net. Motors and the board load sit here. */
export const UNO_BOARD_NODE = "v5";
/** 1 V: a 5 V board's idle draw falls off here and cannot sink its own rail through 0 V. */
export const BOARD_LOAD_KNEE_V = 1;
const PC2_NODE = "pc2";

/**
 * Bourns MF-MSMF series, the MF-MSMF050 row (the schematic's MF-MSMF050-2,
 * not the later /16X row). Rmin 0.15 Ω, R1max 1.00 Ω. Class 1 uses Rmin:
 * R1max is the post-trip ceiling, and the cold part is at the bottom of
 * that window. Ihold 0.50 A, Itrip 1.00 A. Maximum time to trip 0.15 s at 8 A.
 */
export const UNO_F1_R = 0.15;
export const UNO_F1_R1MAX = 1;
export const UNO_F1_IHOLD = 0.5;
export const UNO_F1_ITRIP = 1;
/** Datasheet maximum, seconds, at 8 A. */
export const UNO_F1_TMAX_8A_S = 0.15;

/**
 * Power that reaches the trip temperature, watts. Assumed. It sits between
 * Ihold²·Rmin (0.0375 W, must never trip) and Itrip²·Rmin (0.15 W, must).
 */
export const UNO_F1_ALPHA_W = 0.12;
/**
 * Hot resistance, ohms. Assumed. The datasheet does not give it. Large
 * enough that a tripped fuse collapses a 5 V rail.
 */
export const UNO_F1_R_HOT = 80;
/**
 * Trip state falls back to cold below this. Assumed. 1 is the trip.
 * Hysteresis so the step that opens the fuse does not immediately reclose it.
 */
export const UNO_F1_U_RESET = 0.85;
/** Fit target at 8 A, under the 0.15 s maximum. */
export const UNO_F1_T_FIT_8A_S = 0.1;
const F1_P8 = 8 * 8 * UNO_F1_R;
/** Thermal time, seconds. Chosen so 8 A reaches u = 1 in `UNO_F1_T_FIT_8A_S`. */
export const UNO_F1_TAU_S =
  UNO_F1_T_FIT_8A_S / -Math.log(1 - UNO_F1_ALPHA_W / F1_P8);

/**
 * onsemi FDN340P. RDS(on) typical 60 mΩ at VGS = −4.5 V, ID = −2 A
 * (70 mΩ max). The USB path holds the gate at 0 V, so VGS is about −5 V
 * and −4.5 V is the nearest spec. The body diode is in parallel.
 */
export const UNO_T1_RDS = 0.06;
/**
 * Body diode from one point: VSD typical 0.7 V at 0.42 A, VGS = 0.
 * N = 1 and Rs = 0 are assumed; the datasheet gives no second point.
 */
const T1_VSD = 0.7;
const T1_ISD = 0.42;
const T1_VT = thermalVoltage(25);
export const UNO_T1_DIODE: DiodeParams = {
  Is: T1_ISD / (Math.exp(T1_VSD / T1_VT) - 1),
  N: 1,
  Rs: 0,
  tempC: 25,
};

/**
 * PC2, 47 µF on +5V (regulator output). Panasonic EEE-1EA470WP on the
 * Rev3e bill. tan δ = 0.20 at 120 Hz, +20 °C, so ESR = tanδ / (2π·120·C).
 * PC1 is the same value on VIN and is not on this net.
 */
export const UNO_PC2_C = 47e-6;
const PC2_TAN_DELTA = 0.2;
export const UNO_PC2_ESR = PC2_TAN_DELTA / (2 * Math.PI * 120 * UNO_PC2_C);
/**
 * C2, C4, C6, C7: 100 nF each on +5V. Ceramic ESR is not on the schematic
 * or the bill. Assumed 0, so each one is an ideal capacitor.
 */
export const UNO_DECOUPLE_C = 100e-9;
const DECOUPLE = ["c2", "c4", "c6", "c7"] as const;

/**
 * True when this supply is the USB cable into an Uno. A `usb-a-port`
 * wired to an `arduino-uno-r3`'s `5V` is the cable. A bench supply on
 * `5V` is the header. The caller has already checked that this supply
 * feeds that board.
 */
export function unoUsbPathFor(
  supplyType: string,
  boardType: string | null
): boolean {
  return supplyType === "usb-a-port" && boardType === "arduino-uno-r3";
}

/**
 * First-order trip state. `u` is the rise over the trip temperature.
 * `advance` is one master step, after the circuit has been solved.
 */
export class PtcFuse {
  u = 0;
  tripped = false;

  get ohms(): number {
    return this.tripped ? UNO_F1_R_HOT : UNO_F1_R;
  }

  advance(amps: number, dt: number): void {
    const power = amps * amps * this.ohms;
    const steady = power / UNO_F1_ALPHA_W;
    this.u += (dt / UNO_F1_TAU_S) * (steady - this.u);
    if (this.u < 0) this.u = 0;
    if (!this.tripped) {
      if (this.u >= 1) this.tripped = true;
    } else if (this.u <= UNO_F1_U_RESET) {
      this.tripped = false;
    }
  }

  /** Open before the first solve. The next solve stamps the hot resistance. */
  trip(): void {
    this.tripped = true;
    this.u = 1;
  }
}

/**
 * F1 as a conductance. The rail copies `PtcFuse.ohms` in and drops the
 * factored matrix. The thermal step is not part of the stamp.
 */
class PtcResistor implements Element {
  readonly form = "ptc-fuse@1";
  readonly nonlinear = false;
  ohms: number;
  private ia = -1;
  private ib = -1;

  constructor(
    readonly id: string,
    private readonly aName: string,
    private readonly bName: string,
    ohms: number
  ) {
    if (!(ohms > 0)) throw new Error(`${id}: resistance must be positive`);
    this.ohms = ohms;
  }

  nodes(): readonly string[] {
    return [this.aName, this.bName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ia = nodeOf(this.aName);
    this.ib = nodeOf(this.bName);
  }
  signature(): string {
    return String(this.ohms);
  }
  stamp(ctx: StampCtx): void {
    gStamp(ctx, this.ia, this.ib, 1 / this.ohms);
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const i = v / this.ohms;
    const p = v * i;
    return {
      absorbed: p,
      delivered: 0,
      dissipated: p,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = (volt(ctx, this.ia) - volt(ctx, this.ib)) / this.ohms;
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}

/** T1, PC2 with its ESR, and the four +5V ceramics. Shared by the trace and the live path. */
function unoBoardElements(sw: string, board: string): Element[] {
  return [
    resistor("t1", sw, board, UNO_T1_RDS),
    diode("t1d", board, sw, UNO_T1_DIODE),
    resistor("pc2r", board, PC2_NODE, UNO_PC2_ESR),
    capacitor("pc2", PC2_NODE, "0", UNO_PC2_C),
    ...DECOUPLE.map((id) => capacitor(id, board, "0", UNO_DECOUPLE_C)),
  ];
}

export type UnoUsbPath = {
  fuse: PtcFuse;
  /** Ohms the stamp uses. The rail writes the fuse value here. */
  resistor: { ohms: number };
  elements: Element[];
};

/** F1, T1, and the +5V capacitors, from the supply terminal to the board node. */
export function createUnoUsbPath(): UnoUsbPath {
  const fuse = new PtcFuse();
  const element = new PtcResistor("f1", UNO_TERM_NODE, UNO_SW_NODE, fuse.ohms);
  return {
    fuse,
    resistor: element,
    elements: [element, ...unoBoardElements(UNO_SW_NODE, UNO_BOARD_NODE)],
  };
}

/**
 * ngspice deck. F1 is the cold class-1 resistance, not the thermal model.
 * USB preset (5 V, 0.5 Ω), T1, the +5V capacitors, the 50 mA board load,
 * and a 0 → 0.714 A step at 1 ms. The probe is the board node.
 */
export function unoUsbTrace(): Element[] {
  // The class-1 deck: 5 V, 0.5 Ω, and the Uno's 50 mA quiescent.
  const board = 0.05;
  return [
    vSource("vusb", "src", "0", {
      kind: "dc",
      value: 5,
    }),
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
