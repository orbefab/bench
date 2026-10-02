import type {
  WorldPartState,
  WorldPinState,
  WorldSupplyState,
} from "@sfab-bench/contract";

import type { WorldSlice } from "./types";

/** The HUD-rate copies of the run: joints, pins, parts, boards, supplies, report. */
export const signalsSlice: WorldSlice<
  "setDiagnostics" | "setSignals" | "setReport" | "setBoards" | "setSupplies"
> = (set, get) => ({
  setDiagnostics: (diagnostics) => {
    const current = get().diagnostics;
    if (
      current.length === diagnostics.length &&
      current.every(
        (row, index) =>
          row.path === diagnostics[index]?.path &&
          row.code === diagnostics[index]?.code &&
          row.message === diagnostics[index]?.message
      )
    ) {
      return;
    }
    set({ diagnostics });
  },
  setSignals: (joints, pins, parts) => {
    const current = get();
    if (
      sameJoints(current.joints, joints) &&
      samePins(current.pins, pins) &&
      sameParts(current.parts, parts)
    ) {
      return;
    }
    set({ joints, pins, parts });
  },
  setReport: (report) => {
    if (get().report === report) return;
    set({ report });
  },
  setBoards: (boards) => {
    const current = get().boards;
    const keys = Object.keys(boards);
    const prev = Object.keys(current);
    if (
      keys.length === prev.length &&
      keys.every((key) => {
        const next = boards[key];
        const old = current[key];
        return (
          next !== undefined &&
          old !== undefined &&
          next.running === old.running &&
          next.fault === old.fault &&
          next.unpowered === old.unpowered &&
          next.brownout === old.brownout &&
          next.resets === old.resets &&
          next.voltage === old.voltage &&
          next.ledCurrent === old.ledCurrent &&
          sameLeds(next.leds, old.leds) &&
          next.warnings?.[0]?.message === old.warnings?.[0]?.message
        );
      })
    ) {
      return;
    }
    set({ boards });
  },
  setSupplies: (supplies) => {
    if (sameSupplies(get().supplies, supplies)) return;
    set({ supplies });
  },
});

function sameJoints(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const robot of aKeys) {
    const left = a[robot];
    const right = b[robot];
    if (!left || !right) return false;
    const names = Object.keys(left);
    if (names.length !== Object.keys(right).length) return false;
    for (const name of names) {
      if (left[name] !== right[name]) return false;
    }
  }
  return true;
}

function sameParts(
  a: Record<string, WorldPartState>,
  b: Record<string, WorldPartState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      left.pulseUs !== right.pulseUs ||
      left.commandDeg !== right.commandDeg ||
      left.state !== right.state ||
      left.current !== right.current ||
      left.voltage !== right.voltage ||
      left.distanceM !== right.distanceM ||
      left.echoS !== right.echoS ||
      left.hit !== right.hit
    ) {
      return false;
    }
  }
  return true;
}

function sameLeds(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function sameSupplies(
  a: Record<string, WorldSupplyState>,
  b: Record<string, WorldSupplyState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      left.voltage !== right.voltage ||
      left.current !== right.current
    ) {
      return false;
    }
  }
  return true;
}

function sameWords(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function samePins(
  a: Record<string, WorldPinState>,
  b: Record<string, WorldPinState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      !sameWords(left.ddr, right.ddr) ||
      !sameWords(left.level, right.level) ||
      !sameWords(left.toggled, right.toggled)
    ) {
      return false;
    }
  }
  return true;
}
