import { type PowerFeeds, pinIndex } from "@sfab-bench/contract";
import { splitPortRef, UnionFind } from "@sfab-bench/parts";

import type { RunPin, RunPlan } from "./plan";

export type { PowerFeeds };

/**
 * A servo signal tied straight to one board GPIO pin. Direct pairs only:
 * a wire is `["uno.D9", "servo.signal"]`, not a net of several hops.
 */
export type ServoSignalDrive = {
  partId: string;
  boardId: string;
  pin: string;
};

/** What the power walks read: the electrical wires and the ends they land on. */
export type PowerWiring = Pick<
  RunPlan,
  "boards" | "parts" | "rangers" | "supplies" | "wires"
>;

/**
 * Each servo whose signal pin has a direct wire to a board digital GPIO.
 * Anything else is not driven: no wire, a supply pin, or a hop through
 * another part. A0–A5 count (D-018). The first matching pair wins.
 */
export function servoSignalDrives(plan: RunPlan): ServoSignalDrive[] {
  const drives: ServoSignalDrive[] = [];
  for (const part of plan.parts) {
    if (part.drive.kind !== "servo") continue;
    const signal = part.drive.pin;
    let found: ServoSignalDrive | null = null;
    for (const wire of plan.wires) {
      const left = splitPortRef(wire[0]);
      const right = splitPortRef(wire[1]);
      if (!left || !right) continue;
      const other =
        left.inst === part.id && left.port === signal
          ? right
          : right.inst === part.id && right.port === signal
            ? left
            : null;
      if (!other) continue;
      const board = plan.boards.find((item) => item.id === other.inst);
      const spec = board?.pins[other.port];
      if (!board || !spec?.digital) continue;
      found = { partId: part.id, boardId: board.id, pin: other.port };
      break;
    }
    if (found) drives.push(found);
  }
  return drives;
}

export type GpioDriver =
  | { kind: "gpio"; boardId: string; bit: number }
  | { kind: "low" }
  | { kind: "high" };

export type GpioInputNet = {
  boardId: string;
  bit: number;
  drivers: GpioDriver[];
};

/** A board the net resolver can read an output from and drive an input on. */
export type GpioLevelBoard = {
  id: string;
  outputLevel(bit: number): boolean | null;
  setDriven(bit: number, level: boolean | null): void;
};

function endpointPin(plan: PowerWiring, endpoint: string): RunPin | null {
  const split = splitPortRef(endpoint);
  if (!split) return null;
  const board = plan.boards.find((item) => item.id === split.inst);
  if (board) return board.pins[split.port] ?? null;
  const part = plan.parts.find((item) => item.id === split.inst);
  if (part) return part.pins[split.port] ?? null;
  const ranger = plan.rangers?.find((item) => item.id === split.inst);
  if (ranger && split.port === "VCC") {
    return { kind: "power", output: false, digital: false, pwm: false };
  }
  if (ranger && split.port === "GND") {
    return { kind: "ground", output: false, digital: false, pwm: false };
  }
  const supply = plan.supplies.find((item) => item.id === split.inst);
  if (supply) return supply.pins[split.port] ?? null;
  return null;
}

/**
 * Board GPIO pins that share a wire net with another GPIO, a ground,
 * or a supply positive. Another GPIO is a driver only while its DDR
 * says output. A ground drives low and a supply positive drives high,
 * and either beats a pull-up. Catalog `output` is not consulted for a
 * GPIO: it is an output at runtime when the firmware sets DDR.
 */
