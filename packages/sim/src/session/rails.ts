/** Rails: the supply-to-board lookups, binding the rail circuits, the degraded notes, and the node latches the CPUs read. */

import { arduinoPinBit, type Diagnostic } from "@sfab-bench/contract";
import type { AvrBoard } from "@sfab-bench/engine-mcu";
import { splitPortRef } from "@sfab-bench/parts";
import type { RunBoard, RunPlan } from "../plan";
import { railAttachment } from "../power-path";
import { createRailCircuit, type RailCircuit } from "../rail-circuit";
import { blankTrack } from "../servo";
import {
  powerIslands,
  servoSignalDrives,
  suppliesOnPort,
  supplyPositiveNode,
  wireGraph,
} from "../wiring";
import { simMs } from "./common";
import { solveSupplies } from "./solve";
import type { Load, ServoDrive, SessionState, SupplySpec } from "./state";

/**
 * Test-only window. The self-check runs 3 s, so 4 s covers every node it
 * reads. Older rows drop with one slice, not a shift of the whole array.
 */
const ADC_TRACE_MS = 4_000;

/** Board and supply netlist children are dropped on purpose. A scene part is not. */
function scenePrune(s: SessionState, path: string): boolean {
  if (!s.runPlan) return true;
  const under = (id: string) => path === id || path.startsWith(`${id}.`);
  if (s.runPlan.boards.some((board) => under(board.id))) return false;
  if (s.runPlan.supplies.some((supply) => under(supply.id))) return false;
  return true;
}

function noteOpen(s: SessionState, circuit: RailCircuit): void {
  for (const path of circuit.pruned) {
    if (!scenePrune(s, path)) continue;
    noteDegraded(s, path, "idle", "not connected in this circuit");
  }
}

