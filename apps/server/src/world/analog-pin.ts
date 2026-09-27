import type { AvrPinParams, PinMode } from "./circuit/pin";
import type { RunPlan } from "./plan";

export type AnalogMode = PinMode | "analog";

export type AnalogRead = {
  voltage: number;
  rSource: number;
};

/**
 * Voltage and source resistance of one ADC channel at the sample.
 *
 * A ground on the net is 0 V. A power port is that node's voltage: the
 * board's `5V` is the latched board node, and a supply pin is the supply
 * terminal. This pin alone, as an output, is its `avr-pin@1` level unloaded:
 * high is the board node and low is 0. An input with nothing on it is 0 V.
 * A pull-up with nothing on it is the board node. A6 and A7 have no DDR, so
 * they only follow the net. Anything else on the net, including another
 * part, reads 0 V.
 */
export function analogRead(opts: {
  plan: RunPlan;
  boardId: string;
  channel: number;
  mode: AnalogMode;
  pin: AvrPinParams;
  boardVolts: (boardId: string) => number;
  supplyVolts: (supplyId: string) => number;
}): AnalogRead {
  const start = `${opts.boardId}.A${opts.channel}`;
  const seen = new Set<string>();
  const stack = [start];
  let ground = false;
  let foreign = false;
  const powers: (
    | { kind: "board"; id: string }
    | { kind: "supply"; id: string }
  )[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current !== start) {
      const hit = classify(opts.plan, current);
      if (hit === "ground") ground = true;
      else if (hit === "foreign") foreign = true;
      else if (hit) powers.push(hit);
    }
    for (const wire of opts.plan.wires) {
      const next =
        wire[0] === current ? wire[1] : wire[1] === current ? wire[0] : null;
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  if (ground) return { voltage: 0, rSource: 0 };
  if (powers.length > 0) {
    const own = powers.find(
      (item) => item.kind === "board" && item.id === opts.boardId
    );
    const hit = own ?? powers[0];
    if (hit === undefined) return { voltage: 0, rSource: opts.pin.rLeak };
    const voltage =
      hit.kind === "board" ? opts.boardVolts(hit.id) : opts.supplyVolts(hit.id);
    return { voltage, rSource: 0 };
  }
  if (foreign) return { voltage: 0, rSource: opts.pin.rLeak };
  if (opts.mode === "high") {
    return { voltage: opts.boardVolts(opts.boardId), rSource: opts.pin.roh };
  }
  if (opts.mode === "low") return { voltage: 0, rSource: opts.pin.rol };
  if (opts.mode === "pullup") {
    return { voltage: opts.boardVolts(opts.boardId), rSource: opts.pin.rpu };
  }
  return { voltage: 0, rSource: opts.pin.rLeak };
}

function classify(
  plan: RunPlan,
  endpoint: string
):
  | "ground"
  | "foreign"
  | { kind: "board"; id: string }
  | { kind: "supply"; id: string } {
  const dot = endpoint.indexOf(".");
  if (dot <= 0) return "foreign";
  const id = endpoint.slice(0, dot);
  const pin = endpoint.slice(dot + 1);
  const board = plan.boards.find((item) => item.id === id);
  if (board) {
    if (pin === board.groundPin) return "ground";
    if (pin === board.voltagePin) return { kind: "board", id };
    const spec = board.pins[pin];
    if (spec?.kind === "ground") return "ground";
    // Another GPIO, or a pin this level does not solve, is not a source.
    return "foreign";
  }
  const supply = plan.supplies.find((item) => item.id === id);
  if (supply) {
    if (pin === supply.groundPin) return "ground";
    if (pin === supply.positivePin) return { kind: "supply", id };
    return "foreign";
  }
  const part = plan.parts.find((item) => item.id === id);
  const spec = part?.pins[pin];
  if (spec?.kind === "ground") return "ground";
  if (spec?.kind === "power") return "foreign";
  return "foreign";
}
