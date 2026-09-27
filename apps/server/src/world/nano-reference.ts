/**
 * The hand-built clone Nano network. The run stamps the board netlist
 * instead. These decks stay so the ngspice traces and the 1 µV check
 * still have the previous element list.
 */
import { LED_RED, SS14 } from "./circuit/circuits";
import type { Element } from "./circuit/element";
import {
  type Braking,
  BridgeMotor,
  CurrentLoad,
  capacitor,
  type DiodeParams,
  diode,
  iSource,
  resistor,
  sw,
  TheveninLimit,
  vSource,
} from "./circuit/elements";
import { Engine } from "./circuit/engine";
import {
  AVR_PIN,
  type AvrPinParams,
  PIN_LEAK,
  PIN_ROFF,
  PIN_ROH,
  PIN_ROL,
  Pin,
  type PinMode,
} from "./circuit/pin";
import {
  BOARD_LOAD_KNEE_V,
  NANO_BOARD_A,
  UNO_BOARD_NODE,
  UNO_TERM_NODE,
} from "./power-path";
import { createRailCircuit } from "./rail-circuit";

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
 * C4, 100 nF, from DTR to RESET, and RP1 at 1 kΩ as the pull-up; the
 * clone is assumed to match. DTR idles high at the bridge VCC, modeled as
 * the +5V node, so the capacitor sits from that node to RESET. Upload
 * auto-reset is not modelled.
 */
export const NANO_RESET_R = 1e3;
export const NANO_RESET_C = 100e-9;

/** +5V capacitors, the reset network, and the D13 LED to ground. No diode. */
function nanoBoardNetwork(led: DiodeParams, rLeak = PIN_LEAK): Element[] {
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
    resistor("d13leak", NANO_D13_NODE, "0", rLeak),
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
  withDiode = true,
  drive: AvrPinParams = AVR_PIN
): NanoUsbPath {
  const pin = new Pin(
    "d13pin",
    NANO_D13_NODE,
    UNO_BOARD_NODE,
    drive.roh,
    drive.rol,
    drive.rpu
  );
  return {
    pin,
    elements: [
      ...(withDiode ? [diode("s4", UNO_TERM_NODE, UNO_BOARD_NODE, ss14)] : []),
      ...nanoBoardNetwork(led, drive.rLeak),
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

const MASTER_S = 0.001;
const SUBSTEPS = 10;

/**
 * The previous Nano rail: S4, the onboard network, and one D13 pin.
 * `header` omits S4 and ties the terminal to the board node.
 */
export class ReferenceNanoRail {
  voltage = 0;
  boardVoltage = 0;
  readonly boardNode = UNO_BOARD_NODE;
  private readonly engine: Engine;
  private readonly load: CurrentLoad;
  private readonly motors: BridgeMotor[];
  private readonly termNode: string;
  private readonly pin: Pin;
  private ready = false;

  constructor(spec: {
    vNom: number;
    rSeries: number;
    iLimit: number;
    motors: readonly { resistance: number; k: number; inductance?: number }[];
    header?: boolean;
    braking?: Braking;
  }) {
    const header = spec.header === true;
    const built = createNanoUsbPath(SS14, LED_RED, !header);
    this.pin = built.pin;
    this.termNode = header ? UNO_BOARD_NODE : UNO_TERM_NODE;
    this.load = new CurrentLoad("load", UNO_BOARD_NODE, "0", BOARD_LOAD_KNEE_V);
    const motors: BridgeMotor[] = [];
    for (let i = 0; i < spec.motors.length; i++) {
      const law = spec.motors[i]!;
      motors.push(
        new BridgeMotor(
          `m${i}`,
          UNO_BOARD_NODE,
          law.resistance,
          law.inductance ?? 0,
          law.k,
          spec.braking ?? "clip"
        )
      );
    }
    this.motors = motors;
    this.engine = new Engine(
      [
        new TheveninLimit(
          "src",
          this.termNode,
          "0",
          spec.vNom,
          spec.rSeries,
          spec.iLimit
        ),
        this.load,
        ...motors,
        ...built.elements,
      ],
      { method: "be", h: MASTER_S / SUBSTEPS, atol: 1e-14, rtol: 1e-12 }
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

  setD13(mode: PinMode): void {
    this.pin.setMode(mode);
  }

  solve(): void {
    if (!this.ready) {
      this.engine.operatingPoint();
      this.ready = true;
    } else {
      for (let k = 0; k < SUBSTEPS; k++) this.engine.stepFast();
    }
    this.voltage = this.engine.voltage(this.termNode);
    this.boardVoltage = this.engine.voltage(this.boardNode);
  }
}

/**
 * Step the netlist rail and this reference with the same load.
 * Returns the largest |board − reference| over every master step.
 */
export function maxBoardDelta(
  samples: readonly { fraction: number; d13: PinMode }[],
  spec: {
    vNom: number;
    rSeries: number;
    iLimit: number;
    fixed: number;
    motors: readonly { resistance: number; k: number }[];
    header?: boolean;
  }
): number {
  const neu = createRailCircuit({
    vNom: spec.vNom,
    rSeries: spec.rSeries,
    iLimit: spec.iLimit,
    motors: spec.motors,
    ...(spec.header
      ? { boardPath: "nano-5v" as const }
      : { boardPath: "nano-usb" as const }),
  });
  const ref = new ReferenceNanoRail({
    vNom: spec.vNom,
    rSeries: spec.rSeries,
    iLimit: spec.iLimit,
    motors: spec.motors,
    header: spec.header,
  });
  let worst = 0;
  for (const sample of samples) {
    const mode = sample.d13;
    neu.setFixed(spec.fixed);
    ref.setFixed(spec.fixed);
    neu.setD13(mode);
    ref.setD13(mode);
    const connected = sample.fraction > 0;
    neu.setMotor(0, sample.fraction, 0, connected);
    ref.setMotor(0, sample.fraction, 0, connected);
    for (let i = 0; i < 10; i++) {
      neu.solve();
      ref.solve();
      worst = Math.max(worst, Math.abs(neu.boardVoltage - ref.boardVoltage));
    }
  }
  return worst;
}