function spansOn(s: SessionState, ids: readonly string[]) {
  const rows = s.runPlan?.spans;
  if (!rows) return undefined;
  const have = new Set(ids);
  const parts = rows
    .filter((row) => row.boards.every((id) => have.has(id)))
    .map((row) => row.part);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The board whose 5V, VIN, or VBUS the part's power pins reach.
 * Ground wires are not followed, so a shared ground is not a second board.
 */
function powerBoardOf(plan: RunPlan, partId: string): string | null {
  const part = plan.parts.find((item) => item.id === partId);
  if (!part) return null;
  const adjacent = wireGraph(plan);
  const isGround = (full: string): boolean => {
    const end = splitPortRef(full);
    if (!end) return false;
    const owner = plan.parts.find((item) => item.id === end.inst);
    if (owner?.pins[end.port]?.kind === "ground") return true;
    const board = plan.boards.find(
      (item) => end.inst === item.id || end.inst.startsWith(`${item.id}.`)
    );
    if (board && end.port === board.groundPin) return true;
    const supply = plan.supplies.find((item) => item.id === end.inst);
    if (supply && end.port === supply.groundPin) return true;
    return false;
  };
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue = Object.entries(part.pins)
    .filter(([, pin]) => pin.kind === "power")
    .map(([name]) => `${partId}.${name}`);
  while (queue.length > 0) {
    const full = queue.shift();
    if (!full || seen.has(full) || isGround(full)) continue;
    seen.add(full);
    const end = splitPortRef(full);
    if (end) {
      for (const board of plan.boards) {
        const onBoard =
          end.inst === board.id || end.inst.startsWith(`${board.id}.`);
        if (
          onBoard &&
          (end.port === board.voltagePin ||
            end.port === "VIN" ||
            end.port === "VBUS")
        ) {
          found.add(board.id);
        }
      }
    }
    for (const next of adjacent.get(full) ?? []) queue.push(next);
  }
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

export function noteDegraded(
  s: SessionState,
  path: string,
  code: string,
  message: string
): void {
  if (s.degradedLive.some((row) => row.path === path && row.code === code)) {
    return;
  }
  const row: Diagnostic = {
    severity: "degraded",
    code,
    path,
    port: "*",
    quantity: "Part",
    left: path,
    right: "idle",
    message,
  };
  s.degradedLive.push(row);
  if (!s.runReport) return;
  const list = s.runReport.degraded ?? [];
  if (list.some((item) => item.path === path && item.code === code)) return;
  s.runReport.degraded = [...list, row];
}

export function bindPower(s: SessionState, plan: RunPlan) {
  s.loads = [];
  if (!s.sim) return;
  const drives = servoSignalDrives(plan);
  for (const part of plan.parts) {
    if (!part.motor || part.torqueNm === undefined) continue;
    const supplyId = s.partFeeds[part.id] ?? null;
    if (!supplyId) {
      noteDegraded(s, part.id, "unpowered", `${part.id} reaches no supply`);
    }
    const signal = drives.find((item) => item.partId === part.id);
    let drive: ServoDrive | null = null;
    if (part.drives && s.sim) {
      const actuatorId = s.sim.index.parts[part.id];
      const trnid = s.sim.model.actuator_trnid as Int32Array;
      const jointId =
        actuatorId === undefined ? -1 : (trnid[actuatorId * 2] ?? -1);
      if (actuatorId !== undefined && jointId >= 0) {
        const bit = signal ? arduinoPinBit(signal.pin) : undefined;
        const board = signal
          ? s.boards.find((item) => item.id === signal.boardId)
          : undefined;
        const wired = board !== undefined && bit !== undefined;
        if (wired && board && bit !== undefined) board.watchEdge(bit);
        drive = {
          board: wired && board ? board : null,
          pinBit: wired && bit !== undefined ? bit : -1,
          actuatorId,
          jointId,
          jointName: `${part.drives.robot}/${part.drives.joint}`,
          torqueNm: part.torqueNm,
          law: part.motor,
          track: blankTrack(),
          manualDeg: null,
        };
      }
    }
    const load: Load = {
      partId: part.id,
      supplyId,
      quiescent: supplyId ? part.motor.quiescent : 0,
      state: "idle",
      current: 0,
      drive,
      sample: null,
      stallMs: 0,
      winding: 0,
      railSlot: -1,
      powerBoard: powerBoardOf(plan, part.id),
    };
    s.loads.push(load);
  }
  bindRails(s);
  solveSupplies(s);
  latchSupplyNodes(s);
  stampNodes(s, simMs(s));
}

/** What a rail circuit stamps for one supply. */
function supplyTerms(
  supply: Pick<
    SupplySpec,
    "voltage" | "rSeries" | "currentLimit" | "battery" | "ideal"
  >
) {
  return {
    vNom: supply.voltage,
    rSeries: supply.rSeries,
    iLimit: supply.currentLimit,
    ...(supply.battery ? { battery: supply.battery } : {}),
    ...(supply.ideal ? { ideal: true as const } : {}),
  };
}

/** The winding sits on the powering board's 5V node, not on the terminal. */
function motorsOf(members: readonly Load[]) {
  return members.map((load) => {
    const drive = load.drive;
    if (!drive) throw new Error("rail motor has no drive");
    return {
      resistance: drive.law.resistance,
      k: drive.law.k,
      boardId: load.powerBoard ?? drive.board?.id,
    };
  });
}

/** One circuit per supply. Motor laws are fixed for the run; s and ω are not. */
function bindRails(s: SessionState) {
  s.rails = new Map();
  for (const load of s.loads) load.railSlot = -1;
  const groups = new Map<string, Load[]>();
  for (const load of s.loads) {
    if (!load.drive || !load.supplyId) continue;
    const list = groups.get(load.supplyId);
    if (list) list.push(load);
    else groups.set(load.supplyId, [load]);
  }
  const islands = s.runPlan ? powerIslands(s.runPlan) : [];
  const islandOf = new Map(
    islands.flatMap((island) =>
      island.supplyIds.map((id) => [id, island] as const)
    )
  );
  const builtIsland = new Set<string>();
  for (const supply of s.supplySpecs) {
    const island = islandOf.get(supply.id);
    if (!s.runPlan || !island || island.supplyIds.length < 2) continue;
    if (builtIsland.has(island.id)) continue;
    const plan = s.runPlan;
    const fed = plan.boards.filter((board) =>
      island.supplyIds.includes(s.boardPower.get(board.id)?.supplyId ?? "")
    );
    const stamped = fed.filter((board) => board.stamp);
    const only = stamped.length === 1 ? stamped[0] : undefined;
    if (stamped.length === 0) continue;
    if (!only?.stamp) {
      const islandSupplies = island.supplyIds.flatMap((id) => {
        const found = plan.supplies.find((item) => item.id === id);
        return found ? [found] : [];
      });
      const boardsSorted = [...stamped].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      );
      const suppliesSorted = [...islandSupplies].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      );
      const primary = suppliesSorted[0];
      if (!primary) continue;
      const members = island.supplyIds.flatMap((id) => groups.get(id) ?? []);
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      const reachedBy = (supplyId: string) =>
        boardsSorted.filter((board) =>
          [board.voltagePin, "VIN", "VBUS"].some((port) =>
            suppliesOnPort(plan, board.id, port).includes(supplyId)
          )
        );
      const claimed = new Set<string>();
      const hostOf = new Map<string, (typeof boardsSorted)[number] | null>();
      const attachOrder = [...suppliesSorted].sort((a, b) => {
        const aOne = reachedBy(a.id).length === 1 ? 0 : 1;
        const bOne = reachedBy(b.id).length === 1 ? 0 : 1;
        if (aOne !== bOne) return aOne - bOne;
        return byId(a, b);
      });
      for (const supply of attachOrder) {
        const reached = reachedBy(supply.id);
        const sole = reached.length === 1 ? reached[0] : undefined;
        if (sole) {
          hostOf.set(supply.id, sole);
          if (supply.connector === "usb" && sole.stamp?.vbusNode) {
            claimed.add(sole.id);
          }
          continue;
        }
        const distinctVbus =
          supply.connector === "usb" &&
          reached.some((board) => board.stamp?.vbusNode);
        if (!distinctVbus) {
          hostOf.set(supply.id, reached[0] ?? null);
          continue;
        }
        const free = reached.filter((board) => !claimed.has(board.id));
        const pool = (free.length > 0 ? free : reached).slice().sort(byId);
        const host = pool[0] ?? null;
        if (host) claimed.add(host.id);
        hostOf.set(supply.id, host);
      }
      const nodeFor = (supplyId: string): string => {
        const supply = suppliesSorted.find((item) => item.id === supplyId);
        const board = hostOf.get(supplyId) ?? null;
        const stamp = board?.stamp;
        if (!supply || !board || !stamp) {
          return supplyPositiveNode(plan, supplyId);
        }
        const onVin = suppliesOnPort(plan, board.id, "VIN").includes(supplyId);
        const onVbus = suppliesOnPort(plan, board.id, "VBUS").includes(
          supplyId
        );
        const onRail = suppliesOnPort(
          plan,
          board.id,
          board.voltagePin
        ).includes(supplyId);
        if (onVbus && stamp.vbusNode) return stamp.vbusNode;
        if (onVin && !onRail && stamp.portNodes.VIN) {
          return stamp.portNodes.VIN;
        }
        if (supply.connector === "usb" && onRail && stamp.vbusNode) {
          return stamp.vbusNode;
        }
        if (onRail) {
          return stamp.portNodes[board.voltagePin] ?? stamp.boardNode;
        }
        if (onVin && stamp.portNodes.VIN) return stamp.portNodes.VIN;
        return stamp.boardNode;
      };
      const primaryNode = nodeFor(primary.id);
      const islandSpans = spansOn(
        s,
        boardsSorted.map((board) => board.id)
      );
      const circuit = createRailCircuit({
        ...supplyTerms(primary),
        motors: motorsOf(members),
        ...(islandSpans ? { spans: islandSpans } : {}),
        primaryId: primary.id,
        primaryNode,
        boards: boardsSorted.map((board) => {
          const feeders = suppliesSorted.filter((supply) =>
            reachedBy(supply.id).some((item) => item.id === board.id)
          );
          const usb = feeders.find((supply) => supply.connector === "usb");
          const feeder = usb ?? feeders[0] ?? primary;
          const one = railAttachment({
            connector: feeder.connector,
            hasNetlist: board.hasNetlist,
            stamp: board.stamp,
          });
          const feed = board.vinFeed ? "vin" : one.feed;
          if (!board.stamp || !feed) {
            throw new Error(`${board.id} has no feed`);
          }
          return {
            id: board.id,
            stamp: board.stamp,
            feed,
            pin: board.pin,
          };
        }),
        also: suppliesSorted.slice(1).map((item) => ({
          id: item.id,
          ...supplyTerms(item),
          node: nodeFor(item.id),
        })),
      });
      noteOpen(s, circuit);
      if (s.fuseStart === "tripped") circuit.tripFuse();
      for (let i = 0; i < members.length; i++) {
        const load = members[i];
        if (load) load.railSlot = i;
      }
      const group = {
        circuit,
        loads: members,
        boardMin: 0,
      };
      for (const id of island.supplyIds) s.rails.set(id, group);
      s.rails.set(island.id, group);
      builtIsland.add(island.id);
      continue;
    }
    const onVin = suppliesOnPort(plan, only.id, "VIN")[0] ?? null;
    const onRail = suppliesOnPort(plan, only.id, only.voltagePin)[0] ?? null;
    const railSupply = plan.supplies.find((item) => item.id === onRail);
    const vinSupply = plan.supplies.find((item) => item.id === onVin);
    const vbus = only.stamp.vbusNode;
    const vinNode = only.stamp.portNodes.VIN ?? null;
    if (
      !railSupply ||
      !vinSupply ||
      !vinNode ||
      vinSupply.id === railSupply.id
    ) {
      continue;
    }
    const usb = railSupply.connector === "usb";
    const railNode = usb ? vbus : only.stamp.boardNode;
    if (!railNode || railNode === vinNode) continue;
    const members = island.supplyIds.flatMap((id) => groups.get(id) ?? []);
    const primary = vinSupply;
    const circuit = createRailCircuit({
      ...supplyTerms(primary),
      motors: motorsOf(members),
      pin: only.pin,
      ledAlias: `${only.id}.led`,
      stamp: only.stamp,
      feed: "vin",
      ...(usb && vbus ? { keep: [vbus] } : {}),
      primaryId: primary.id,
      also: [
        {
          id: railSupply.id,
          ...supplyTerms(railSupply),
          node: railNode,
        },
      ],
    });
    noteOpen(s, circuit);
    if (s.fuseStart === "tripped") circuit.tripFuse();
    for (let i = 0; i < members.length; i++) {
      const load = members[i];
      if (load) load.railSlot = i;
    }
    const group = {
      circuit,
      loads: members,
      boardMin: 0,
    };
    for (const id of island.supplyIds) s.rails.set(id, group);
    s.rails.set(island.id, group);
    builtIsland.add(island.id);
  }
  for (const supply of s.supplySpecs) {
    if (builtIsland.has(islandOf.get(supply.id)?.id ?? "")) continue;
    const members = groups.get(supply.id) ?? [];
    const fedBoards = boardsFed(s, supply.id);
    const stamped = fedBoards.filter((board) => board.stamp);
    const fed = boardOn(s, supply.id);
    const supplyStamp = s.runPlan?.supplies.find(
      (item) => item.id === supply.id
    )?.stamp;
    const attached = railAttachment({
      connector: supplyConnectorOf(s, supply.id),
      hasNetlist: fed?.hasNetlist ?? false,
      stamp: fed?.stamp ?? supplyStamp,
    });
    // One stamped board is the shared rail with N = 1.
    const shared = stamped.length >= 1 && stamped.length === fedBoards.length;
    const sharedSpans = spansOn(
      s,
      stamped.map((board) => board.id)
    );
    const circuit = shared
      ? createRailCircuit({
          ...supplyTerms(supply),
          motors: motorsOf(members),
          ...(stamped.length === 1 && fed
            ? { pin: fed.pin, ledAlias: `${fed.id}.led` }
            : {}),
          ...(sharedSpans ? { spans: sharedSpans } : {}),
          boards: stamped.map((board) => {
            const one = railAttachment({
              connector: supplyConnectorOf(s, supply.id),
              hasNetlist: board.hasNetlist,
              stamp: board.stamp,
            });
            const feed = board.vinFeed ? "vin" : one.feed;
            if (!board.stamp || !feed) {
              throw new Error(`${board.id} has no feed`);
            }
            return {
              id: board.id,
              stamp: board.stamp,
              feed,
              pin: board.pin,
            };
          }),
        })
      : createRailCircuit({
          ...supplyTerms(supply),
          motors: motorsOf(members),
          ...(fed ? { pin: fed.pin, ledAlias: `${fed.id}.led` } : {}),
          ...(attached.stamp && (fed?.vinFeed || attached.feed)
            ? {
                stamp: attached.stamp,
                feed: fed?.vinFeed ? "vin" : attached.feed,
              }
            : {}),
        });
    noteOpen(s, circuit);
    if (s.fuseStart === "tripped") circuit.tripFuse();
    for (let i = 0; i < members.length; i++) {
      const load = members[i];
      if (load) load.railSlot = i;
    }
    s.rails.set(supply.id, { circuit, loads: members, boardMin: 0 });
  }
}

