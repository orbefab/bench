/**
 * One row of the board pin table. Bit `i` of the pin words is pin `i`
 * of this board's name list. The names come from the board view.
 */

import { pinBitSet, type WorldPinState } from "@sfab-bench/contract";

export type PinRow = {
  name: string;
  dir: "in" | "out";
  level: "H" | "L";
  /** Toggled since the previous state tick. */
  active: boolean;
};

export function pinRows(
  names: readonly string[],
  pins: WorldPinState
): PinRow[] {
  return names.map((name, index) => ({
    name,
    dir: pinBitSet(pins.ddr, index) ? "out" : "in",
    level: pinBitSet(pins.level, index) ? "H" : "L",
    active: pinBitSet(pins.toggled, index),
  }));
}
