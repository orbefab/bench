// Ported from layered-sim E1 src/circuits.ts @ 031dc5e and E3 src/circuits.ts @ fc7e8d3.
import { unoUsbTrace } from "../power-path";
import type { Element } from "./element";
import {
  capacitor,
  type DiodeParams,
  diode,
  iSource,
  resistor,
  thermalVoltage,
  vSource,
} from "./elements";
import { PIN_ROH } from "./pin";
import type { Waveform } from "./wave";

/** Published 1N4148 parameters. Shared with the ngspice decks. */
export const D1N4148: DiodeParams = {
  Is: 2.52e-9,
  N: 1.752,
  Rs: 0.568,
  tempC: 25,
};

/**
 * Kingbright WP7113ID, 25 °C. Table VF = 1.9 V at 10 mA.
 * Curve reads 1.7 / 1.8 / 2.0 / 2.08 V at 2 / 5 / 16 / 20 mA.
 */
export const LED_RED: DiodeParams = fitShockley([
  [0.002, 1.7],
  [0.005, 1.8],
  [0.01, 1.9],
  [0.016, 2.0],
  [0.02, 2.08],
]);

/**
 * Vishay SS12–SS14, Fig. 3, 25 °C. 0.32 / 0.40 / 0.45 / 0.50 / 0.75 V
 * at 0.1 / 0.5 / 1 / 2 / 10 A. Document 88746. The Nano diode is marked S4.
 */
export const SS14: DiodeParams = fitShockley([
  [0.1, 0.32],
  [0.5, 0.4],
  [1, 0.45],
  [2, 0.5],
  [10, 0.75],
]);

export const POT_R = 10e3;
export const POT_ALPHAS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;
export const POT_RAILS = [5, 4.4] as const;

const STEP1: Waveform = { kind: "step", t0: 0, v0: 0, v1: 1 };
const STEP5: Waveform = { kind: "step", t0: 0, v0: 0, v1: 5 };

export type TraceCase = {
  id: string;
  probe: string;
  h: number;
  steps: number;
  elements: () => Element[];
};

/** Circuits checked against a stored ngspice trace. */
export const TRACE_CASES: readonly TraceCase[] = [
  { id: "rc-step", probe: "out", h: 1e-6, steps: 4000, elements: rcStep },
  { id: "divider", probe: "mid", h: 1e-5, steps: 20, elements: divider },
  {
    id: "diode-clamp",
    probe: "out",
    h: 1e-6,
    steps: 2000,
    elements: diodeClamp,
  },
  { id: "pin-led", probe: "a", h: 1e-6, steps: 50, elements: pinLed },
  {
    id: "pwm-50",
    probe: "out",
    h: 10e-6,
    steps: 8000,
    elements: () => pinPwm(0.5),
  },
  {
    id: "pwm-20",
    probe: "out",
    h: 10e-6,
    steps: 8000,
    elements: () => pinPwm(0.2),
  },
  {
    id: "nano-power",
    probe: "rail",
    h: 1e-7,
    steps: 30000,
    elements: nanoRail,
  },
  {
    id: "uno-usb",
    probe: "v5",
    h: 2e-8,
    steps: 150000,
    elements: unoUsbTrace,
  },
];

export function rcStep(): Element[] {
  return [
    vSource("vs", "in", "0", STEP1),
    resistor("r", "in", "out", 1e3),
    capacitor("c", "out", "0", 1e-6),
  ];
}

export function divider(): Element[] {
  return [
    vSource("vs", "in", "0", STEP5),
    resistor("r1", "in", "mid", 1e3),
    resistor("r2", "mid", "0", 1e3),
  ];
}

export function diodeClamp(): Element[] {
  return [
    vSource("vs", "in", "0", { kind: "sine", offset: 0, amp: 5, freq: 1000 }),
    resistor("r", "in", "out", 1e3),
    diode("d", "out", "0", D1N4148),
  ];
}

/** Pin high through Roh, 1 kΩ and the red LED. Roh is a resistor, as in E1. */
export function pinLed(): Element[] {
  return [
    vSource("vs", "src", "0", { kind: "step", t0: 0, v0: 0, v1: 5 }),
    resistor("rp", "src", "pin", PIN_ROH),
    resistor("rled", "pin", "a", 1e3),
    diode("led", "a", "0", LED_RED),
  ];
}

