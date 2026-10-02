// Uno R3 USB path and the clone Nano USB path (ADR 0010, D-020, D-022).
// Not ported from an experiment file. The SS14 law is the E1 fit in circuit/circuits.ts
// (031dc5e). `nanoRail` there stays the older test circuit, not this board.
/**
 * A `usb-a-port` wired to an Uno's `5V` is the cable into the USB connector.
 * That is how the arm examples are drawn. The Uno's board netlist takes
 * the cable at its `usb` port. A bench supply on `5V`
 * is the header: the supply attaches at `5V`, `VBUS` is unfed, and the
 * capacitors on `5V` stay. Servos on `uno.5V` load the board node.
 * The power walk cannot tell a part on the header from a part on the board,
 * so every motor of that supply sits on the node when the path is on.
 *
 * Schematic: "Arduino Uno Rev3", arduino.cc, CC-BY-SA (A000066). Parts are
 * the Rev3e bill of materials (arduino_Uno_Rev3-02-TH). Datasheets cited
 * on the constants. A value marked assumed is not in those documents.
 */

import { type DiodeParams, thermalVoltage } from "@sfab-bench/engine-circuit";

/** Supply side of F1. The rail's Thevenin terminal when the path is on. */
export const UNO_TERM_NODE = "term";
/** Between F1 and T1. */
export const UNO_SW_NODE = "sw";
/** The Uno +5V net. Motors and the board load sit here. */
export const UNO_BOARD_NODE = "v5";
/** 1 V: a 5 V board's idle draw falls off here and cannot sink its own rail through 0 V. */
export const BOARD_LOAD_KNEE_V = 1;

/**
 * Bourns MF-MSMF series, the MF-MSMF050 row (the schematic's MF-MSMF050-2,
 * not the later /16X row). Rmin 0.15 Ω, R1max 1.00 Ω. Class 1 uses Rmin:
 * R1max is the post-trip ceiling, and the cold part is at the bottom of
 * that window. Ihold 0.50 A, Itrip 1.00 A. Maximum time to trip 0.15 s at 8 A.
 */
export const UNO_F1_R = 0.15;
export const UNO_F1_IHOLD = 0.5;
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

/**
 * Where the supply attaches. `usb` is VBUS. `header` is the 5V node.
 * `vin` is the VIN node: the onboard regulator feeds the 5V rail.
 */
export type RailFeed = "usb" | "header" | "vin";

/**
 * What the worker puts on one rail. A board netlist (`hasNetlist`) takes
 * `feed: "usb"` from a `usb` connector (the cable lands on the board's
 * `usb` port) and `feed: "header"` from any other supply. The supply
 * stays a part. A board with no netlist takes the supply on its power pin
 * with `feed: "header"` when the plan stamped one.
 */
export function railAttachment<T>(input: {
  connector: string | null;
  hasNetlist: boolean;
  stamp: T | undefined;
}): {
  stamp?: T;
  feed?: "usb" | "header";
} {
  const stamp = input.stamp;
  const feed = input.hasNetlist
    ? input.connector === "usb"
      ? "usb"
      : "header"
    : stamp
      ? "header"
      : undefined;
  return stamp && feed ? { stamp, feed } : {};
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
