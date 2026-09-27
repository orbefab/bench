/** Ported from layered-sim E4 (fd10742). DC sweep of the class-2 Nano USB input. */
import { SS14 } from "./circuit/circuits";
import { diode, iSource, resistor, vSource } from "./circuit/elements";
import { Engine } from "./circuit/engine";

/** Cable resistance of `sfab/usb-port-500ma@1.0.0`, ohms. */
export const USB_RS = 0.5;

/**
 * Steady +5V node of the class-2 USB path: the port Thevenin and the SS14.
 * Capacitors are open at DC. The LED and the reset network draw nothing
 * while D13 is an input and DTR sits at +5V.
 */
export function nanoUsbDc(supply: number, amps: number): number {
  const engine = new Engine(
    [
      vSource("v", "src", "0", { kind: "dc", value: supply }),
      resistor("rs", "src", "term", USB_RS),
      diode("s4", "term", "v5", SS14),
      iSource("load", "v5", "0", { kind: "dc", value: amps }),
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return engine.voltage("v5");
}