/** 490 Hz PWM through Roh into 10 kΩ and 1 µF. */
export function pinPwm(duty: number): Element[] {
  return [
    vSource("vs", "src", "0", {
      kind: "pwm",
      period: 1 / 490,
      duty,
      low: 0,
      high: 5,
    }),
    resistor("rp", "src", "pin", PIN_ROH),
    resistor("rf", "pin", "out", 10e3),
    capacitor("c", "out", "0", 1e-6),
  ];
}

/**
 * Nano USB path (D-024), the library function for a future Nano board.
 * There is no Nano in World v1. Cable 0.2 Ω is assumed. Stall current
 * steps at 1 ms. 5 V, the SS14, 20 µF, 50 mA board load, 0.7 A stall.
 */
export function nanoRail(): Element[] {
  return [
    vSource("vusb", "src", "0", { kind: "dc", value: 5 }),
    resistor("rcable", "src", "n1", 0.2),
    diode("d", "n1", "rail", SS14),
    capacitor("cbulk", "rail", "0", 20e-6),
    iSource("iboard", "rail", "0", { kind: "dc", value: 0.05 }),
    iSource("istall", "rail", "0", { kind: "step", t0: 1e-3, v0: 0, v1: 0.7 }),
  ];
}

/**
 * Pot from the rail to ground. `alpha` is the wiper fraction, 0 at ground.
 * Ends stay a finite resistance. `rSrc` is the Thevenin resistance the
 * sample-and-hold uses.
 */
export function potDivider(
  alpha: number,
  rail: number
): { elements: Element[]; rSrc: number; rTop: number; rBot: number } {
  const a = Math.min(1, Math.max(0, alpha));
  const rBot = Math.max(a, 1e-9) * POT_R;
  const rTop = Math.max(1 - a, 1e-9) * POT_R;
  const rSrc = (rTop * rBot) / (rTop + rBot);
  return {
    elements: [
      vSource("vrail", "rail", "0", { kind: "dc", value: rail }),
      resistor("rt", "rail", "wiper", rTop),
      resistor("rb", "wiper", "0", rBot),
    ],
    rSrc,
    rTop,
    rBot,
  };
}

/** Series R ladder with a capacitor on each node. Optional 1N4148s at 10%. */
export function ladder(n: number, withDiodes: boolean): Element[] {
  const els: Element[] = [vSource("vs", "n1", "0", STEP1)];
  for (let k = 1; k < n; k++) {
    els.push(resistor(`r${k}`, `n${k}`, `n${k + 1}`, 1e3));
  }
  for (let k = 1; k <= n; k++) {
    els.push(capacitor(`c${k}`, `n${k}`, "0", 1e-9));
  }
  if (withDiodes) {
    const count = Math.max(1, Math.round(n * 0.1));
    for (let i = 0; i < count; i++) {
      const k = 2 + Math.floor((i * Math.max(n - 2, 1)) / count);
      els.push(diode(`d${i}`, `n${k}`, "0", D1N4148));
    }
  }
  return els;
}

function fitShockley(
  points: ReadonlyArray<readonly [number, number]>,
  tempC = 25
): DiodeParams {
  const vt = thermalVoltage(tempC);
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = [0, 0, 0];
  for (const [iAmp, volts] of points) {
    const f = [Math.log(iAmp), 1, iAmp];
    for (let i = 0; i < 3; i++) {
      r[i] = (r[i] as number) + (f[i] as number) * volts;
      for (let j = 0; j < 3; j++) {
        A[i]![j] = (A[i]![j] as number) + (f[i] as number) * (f[j] as number);
      }
    }
  }
  const M = A.map((row, i) => [...row, r[i] as number]);
  for (let k = 0; k < 3; k++) {
    let p = k;
    for (let i = k + 1; i < 3; i++) {
      if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i;
    }
    const tmp = M[k]!;
    M[k] = M[p]!;
    M[p] = tmp;
    const piv = M[k]![k]!;
    for (let j = k; j < 4; j++) M[k]![j] = M[k]![j]! / piv;
    for (let i = 0; i < 3; i++) {
      if (i === k) continue;
      const f = M[i]![k]!;
      for (let j = k; j < 4; j++) M[i]![j] = M[i]![j]! - f * M[k]![j]!;
    }
  }
  const a = M[0]![3]!;
  const b = M[1]![3]!;
  const c = M[2]![3]!;
  return { Is: Math.exp(-b / a), N: a / vt, Rs: c, tempC };
}