function supplyConnectorOf(s: SessionState, supplyId: string): string | null {
  return (
    s.runPlan?.supplies.find((item) => item.id === supplyId)?.connector ?? null
  );
}

/**
 * The first firmware board this supply powers. A shared rail still
 * uses it for the supply-level snapshot warning.
 */
function boardOn(s: SessionState, supplyId: string): RunBoard | null {
  return boardsFed(s, supplyId)[0] ?? null;
}

export function boardsFed(s: SessionState, supplyId: string): RunBoard[] {
  if (!s.runPlan) return [];
  return s.runPlan.boards.filter(
    (board) => s.boardPower.get(board.id)?.supplyId === supplyId
  );
}

/** The firmware board this supply feeds, when that rail stamps pins. */
export function drivenBoard(
  s: SessionState,
  supplyId: string
): AvrBoard | null {
  const board = boardOn(s, supplyId);
  if (!board) return null;
  return s.boards.find((item) => item.id === board.id) ?? null;
}

/**
 * Volts the ranger may read. A board on the same supply contributes its
 * latched node. A supply with no board contributes its latched terminal,
 * so a bench supply can feed the sensor on its own.
 */
export function latchedSupplyNode(s: SessionState, supplyId: string): number {
  for (const [boardId, power] of s.boardPower) {
    if (power.supplyId === supplyId) return latchedBoardNode(s, boardId);
  }
  return s.latchedTerminal.get(supplyId) ?? 0;
}

