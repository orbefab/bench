// Uno R3 USB path and the clone Nano USB path (ADR 0010, D-020, D-022).
// Not ported from an experiment file. The SS14 law is the E1 fit in circuit/circuits.ts
// (031dc5e). `nanoRail` there stays the older test circuit, not this board.
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
  sw,
  thermalVoltage,
  vSource,
} from "./circuit/elements";
import { PIN_ROFF, PIN_ROH, PIN_ROL, Pin } from "./circuit/pin";

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
 * A cable or header network between the supply terminal and the board node.
 * `nano-5v` is the clone's onboard network with no diode: the terminal is
 * the board node.
 */
export type BoardPathName = "uno-usb" | "nano-usb" | "nano-5v";

/**
 * Boards the run executes. `uno-usb` is always the cable when a
 * `usb-a-port` feeds that board. `part` reads the firmware variant's
 * `boardCircuit` (`nano-usb` at class 2, absent at class 1).
 */
const FIRMWARE_BOARDS: Record<string, BoardPathName | "part"> = {
  "arduino-uno-r3": "uno-usb",
  "arduino-nano": "part",
};

/** True for a board type the run boots as an ATmega328P. */
export function isFirmwareBoard(typeId: string): boolean {
  return Object.hasOwn(FIRMWARE_BOARDS, typeId);
}

/**
 * The network between this supply and the board it feeds, or null when
 * the 5V pin is the supply terminal. The caller has already checked that
 * this supply feeds that board.
 *
 * An Uno takes the cable only from a `usb-a-port`. A bench supply on its
 * `5V` is the header, with no path. A class-2 Nano takes the diode path
 * from a `usb-a-port`, and the same onboard network without the diode
 * from any other supply on `5V`.
 */
export function usbPathFor(
  supplyType: string,
  boardType: string | null,
  boardCircuit: string | null
): BoardPathName | null {
  if (!boardType || supplyType.length === 0) return null;
  const row = FIRMWARE_BOARDS[boardType];
  if (!row) return null;
  if (row === "uno-usb") return supplyType === "usb-a-port" ? "uno-usb" : null;
  if (boardCircuit !== "nano-usb") return null;
  return supplyType === "usb-a-port" ? "nano-usb" : "nano-5v";
}

/**
 * True when this supply is the USB cable into an Uno. A `usb-a-port`
 * wired to an `arduino-uno-r3`'s `5V` is the cable. A bench supply on
 * `5V` is the header.
 */