export function gpioInputNets(plan: RunPlan): GpioInputNet[] {
  const gpio = new Map<string, { boardId: string; bit: number }>();
  for (const board of plan.boards) {
    for (const pin of Object.keys(board.pins)) {
      if (!board.pins[pin]?.digital) continue;
      const bit = pinIndex(board.pinOrder, pin);
      if (bit === undefined) continue;
      gpio.set(`${board.id}.${pin}`, { boardId: board.id, bit });
    }
  }
  const adjacent = wireGraph(plan);
  const out: GpioInputNet[] = [];
  for (const [endpoint, self] of gpio) {
    const seen = new Set<string>();
    const stack = [endpoint];
    const drivers: GpioDriver[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      if (current !== endpoint) {
        const pin = endpointPin(plan, current);
        if (pin?.kind === "ground") {
          drivers.push({ kind: "low" });
        } else if (pin?.kind === "power" && pin.output) {
          drivers.push({ kind: "high" });
        } else {
          const other = gpio.get(current);
          if (
            other &&
            (other.boardId !== self.boardId || other.bit !== self.bit)
          ) {
            drivers.push({
              kind: "gpio",
              boardId: other.boardId,
              bit: other.bit,
            });
          }
        }
      }
      for (const next of adjacent.get(current) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    if (drivers.length > 0) {
      out.push({ boardId: self.boardId, bit: self.bit, drivers });
    }
  }
  return out;
}

/** Every wire, both ways. With `kind`, only wires whose two ends are that kind. */
export function wireGraph(
  plan: PowerWiring,
  kind?: RunPin["kind"]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = map.get(from);
    if (list) list.push(to);
    else map.set(from, [to]);
  };
  for (const wire of plan.wires) {
    if (
      kind &&
      (endpointPin(plan, wire[0])?.kind !== kind ||
        endpointPin(plan, wire[1])?.kind !== kind)
    ) {
      continue;
    }
    link(wire[0], wire[1]);
    link(wire[1], wire[0]);
  }
  return map;
}

function reachedFrom(
  start: string,
  adjacent: Map<string, string[]>
): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacent.get(current) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

function supplyOn(plan: PowerWiring, reached: Set<string>): string | null {
  for (const supply of plan.supplies) {
    if (reached.has(`${supply.id}.${supply.positivePin}`)) return supply.id;
  }
  return null;
}

/**
 * A part on a VIN-fed board's regulated rail has no wire to the supply.
 * The regulator is that connection: the part's feed is the board's.
 */
function regulatedSupply(
  plan: RunPlan,
  boards: Readonly<Record<string, string | null>>,
  reached: ReadonlySet<string>
): string | null {
  for (const board of plan.boards) {
    if (!board.vinFeed) continue;
    const onRail = board.powerInputs.some((pin) =>
      reached.has(`${board.id}.${pin}`)
    );
    if (!onRail) continue;
    const feed = boards[board.id];
    if (feed) return feed;
  }
  return null;
}

/** Which supply reaches each board and each part, on the net walk. */
export function powerFeedsOf(plan: RunPlan): PowerFeeds {
  // The whole net, as `suppliesOnPort` reads it: a passive hub between the
  // supply and a pin does not cut the feed.
  const adjacent = wireGraph(plan);
  const boards: Record<string, string | null> = {};
  for (const board of plan.boards) {
    let feed: string | null = null;
    for (const pin of board.powerInputs) {
      feed = supplyOn(plan, reachedFrom(`${board.id}.${pin}`, adjacent));
      if (feed) break;
    }
    if (!feed && board.regulatorPin) {
      feed = supplyOn(
        plan,
        reachedFrom(`${board.id}.${board.regulatorPin}`, adjacent)
      );
    }
    boards[board.id] = feed;
  }
  const parts: Record<string, string | null> = {};
  for (const part of plan.parts) {
    let feed: string | null = null;
    const reached = new Set<string>();
    for (const [pin, spec] of Object.entries(part.pins)) {
      if (spec.kind !== "power") continue;
      const hit = reachedFrom(`${part.id}.${pin}`, adjacent);
      for (const node of hit) reached.add(node);
      feed = supplyOn(plan, hit);
      if (feed) break;
    }
    parts[part.id] = feed ?? regulatedSupply(plan, boards, reached);
  }
  for (const ranger of plan.rangers ?? []) {
    const hit = reachedFrom(`${ranger.id}.VCC`, adjacent);
    parts[ranger.id] =
      supplyOn(plan, hit) ?? regulatedSupply(plan, boards, hit);
  }
  return { boards, parts };
}

export type PowerIsland = {
  /** Lex-first supply on the island. A lone supply uses its own id. */
  id: string;
  supplyIds: string[];
};

/**
 * One rail per connected power island. Supplies whose grounds meet are
 * one island, even when each positive pin feeds a different board.
 * Supplies whose grounds stay apart are not one circuit: tying them
 * would short two grounds. That island is left split.
 */
export function powerIslands(plan: RunPlan): PowerIsland[] {
  const islandsOf = new UnionFind();
  for (const supply of plan.supplies) islandsOf.add(supply.id);
  const grounds = wireGraph(plan, "ground");
  const shareGround = (a: string, b: string): boolean => {
    const left = plan.supplies.find((item) => item.id === a);
    const right = plan.supplies.find((item) => item.id === b);
    if (!left || !right) return false;
    const hit = reachedFrom(`${left.id}.${left.groundPin}`, grounds);
    return hit.has(`${right.id}.${right.groundPin}`);
  };
  const ids = plan.supplies.map((supply) => supply.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const left = ids[i];
      const right = ids[j];
      if (!left || !right || !shareGround(left, right)) continue;
      islandsOf.union(left, right);
    }
  }
  const groups = new Map<string, string[]>();
  for (const supply of plan.supplies) {
    const root = islandsOf.find(supply.id);
    const list = groups.get(root) ?? [];
    list.push(supply.id);
    groups.set(root, list);
  }
  const islands: PowerIsland[] = [];
  const seen = new Set<string>();
  for (const supply of plan.supplies) {
    const root = islandsOf.find(supply.id);
    if (seen.has(root)) continue;
    seen.add(root);
    const supplyIds = [...(groups.get(root) ?? [])].sort();
    const id = supplyIds[0];
    if (!id) continue;
    islands.push({ id, supplyIds });
  }
  return islands;
}

