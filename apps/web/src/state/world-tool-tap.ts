/**
 * What a click on empty space means to the active tool. The scene calls
 * `tapEmpty` and names no tool. A tool that holds something listed here lets
 * go of it; the others do nothing.
 */

import type { WorldToolMode } from "@/lib/world-tool";
import { worldToolStore } from "@/state/world-tool";
import { tapWireEmpty } from "@/state/world-wire";

const EMPTY_TAP: Partial<Record<WorldToolMode, () => void>> = {
  wire: tapWireEmpty,
};

export function tapEmpty() {
  EMPTY_TAP[worldToolStore.getState().mode]?.();
}
