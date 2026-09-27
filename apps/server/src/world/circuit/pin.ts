// Ported from layered-sim E3 src/pin.ts @ fc7e8d3. Rail voltage is the rail node.
import type { Element } from "./element";
import { Resistor, Switch } from "./elements";
import type { Waveform } from "./wave";

/**
 * ATmega328P pin, 25 °C, VCC = 5 V (DS40002061A).
 * Source drops, Figure 35-24: 4.88 / 4.75 / 4.62 / 4.50 V at 5 / 10 / 15 / 20 mA.
 * Sink drops, Figure 35-22: 0.12 / 0.23 / 0.35 / 0.47 V at the same currents.
 */
export const PIN_ROH = fitResistance([
  [0.005, 5 - 4.88],
  [0.01, 5 - 4.75],
  [0.015, 5 - 4.62],
  [0.02, 5 - 4.5],
]);
export const PIN_ROL = fitResistance([
  [0.005, 0.12],
  [0.01, 0.23],
  [0.015, 0.35],
  [0.02, 0.47],
]);

/** Datasheet RPU, VCC = 5 V. No typical; the default is the midpoint. */
export const PIN_RPU_MIN = 20e3;
export const PIN_RPU_MAX = 50e3;
export const PIN_RPU = (PIN_RPU_MIN + PIN_RPU_MAX) / 2;

/** Open high-Z. Not a datasheet leakage. A solver floor, not a part param. */
export const PIN_ROFF = 1e12;

/**
 * Input leakage to ground. DS40002061 Iin is 1 µA max at 5 V, so 5 MΩ.
 * The D13 LED uses it as a DC path while the pin is an input.
 */
export const PIN_LEAK = 5e6;

/** `avr-pin@1` numbers. The board part carries these; the fits above are the values. */
export type AvrPinParams = {
  /** Ohms, high side, from the board node to the pin. */
  roh: number;
  /** Ohms, low side, from the pin to ground. */
  rol: number;
  /** Ohms, pull-up, from the board node to the pin. */
  rpu: number;
  /** Ohms, pin to ground, while the pin is an input. */
  rLeak: number;
};

export const AVR_PIN: AvrPinParams = {
  roh: PIN_ROH,
  rol: PIN_ROL,
  rpu: PIN_RPU,
  rLeak: PIN_LEAK,
};

/** Part params override the fits. A missing key keeps today's number. */
export function avrPinParams(
  params: Record<string, number> | undefined
): AvrPinParams {
  if (!params) return AVR_PIN;
  return {
    roh: params.roh ?? PIN_ROH,
    rol: params.rol ?? PIN_ROL,
    rpu: params.rpu ?? PIN_RPU,
    rLeak: params.rLeak ?? PIN_LEAK,
  };
}

const OPEN: Waveform = { kind: "dc", value: 0 };

export type PinMode = "high" | "low" | "input" | "pullup";

/**
 * A switch whose closed flag is set by the pin mode. The engine's structure
 * key calls `closed`, so a mode change refactors on the next solve.
 */
class Gate extends Switch {
  on = false;
  constructor(id: string, a: string, b: string, ron: number) {
    super(id, a, b, ron, PIN_ROFF, OPEN);
  }
  override closed(_t: number): boolean {
    return this.on;
  }
}

/**
 * One GPIO pin as a Thevenin leg onto `railNode`.
 * High: Roh from the rail to the pin. Low: Rol from the pin to ground.
 * Pull-up: RPU from the rail to the pin. Input: all three open.
 */
export class Pin {
  readonly form = "avr-pin@1";
  readonly high: Gate;
  readonly low: Gate;
  readonly pullup: Gate;
  /** Input leakage to ground. Absent when this pin was built without `rLeak`. */
  readonly leak: Resistor | null;
  mode: PinMode = "input";

  constructor(
    readonly id: string,
    readonly pinNode: string,
    readonly railNode: string,
    readonly roh = PIN_ROH,
    readonly rol = PIN_ROL,
    readonly rpu = PIN_RPU,
    rLeak?: number
  ) {
    this.high = new Gate(`${id}.h`, railNode, pinNode, roh);
    this.low = new Gate(`${id}.l`, pinNode, "0", rol);
    this.pullup = new Gate(`${id}.pu`, railNode, pinNode, rpu);
    this.leak =
      rLeak !== undefined && rLeak > 0
        ? new Resistor(`${id}.leak`, pinNode, "0", rLeak)
        : null;
  }

  setMode(mode: PinMode): void {
    this.mode = mode;
    this.high.on = mode === "high";
    this.low.on = mode === "low";
    this.pullup.on = mode === "pullup";
  }

  /** Stamps this pin contributes. The pin does not own a solver. */
  elements(): Element[] {
    return this.leak
      ? [this.high, this.low, this.pullup, this.leak]
      : [this.high, this.low, this.pullup];
  }
}

function fitResistance(
  points: ReadonlyArray<readonly [number, number]>
): number {
  let num = 0;
  let den = 0;
  for (const [i, v] of points) {
    num += i * v;
    den += i * i;
  }
  return num / den;
}