/**
 * Node name of a supply's positive net. The same lex-first port the
 * stamp uses, or `"0"` when that net is ground. A supply that reaches
 * no board feed stamps here, so it cannot land on another board's node.
 */
export function supplyPositiveNode(plan: RunPlan, supplyId: string): string {
  const supply = plan.supplies.find((item) => item.id === supplyId);
  if (!supply) return "rail";
  const start = `${supply.id}.${supply.positivePin}`;
  const hit = reachedFrom(start, wireGraph(plan));
  for (const name of hit) {
    if (endpointPin(plan, name)?.kind === "ground") return "0";
  }
  const names = [...hit].sort();
  return names[0] ?? start;
}

/**
 * Supplies whose positive pin is on the electrical net of `path.port`,
 * whatever kind of pin the net's wires star out from. The one "which
 * supply feeds this port" answer: the plan builder and the rail binding
 * both read it.
 */
export function suppliesOnPort(
  plan: PowerWiring,
  path: string,
  port: string
): string[] {
  const hit = reachedFrom(`${path}.${port}`, wireGraph(plan));
  const ids: string[] = [];
  for (const supply of plan.supplies) {
    if (hit.has(`${supply.id}.${supply.positivePin}`)) ids.push(supply.id);
  }
  return ids;
}

/**
 * A GPIO output wins, then a ground, then a supply positive. The worker
 * calls this from the port listener (`onPinsChanged`) before that board
 * applies pull-ups.
 */
export function applyGpioDrives(
  nets: readonly GpioInputNet[],
  boards: readonly GpioLevelBoard[]
): void {
  for (const net of nets) {
    const board = boards.find((item) => item.id === net.boardId);
    if (!board) continue;
    let level: boolean | null = null;
    for (const driver of net.drivers) {
      if (driver.kind !== "gpio") continue;
      const other = boards.find((item) => item.id === driver.boardId);
      const driven = other?.outputLevel(driver.bit);
      if (driven === null || driven === undefined) continue;
      level = driven;
      break;
    }
    if (level === null) {
      if (net.drivers.some((driver) => driver.kind === "low")) level = false;
      else if (net.drivers.some((driver) => driver.kind === "high")) {
        level = true;
      }
    }
    board.setDriven(net.bit, level);
  }
}