/** Board node at the end of the step. With no cable this is the terminal. */
export function boardNodeOf(s: SessionState, supplyId: string): number {
  return s.rails.get(supplyId)?.circuit.boardVoltage ?? 0;
}

export function boardVolts(s: SessionState, boardId: string): number {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return 0;
  return s.rails.get(supplyId)?.circuit.boardReading(boardId).voltage ?? 0;
}

/** Node the CPU is allowed to see: the latch, not the solve in progress. */
export function latchedBoardNode(s: SessionState, boardId: string): number {
  return s.latchedNode.get(boardId) ?? 0;
}

/**
 * Copy each board node into the latch. Called before any CPU step, and
 * again after `solveSupplies` so a reboot in this quantum sees the rail
 * that just recovered.
 */
export function latchSupplyNodes(s: SessionState) {
  if (!s.runPlan) return;
  for (const board of s.runPlan.boards) {
    const supplyId = s.boardPower.get(board.id)?.supplyId;
    s.latchedNode.set(board.id, supplyId ? boardVolts(s, board.id) : 0);
  }
  for (const supply of s.supplySpecs) {
    s.latchedTerminal.set(
      supply.id,
      s.rails.get(supply.id)?.circuit.sourceVoltage(supply.id) ?? 0
    );
  }
}

/** Record the board nodes at `ms`. A second stamp at the same ms replaces it. */
export function stampNodes(s: SessionState, ms: number) {
  if (!s.adcTrace || !s.runPlan) return;
  const boards: Record<string, number> = {};
  for (const spec of s.runPlan.boards) {
    const supplyId = s.boardPower.get(spec.id)?.supplyId;
    boards[spec.id] = supplyId ? boardVolts(s, spec.id) : 0;
  }
  const last = s.adcNodes[s.adcNodes.length - 1];
  if (last && last.ms === ms) last.boards = boards;
  else s.adcNodes.push({ ms, boards });
  const cutoff = ms - ADC_TRACE_MS;
  s.adcNodes = dropOlder(s.adcNodes, cutoff);
  s.adcSamples = dropOlder(s.adcSamples, cutoff);
}

function dropOlder<T extends { ms: number }>(rows: T[], cutoff: number): T[] {
  if (rows.length === 0 || (rows[0]?.ms ?? 0) >= cutoff) return rows;
  let drop = 0;
  while (drop < rows.length && (rows[drop]?.ms ?? 0) < cutoff) drop += 1;
  return rows.slice(drop);
}