export function unoUsbPathFor(
  supplyType: string,
  boardType: string | null
): boolean {
  return usbPathFor(supplyType, boardType, null) === "uno-usb";
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

/**
 * Clone Nano on USB. The chip, the CH340G, and the power LED. The D13
 * LED is not in this sum: class 2 stamps it. Each term is cited on the part.
 * MCU 0.010 A is read from DS40002061's active-current figure at 5 V, 16 MHz.
 * CH340G 0.012 A is the datasheet's USB working current. The power LED is
 * (5 − 1.8) / 1000. The 1 kΩ is RP1 on the Nano Rev 3.2 schematic
 * (NanoV3.2.sch); the clone is assumed to match. 1.8 V is assumed.
 */
export const NANO_MCU_A = 0.01;
export const NANO_CH340_A = 0.012;
export const NANO_POWER_LED_A = 0.0032;
export const NANO_BOARD_A = NANO_MCU_A + NANO_CH340_A + NANO_POWER_LED_A;

/** D13 series resistor. Assumed: the code on the board is unknown. */
export const NANO_D13_R = 1e3;
/** Pin node of the D13 stamp. */
export const NANO_D13_NODE = "d13";
/** Anode of the D13 LED. */
export const NANO_LED_NODE = "leda";
/** RESET pin. The pull-up and the DTR capacitor meet here. */
export const NANO_RESET_NODE = "nrst";

/**
 * A part marked C106, most likely a 10 µF / 16 V tantalum, placed on +5V
 * after the diode. Position assumed. ESR is assumed at 5 Ω, inside the
 * 4–8 Ω maxima of a 10 µF / 16 V case-A tantalum (Kemet T491, AVX TAJ)
 * at 100 kHz.
 */
export const NANO_C106_C = 10e-6;
export const NANO_C106_ESR = 5;
const C106_NODE = "c106";

/**
 * 100 nF on MCU VCC and AVCC. The Nano 3.x schematic decouples those pins.
 * AREF's capacitor is not on +5V. Further ceramics, if the board has them,
 * are the same value.
 */
export const NANO_DECOUPLE_C = 100e-9;
const NANO_DECOUPLE = ["cvcc", "cavcc"] as const;

/**
 * RESET pull-up and the DTR capacitor. Nano Rev 3.2 (NanoV3.2.sch) has
 * C4, 100 nF, from DTR to RESET, and RP1 at 1 kΩ as the pull-up. This
 * path uses 10 kΩ, assumed. DTR idles high at the bridge VCC, modeled as
 * the +5V node, so the capacitor sits from that node to RESET. Upload
 * auto-reset is not modelled.
 */
export const NANO_RESET_R = 10e3;
export const NANO_RESET_C = 100e-9;
/**
 * External reset threshold, fraction of VCC. DS40002061 V_RST maximum:
 * RESET can be recognised as low up to this fraction. Staying above it
 * means the pin never crosses into reset.
 */
export const NANO_VRST_MAX = 0.9;

/** +5V capacitors, the reset network, and the D13 LED to ground. No diode. */
function nanoBoardNetwork(led: DiodeParams): Element[] {
  return [
    resistor("c106r", UNO_BOARD_NODE, C106_NODE, NANO_C106_ESR),
    capacitor("c106", C106_NODE, "0", NANO_C106_C),
    ...NANO_DECOUPLE.map((id) =>
      capacitor(id, UNO_BOARD_NODE, "0", NANO_DECOUPLE_C)
    ),
    resistor("rrst", UNO_BOARD_NODE, NANO_RESET_NODE, NANO_RESET_R),
    capacitor("crst", UNO_BOARD_NODE, NANO_RESET_NODE, NANO_RESET_C),
    resistor("rled", NANO_D13_NODE, NANO_LED_NODE, NANO_D13_R),
    diode("led", NANO_LED_NODE, "0", led),
    // DS40002061 Iin max 1 µA at 5 V. A DC path for D13 while the pin is an input.
    resistor("d13leak", NANO_D13_NODE, "0", 5e6),
  ];
}

/** S4 plus the onboard network. The decks use this; the header omits S4. */
function nanoOnboard(ss14: DiodeParams, led: DiodeParams): Element[] {
  return [
    diode("s4", UNO_TERM_NODE, UNO_BOARD_NODE, ss14),
    ...nanoBoardNetwork(led),
  ];
}

export type NanoUsbPath = {
  /** D13. High connects the pin to the board node through `PIN_ROH`. */
  pin: Pin;
  elements: Element[];
};

/**
 * The capacitors, the reset network, and the D13 LED. `withDiode` adds
 * S4 from the supply terminal to +5V. The header path leaves it off and
 * the caller ties the terminal to the board node. The board's constant
 * draw is the rail's load, not a stamp here. `ss14` is the Vishay fit;
 * `led` is the red indicator.
 */
export function createNanoUsbPath(
  ss14: DiodeParams,
  led: DiodeParams,
  withDiode = true
): NanoUsbPath {
  const pin = new Pin("d13pin", NANO_D13_NODE, UNO_BOARD_NODE);
  return {
    pin,
    elements: [
      ...(withDiode ? [diode("s4", UNO_TERM_NODE, UNO_BOARD_NODE, ss14)] : []),
      ...nanoBoardNetwork(led),
      ...pin.elements(),
    ],
  };
}

/** USB preset, S4, the +5V network, the board load, D13 held on, and a 0.7 A step. */
export function nanoUsbDeck(ss14: DiodeParams, led: DiodeParams): Element[] {
  return [
    vSource("vusb", "src", "0", { kind: "dc", value: 5 }),
    resistor("rs", "src", UNO_TERM_NODE, 0.5),
    ...nanoOnboard(ss14, led),
    resistor("roh", UNO_BOARD_NODE, NANO_D13_NODE, PIN_ROH),
    iSource("iboard", UNO_BOARD_NODE, "0", {
      kind: "dc",
      value: NANO_BOARD_A,
    }),
    iSource("iload", UNO_BOARD_NODE, "0", {
      kind: "step",
      t0: 1e-3,
      v0: 0,
      v1: 0.7,
    }),
  ];
}

/**
 * The same +5V node with D13 switching at 1 kHz. The high switch is
 * `PIN_ROH` from the board node for the first half of each period. The
 * low switch is `PIN_ROL` to ground for the second half. Its waveform
 * swaps the levels (`high` 0, `low` 1) instead of a phase offset: a
 * `t0` on `pwm` does not shift the ngspice PULSE the way `waveAt` does.
 *
 * Step 20 ns, the same choice as `uno-usb`. The 100 nF ceramics against
 * the tantalum's 5 Ω ESR settle in about C·ESR = 0.5 µs, and a coarser
 * step smears that edge. Three milliseconds is three cycles of the 1 kHz pin.
 */
export function nanoD13Deck(ss14: DiodeParams, led: DiodeParams): Element[] {
  const period = 1e-3;
  return [
    vSource("vusb", "src", "0", { kind: "dc", value: 5 }),
    resistor("rs", "src", UNO_TERM_NODE, 0.5),
    ...nanoOnboard(ss14, led),
    sw("d13h", UNO_BOARD_NODE, NANO_D13_NODE, PIN_ROH, PIN_ROFF, {
      kind: "pwm",
      period,
      duty: 0.5,
      low: 0,
      high: 1,
    }),
    sw("d13l", NANO_D13_NODE, "0", PIN_ROL, PIN_ROFF, {
      kind: "pwm",
      period,
      duty: 0.5,
      low: 1,
      high: 0,
    }),
    iSource("iboard", UNO_BOARD_NODE, "0", {
      kind: "dc",
      value: NANO_BOARD_A,
    }),
  ];
}
