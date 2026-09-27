/** Ported from layered-sim E4 (fd10742). DC sweep of the class-2 Nano USB input. */

import { ISource, Resistor, VSource } from "./circuit/elements";
import { Engine } from "./circuit/engine";
import { AVR_PIN } from "./circuit/pin";
import { catalogNanoStamp, realize } from "./circuit-stamp";

/** Cable resistance of `sfab/usb-port-500ma@1.0.0`, ohms. */
export const USB_RS = 0.5;

/**
 * Steady +5V node of the flattened class-2 USB netlist.
 * Capacitors are open at DC. D13 stays an input, so the LED and the
 * reset resistor draw nothing from the board node.
 */
export function nanoUsbDc(supply: number, amps: number): number {
  const stamp = catalogNanoStamp();
  const realized = realize(stamp, "usb", AVR_PIN);
  const engine = new Engine(
    [
      new VSource("v", "src", "0", { kind: "dc", value: supply }),
      new Resistor("rs", "src", realized.feedNode, USB_RS),
      ...realized.elements,
      new ISource("load", realized.boardNode, "0", {
        kind: "dc",
        value: amps,
      }),
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return engine.voltage(realized.boardNode);
}
