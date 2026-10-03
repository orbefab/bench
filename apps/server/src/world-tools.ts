import {
  boardTrackId,
  type ChipClock,
  extractUrdfJointsAndMeshes,
  type JointLimitKind,
  jointLimitWarning,
  partTrackId,
  pastLimitAmount,
  pinBitSet,
  RECORD_FRAME_MS,
  type RecordingEvent,
  type RecordingManifest,
  type RecordingRead,
  type RecordingTracks,
  type ResetCause,
  soaNeed,
  soaWarning,
  supplyTrackId,
  type WorldSender,
  type WorldState,
} from "@sfab-bench/contract";
import { confirmSentence } from "@sfab-bench/parts";
import { commandDegFromPulse } from "@sfab-bench/sim/servo";
import { powerFeedsOf, servoSignalDrives } from "@sfab-bench/sim/wiring";
import { tool } from "ai";
import { z } from "zod";
import { viewerProjectRoot, WORLD_ARG } from "./viewer-context";
import {
  applyDocumentEdit,
  type EditError,
  redoDocument,
  undoDocument,
} from "./world/edit";
import { readerFor } from "./world/files";
import {
  ensureWorldRun,
  moveWorldTarget,
  pauseWorld,
  playWorld,
  readRecording,
  recordingInfo,
  rejectWorldStep,
  resolveWorldFile,
  restartWorld,
  stepWorld,
  worldRunView,
} from "./world/host";
import { parseEditRequest } from "./world/live-message";
import { planWorld, type RunPlan, WORLD_V1_MESSAGE } from "./world/plan";

/** Who sent the command. Desktop clients show this label (D-015). */
const AGENT: WorldSender = { kind: "agent" };

const SERIAL_CAP = 4_000;
const LIST_CAP = 200;
const DEFAULT_WINDOW_S = 5;
const DEFAULT_MAX_FRAMES = 50;
const MAX_FRAMES = 500;

const PART_FIELDS = new Set([
  "pulseUs",
  "commandDeg",
  "state",
  "current",
  "voltage",
  "torqueNm",
]);
const SUPPLY_FIELDS = new Set(["voltage", "current", "minVoltage"]);
const BOARD_FIELDS = new Set([
  "pins",
  "running",
  "inReset",
  "voltage",
  "minVoltage",
  "ledCurrent",
]);

type Loaded = {
  root: string;
  world: string;
  plan: RunPlan;
};

type AgentEvent = {
  t: number;
  kind: "reset" | "reload" | "fault" | "serial" | "serial-send" | "move-target";
  board?: string;
  text?: string;
  message?: string;
  id?: string;
  position?: [number, number, number];
  /** On a reset: `pin` when the RESET pin asserted it, absent for a brownout. */
  cause?: "pin";
};

type AgentFrame = {
  t: number;
  joints?: Record<string, { deg: number } | { m: number }>;
  parts?: Record<
    string,
    {
      pulseUs?: number | null;
      commandDeg?: number | null;
      state?: string;
      current?: number;
      /** Volts at V+ relative to GND. */
      voltage?: number;
      /** Newton-metres at the shaft. Present on a driven servo. */
      torqueNm?: number;
    }
  >;
  supplies?: Record<
    string,
    { voltage?: number; minVoltage?: number; current?: number }
  >;
  boards?: Record<
    string,
    {
      pins?: string[];
      running?: boolean;
      /** In reset at t or at any step of the window. */
      inReset?: boolean;
      /** Board node at t. */
      voltage?: number;
      /** Lowest board-node voltage in the window. */
      minVoltage?: number;
      /** Amperes through the board's onboard LED (the view's `ledPin`). Absent when that board has no LED stamp. */
      ledCurrent?: number;
    }
  >;
};

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function seconds(simTime: number): number {
  return round(simTime, 3);
}

function jointReadout(
  qpos: number,
  unit: "deg" | "m"
): { deg: number } | { m: number } {
  if (unit === "m") return { m: round(qpos, 4) };
  return { deg: round((qpos * 180) / Math.PI, 3) };
}

function capTail<T>(items: T[]): { items: T[]; truncated: boolean } {
  if (items.length <= LIST_CAP) return { items, truncated: false };
  return { items: items.slice(items.length - LIST_CAP), truncated: true };
}

/** Driven outputs, named from this board's pin list. Bit `i` is pin `i`. */
function drivenPins(
  names: readonly string[] | undefined,
  pins:
    | { ddr: number | readonly number[]; level: number | readonly number[] }
    | undefined
): string[] {
  if (!pins || !names || names.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const pin = names[i];
    if (!pin || !pinBitSet(pins.ddr, i)) continue;
    out.push(`${pin}: out ${pinBitSet(pins.level, i) ? "H" : "L"}`);
  }
  return out;
}

function pinOrdersOf(plan: RunPlan): Map<string, readonly string[]> {
  return new Map(plan.boards.map((board) => [board.id, board.pinOrder]));
}

/** Brownout and the SOA floor. Null when the chip publishes none. */
function chipBand(
  loaded: Loaded,
  id: string
): { brownout: number; floor: number; clock: ChipClock } | null {
  const board = loaded.plan.boards.find((row) => row.id === id);
  const floor = board?.minOperatingVoltage;
  if (!board || floor == null || !board.clock) return null;
  return { brownout: board.brownoutVoltage, floor, clock: board.clock };
}

function loadPlan(project: string, world: string): RunPlan | { error: string } {
  const planned = planWorld(project, world);
  if (planned.ok) return planned.plan;
  const message = planned.errors.map((error) => error.message).join("; ");
  if (message.includes(WORLD_V1_MESSAGE)) return { error: WORLD_V1_MESSAGE };
  return { error: message || "world file is not a document" };
}

/** Resolve the file and nothing else, so a bad path does not start a run. */
async function readWorld(world: string): Promise<Loaded | { error: string }> {
  const root = viewerProjectRoot();
  if (!root) return { error: "no project open" };
  const named = resolveWorldFile(root, world);
  if ("error" in named) return named;
  const plan = loadPlan(named.project, named.world);
  if ("error" in plan) return plan;
  return { root: named.project, world: named.world, plan };
}

async function openRun(world: string): Promise<Loaded | { error: string }> {
  const found = await readWorld(world);
  if ("error" in found) return found;
  const started = await ensureWorldRun(found.root, found.world);
  if ("error" in started) return started;
  return found;
}

function jointLimits(root: string, world: string, doc: RunPlan) {
  const limits = new Map<string, { lower: number; upper: number }>();
  const files = readerFor(root, world);
  for (const robot of doc.robots) {
    const bytes = files.read(robot.urdf);
    if (!bytes) continue;
    const info = extractUrdfJointsAndMeshes(new TextDecoder().decode(bytes));
    for (const joint of info.jointInfo) {
      if (joint.lower === null || joint.upper === null) continue;
      limits.set(`${robot.id}/${joint.name}`, {
        lower: joint.lower,
        upper: joint.upper,
      });
    }
  }
  return limits;
}

function documentWarnings(loaded: Loaded): string[] {
  const feeds = powerFeedsOf(loaded.plan);
  const out: string[] = [];
  for (const board of loaded.plan.boards) {
    if (feeds.boards[board.id]) continue;
    const pin = board.voltagePin;
    out.push(
      `board ${board.id}: no supply reaches its ${pin} pin. Hint: wire a supply's ${pin} pin to ${board.id}.${pin}.`
    );
  }
  return out;
}

function liveWarnings(
  loaded: Loaded,
  state: WorldState,
  documentMessages: readonly string[]
): string[] {
  const out: string[] = [];
  for (const [id, board] of Object.entries(state.boards)) {
    for (const warning of board.warnings ?? []) {
      out.push(`${id}: ${warning.message}`);
    }
  }
  const limits = jointLimits(loaded.root, loaded.world, loaded.plan);
  const units = jointUnits(loaded.root, loaded.world, loaded.plan);
  for (const [robot, names] of Object.entries(state.joints)) {
    for (const [joint, qpos] of Object.entries(names)) {
      const key = `${robot}/${joint}`;
      const limit = limits.get(key);
      if (!limit) continue;
      const kind = limitKind(units.get(key));
      const text = jointLimitWarning(
        key,
        pastLimitAmount(qpos, limit.lower, limit.upper, kind),
        kind
      );
      if (text) out.push(text);
    }
  }
  out.push(...documentMessages);
  return out;
}

function rangeWarnings(
  loaded: Loaded,
  frames: RecordingRead["frames"]
): string[] {
  const out: string[] = [];
  const soaVoltage = new Map<string, number>();
  const soaSeen = new Set<string>();
  const units = jointUnits(loaded.root, loaded.world, loaded.plan);
  const past = new Map<string, number>();
  for (const frame of frames) {
    for (const [id, board] of Object.entries(frame.boards)) {
      if (!board.belowSoa) continue;
      soaSeen.add(id);
      const band = chipBand(loaded, id);
      const row = frame.boards[id];
      if (!band || !row) continue;
      const candidate =
        row.minVoltage > band.brownout && row.minVoltage < band.floor
          ? row.minVoltage
          : row.voltage;
      const warning = soaWarning(
        candidate,
        band.brownout,
        band.floor,
        band.clock
      );
      if (!warning) continue;
      const prev = soaVoltage.get(id);
      if (prev === undefined || candidate < prev) soaVoltage.set(id, candidate);
    }
    for (const [robot, joints] of Object.entries(frame.limitDeg ?? {})) {
      for (const [joint, deg] of Object.entries(joints)) {
        const key = `${robot}/${joint}`;
        const prev = past.get(key) ?? 0;
        if (deg > prev) past.set(key, deg);
      }
    }
  }
  for (const id of soaSeen) {
    const voltage = soaVoltage.get(id);
    const band = chipBand(loaded, id);
    if (!band) continue;
    const warning =
      voltage === undefined
        ? null
        : soaWarning(voltage, band.brownout, band.floor, band.clock);
    const floor = band.floor.toFixed(2);
    const fallback = `${id}: supply was below the ${floor} V ${soaNeed(band.clock)}`;
    out.push(warning ? `${id}: ${warning.message}` : fallback);
  }
  for (const [joint, amount] of past) {
    const kind = limitKind(units.get(joint));
    const text = jointLimitWarning(joint, amount, kind);
    if (text) out.push(text);
  }
  out.push(...documentWarnings(loaded));
  return out;
}

function limitKind(unit: "deg" | "m" | undefined): JointLimitKind {
  return unit === "m" ? "slide" : "hinge";
}

function jointUnits(root: string, world: string, doc: RunPlan) {
  const units = new Map<string, "deg" | "m">();
  const files = readerFor(root, world);
  for (const robot of doc.robots) {
    const bytes = files.read(robot.urdf);
    if (!bytes) continue;
    const info = extractUrdfJointsAndMeshes(new TextDecoder().decode(bytes));
    for (const joint of info.jointInfo) {
      units.set(
        `${robot.id}/${joint.name}`,
        joint.type === "prismatic" ? "m" : "deg"
      );
    }
  }
  return units;
}

function statusOf(loaded: Loaded, stateOverride?: WorldState) {
  const view = worldRunView(loaded.root, loaded.world);
  if ("error" in view) return view;
  const state = stateOverride ?? view.state;
  const { lastCommand } = view;
  const doc = loaded.plan;
  const feeds = powerFeedsOf(doc);
  const drives = servoSignalDrives(doc);
  const units = jointUnits(loaded.root, loaded.world, doc);
  const boards: Record<
    string,
    {
      running: boolean;
      fault: string | null;
      resets: number;
      inReset: boolean;
      /** While `inReset`: `brownout` or `pin`. Absent otherwise. */
      resetCause?: ResetCause;
      pins: string[];
      /** Volts on the board node. Null when no supply reaches the board. */
      voltage: number | null;
      /** Amperes through the board's onboard LED (the view's `ledPin`). Absent when that board has no LED stamp. */
      ledCurrent?: number;
      level?: number | null;
      variant?: string | null;
      reason?: string;
    }
  > = {};
  for (const [id, board] of Object.entries(state.boards)) {
    const unpowered = board.unpowered === true || feeds.boards[id] == null;
    boards[id] = {
      running: unpowered ? false : board.running,
      fault: unpowered ? "unpowered" : (board.fault ?? null),
      resets: board.resets ?? 0,
      inReset: board.inReset === true,
      ...(board.resetCause ? { resetCause: board.resetCause } : {}),
      pins: drivenPins(
        doc.boards.find((row) => row.id === id)?.pinOrder,
        board.pins
      ),
      voltage:
        unpowered || board.voltage === undefined
          ? null
          : round(board.voltage, 3),
      ...(board.ledCurrent !== undefined
        ? { ledCurrent: round(board.ledCurrent, 6) }
        : {}),
      ...levelFields(doc, id),
    };
  }
  const parts: Record<
    string,
    {
      pulseUs: number | null;
      commandDeg: number | null;
      state: string | null;
      current: number | null;
      /** Volts at V+ relative to GND. Null when the part has no power port. */
      voltage: number | null;
      board: string | null;
      pin: string | null;
      level?: number | null;
      variant?: string | null;
      reason?: string;
    }
  > = {};
  for (const part of doc.parts) {
    const live = state.parts?.[part.id];
    const drive = drives.find((item) => item.partId === part.id);
    parts[part.id] = {
      pulseUs: live?.pulseUs == null ? null : Math.round(live.pulseUs),
      commandDeg: live?.commandDeg == null ? null : round(live.commandDeg, 2),
      state: live?.state ?? null,
      current: live?.current == null ? null : round(live.current, 4),
      voltage: live?.voltage == null ? null : round(live.voltage, 3),
      board: drive?.boardId ?? null,
      pin: drive?.pin ?? null,
      ...levelFields(doc, part.id),
    };
  }
  for (const ranger of doc.rangers ?? []) {
    const live = state.parts?.[ranger.id];
    parts[ranger.id] = {
      pulseUs: null,
      commandDeg: null,
      state: null,
      current: live?.current == null ? null : round(live.current, 4),
      voltage: live?.voltage == null ? null : round(live.voltage, 3),
      board: ranger.trig?.boardId ?? null,
      pin: null,
      ...levelFields(doc, ranger.id),
    };
  }
  const supplies: Record<
    string,
    {
      voltage: number;
      current: number;
      level?: number | null;
      variant?: string | null;
      reason?: string;
      axes?: {
        axis: string;
        class: number | null;
        variant: string | null;
        reason: string;
      }[];
    }
  > = {};
  for (const supply of doc.supplies) {
    const live = state.supplies?.[supply.id];
    supplies[supply.id] = {
      voltage: round(live?.voltage ?? supply.voltage, 3),
      current: round(live?.current ?? 0, 4),
      ...levelFields(doc, supply.id),
    };
  }
  const joints: Record<string, { deg: number } | { m: number }> = {};
  for (const [robot, names] of Object.entries(state.joints)) {
    for (const [joint, qpos] of Object.entries(names)) {
      const key = `${robot}/${joint}`;
      joints[key] = jointReadout(qpos, units.get(key) ?? "deg");
    }
  }
  const notes = documentWarnings(loaded);
  const diagnostics = notes.map((message) => ({
    level: "warning" as const,
    code: "no-supply",
    path: "",
    message,
  }));
  return {
    simTime: seconds(state.simTime),
    playing: state.playing,
    lastCommand,
    boards,
    parts,
    supplies,
    joints,
    recording: state.recording
      ? {
          id: state.recording.id,
          from: seconds(state.recording.from),
          to: seconds(state.recording.to),
        }
      : null,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    warnings: liveWarnings(loaded, state, notes),
  };
}

function coveredPaths(
  report: NonNullable<RunPlan["report"]>,
  scope: "default" | "type" | "path",
  key: string | undefined
): Set<string> {
  const paths = new Set<string>();
  for (const row of report.levels) {
    if (scope === "default" || (scope === "path" && row.path === key)) {
      paths.add(row.path);
    }
    if (scope === "type" && row.type === key) paths.add(row.path);
  }
  return paths;
}

function levelRows(report: NonNullable<RunPlan["report"]>, paths: Set<string>) {
  return report.levels
    .filter((row) => paths.has(row.path))
    .map((row) => {
      const snap = report.snapshots.find(
        (item) => item.path === row.path && item.axis === row.axis
      );
      const line =
        row.class === null
          ? `${row.axis} none`
          : `${row.axis} ${row.class} · ${row.variant ?? "—"}`;
      return {
        path: row.path,
        axis: row.axis,
        class: row.class,
        variant: row.variant,
        line,
        reason: row.reason,
        ...(snap ? { snapshot: { ref: snap.ref, quality: snap.quality } } : {}),
      };
    });
}

function levelFields(doc: RunPlan, path: string) {
  const rows = (doc.levels ?? []).filter((item) => item.path === path);
  if (rows.length === 0) return {};
  const behaviour = rows.find((item) => item.axis === "behaviour");
  return {
    ...(behaviour
      ? {
          level: behaviour.class,
          variant: behaviour.variant,
          reason: behaviour.reason,
        }
      : {}),
    axes: rows.map((item) => ({
      axis: item.axis,
      class: item.class,
      variant: item.variant,
      reason: item.reason,
    })),
  };
}

function clampFrames(maxFrames: number | undefined): number {
  if (maxFrames === undefined) return DEFAULT_MAX_FRAMES;
  if (!Number.isInteger(maxFrames) || maxFrames < 1) return DEFAULT_MAX_FRAMES;
  return Math.min(MAX_FRAMES, maxFrames);
}

function jointSelected(trackId: string, request: string): boolean {
  const name = trackId.slice("joint:".length);
  return name === request || name.endsWith(`/${request}`);
}

type FieldMap = Map<string, Set<string> | "all">;

function addField(
  map: FieldMap,
  id: string,
  field: string | undefined,
  known: Set<string>
) {
  if (field && !known.has(field)) return;
  if (!field) {
    map.set(id, "all");
    return;
  }
  const prev = map.get(id);
  if (prev === "all") return;
  if (prev) prev.add(field);
  else map.set(id, new Set([field]));
}

function trackKnown(
  doc: RunPlan,
  jointKeys: Set<string>,
  track: string
): boolean {
  if (track.startsWith("joint:")) {
    const joint = /^joint:([^./]+(?:\/[^./]+)?)$/.exec(track);
    const request = joint?.[1];
    if (!request) return false;
    if (jointKeys.has(request)) return true;
    for (const key of jointKeys) {
      const slash = key.lastIndexOf("/");
      if (slash >= 0 && key.slice(slash + 1) === request) return true;
    }
    return false;
  }
  const part = /^part:([^./]+)(?:\.([A-Za-z0-9]+))?$/.exec(track);
  if (track.startsWith("part:")) {
    if (!part?.[1]) return false;
    if (!doc.parts.some((item) => item.id === part[1])) return false;
    return !part[2] || PART_FIELDS.has(part[2]);
  }
  const supply = /^supply:([^./]+)(?:\.([A-Za-z0-9]+))?$/.exec(track);
  if (track.startsWith("supply:")) {
    if (!supply?.[1]) return false;
    if (!doc.supplies.some((item) => item.id === supply[1])) return false;
    return !supply[2] || SUPPLY_FIELDS.has(supply[2]);
  }
  const board = /^board:([^./]+)(?:\.([A-Za-z0-9]+))?$/.exec(track);
  if (track.startsWith("board:")) {
    if (!board?.[1]) return false;
    if (!doc.boards.some((item) => item.id === board[1])) return false;
    return !board[2] || BOARD_FIELDS.has(board[2]);
  }
  return false;
}

function rejectTracks(
  loaded: Loaded,
  tracks: string[] | undefined
): { error: string } | null {
  if (!tracks || tracks.length === 0) return null;
  const jointKeys = new Set(
    jointUnits(loaded.root, loaded.world, loaded.plan).keys()
  );
  for (const track of tracks) {
    if (!trackKnown(loaded.plan, jointKeys, track)) {
      return { error: `unknown track "${track}"` };
    }
  }
  return null;
}

function selectTracks(tracks: string[] | undefined, catalog: RecordingTracks) {
  if (!tracks || tracks.length === 0) {
    return {
      filtered: false,
      recorder: undefined as string[] | undefined,
      joints: null as Set<string> | null,
      parts: null as FieldMap | null,
      supplies: null as FieldMap | null,
      boards: null as FieldMap | null,
    };
  }
  const joints = new Set<string>();
  const parts: FieldMap = new Map();
  const supplies: FieldMap = new Map();
  const boards: FieldMap = new Map();
  const recorder: string[] = [];
  for (const track of tracks) {
    if (track.startsWith("joint:")) {
      const request = track.slice("joint:".length);
      joints.add(request);
      for (const id of catalog.joints) {
        if (jointSelected(id, request)) recorder.push(id);
      }
      continue;
    }
    const part = /^part:([^./]+)(?:\.(.+))?$/.exec(track);
    if (part?.[1]) {
      addField(parts, part[1], part[2], PART_FIELDS);
      const id = partTrackId(part[1]);
      if (catalog.parts.includes(id)) recorder.push(id);
      continue;
    }
    const supply = /^supply:([^./]+)(?:\.(.+))?$/.exec(track);
    if (supply?.[1]) {
      addField(supplies, supply[1], supply[2], SUPPLY_FIELDS);
      const id = supplyTrackId(supply[1]);
      if (catalog.supplies.includes(id)) recorder.push(id);
      continue;
    }
    const board = /^board:([^./]+)(?:\.(.+))?$/.exec(track);
    if (board?.[1]) {
      addField(boards, board[1], board[2], BOARD_FIELDS);
      const id = boardTrackId(board[1]);
      if (catalog.boards.includes(id)) recorder.push(id);
    }
  }
  return {
    filtered: true,
    recorder: [...new Set(recorder)],
    joints,
    parts,
    supplies,
    boards,
  };
}

function wantsJoint(
  selected: Set<string> | null,
  robot: string,
  joint: string
): boolean {
  if (!selected) return true;
  const key = `${robot}/${joint}`;
  for (const request of selected) {
    if (request === joint || request === key || key.endsWith(`/${request}`)) {
      return true;
    }
  }
  return false;
}

function trimFrame(
  frame: RecordingRead["frames"][number],
  selected: ReturnType<typeof selectTracks>,
  units: Map<string, "deg" | "m">,
  pinOrders: ReadonlyMap<string, readonly string[]>
): AgentFrame {
  const out: AgentFrame = { t: seconds(frame.t) };
  const joints: NonNullable<AgentFrame["joints"]> = {};
  for (const [robot, names] of Object.entries(frame.joints)) {
    for (const [joint, qpos] of Object.entries(names)) {
      if (selected.filtered && !wantsJoint(selected.joints, robot, joint)) {
        continue;
      }
      const key = `${robot}/${joint}`;
      joints[key] = jointReadout(qpos, units.get(key) ?? "deg");
    }
  }
  if (Object.keys(joints).length > 0) out.joints = joints;

  const parts: NonNullable<AgentFrame["parts"]> = {};
  for (const [id, row] of Object.entries(frame.parts)) {
    const fields = selected.parts?.get(id);
    if (selected.filtered && !fields) continue;
    const all = !fields || fields === "all";
    const part: NonNullable<AgentFrame["parts"]>[string] = {};
    if (all || fields.has("pulseUs")) part.pulseUs = row.pulseUs;
    if (all || fields.has("commandDeg")) part.commandDeg = row.commandDeg;
    if (all || fields.has("state")) part.state = row.state;
    if (all || fields.has("current")) part.current = row.current;
    if (all || fields.has("voltage")) part.voltage = row.voltage;
    if ((all || fields.has("torqueNm")) && row.torqueNm !== undefined) {
      part.torqueNm = row.torqueNm;
    }
    parts[id] = part;
  }
  if (Object.keys(parts).length > 0) out.parts = parts;

  const supplies: NonNullable<AgentFrame["supplies"]> = {};
  for (const [id, row] of Object.entries(frame.supplies)) {
    const fields = selected.supplies?.get(id);
    if (selected.filtered && !fields) continue;
    const all = !fields || fields === "all";
    const supply: NonNullable<AgentFrame["supplies"]>[string] = {};
    if (all || fields.has("voltage") || fields.has("minVoltage")) {
      if (all || fields.has("voltage")) supply.voltage = row.voltage;
      supply.minVoltage = row.minVoltage;
    }
    if (all || fields.has("current")) supply.current = row.current;
    supplies[id] = supply;
  }
  if (Object.keys(supplies).length > 0) out.supplies = supplies;

  const boards: NonNullable<AgentFrame["boards"]> = {};
  for (const [id, row] of Object.entries(frame.boards)) {
    const fields = selected.boards?.get(id);
    if (selected.filtered && !fields) continue;
    const all = !fields || fields === "all";
    const board: NonNullable<AgentFrame["boards"]>[string] = {};
    if (all || fields.has("pins")) {
      board.pins = drivenPins(pinOrders.get(id), row.pins);
    }
    if (all || fields.has("running")) board.running = row.running;
    if (all || fields.has("inReset")) {
      board.inReset = row.inReset || row.inResetAny;
    }
    if (all || fields.has("voltage") || fields.has("minVoltage")) {
      if (all || fields.has("voltage")) board.voltage = row.voltage;
      if (all || fields.has("minVoltage")) board.minVoltage = row.minVoltage;
    }
    if (row.ledCurrent !== undefined && (all || fields.has("ledCurrent"))) {
      board.ledCurrent = row.ledCurrent;
    }
    boards[id] = board;
  }
  if (Object.keys(boards).length > 0) out.boards = boards;
  return out;
}

function isSerial(
  event: RecordingEvent
): event is Extract<RecordingEvent, { kind: "serial" | "serial-send" }> {
  return event.kind === "serial" || event.kind === "serial-send";
}

function capSerial(events: RecordingEvent[]): {
  events: RecordingEvent[];
  truncated: boolean;
} {
  let total = 0;
  for (const event of events) {
    if (isSerial(event)) total += event.text.length;
  }
  if (total <= SERIAL_CAP) return { events, truncated: false };
  let budget = SERIAL_CAP;
  const drop = new Set<RecordingEvent>();
  const sliced = new Map<RecordingEvent, string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || !isSerial(event)) continue;
    if (budget <= 0) {
      drop.add(event);
      continue;
    }
    if (event.text.length <= budget) {
      budget -= event.text.length;
      continue;
    }
    sliced.set(event, event.text.slice(event.text.length - budget));
    budget = 0;
  }
  const next = events.flatMap((event) => {
    if (drop.has(event)) return [];
    const text = sliced.get(event);
    if (text === undefined || !isSerial(event)) return [event];
    return [{ ...event, text }];
  });
  return { events: next, truncated: true };
}

function agentEvents(events: RecordingEvent[]): {
  events: AgentEvent[];
  truncated: boolean;
} {
  const kept = events.filter(
    (event) =>
      event.kind === "reset" ||
      event.kind === "reload" ||
      event.kind === "fault" ||
      event.kind === "move-target" ||
      isSerial(event)
  );
  const capped = capSerial(kept);
  const slim: AgentEvent[] = [];
  for (const event of capped.events) {
    if (event.kind === "reset") {
      slim.push(
        event.cause
          ? {
              t: event.t,
              kind: "reset",
              board: event.board,
              cause: event.cause,
            }
          : { t: event.t, kind: "reset", board: event.board }
      );
    } else if (event.kind === "reload") {
      slim.push({ t: event.t, kind: event.kind, board: event.board });
    } else if (event.kind === "fault") {
      slim.push({
        t: event.t,
        kind: event.kind,
        board: event.board,
        message: event.message,
      });
    } else if (event.kind === "move-target") {
      slim.push({
        t: event.t,
        kind: event.kind,
        id: event.id,
        position: event.position,
      });
    } else if (isSerial(event)) {
      slim.push({
        t: event.t,
        kind: event.kind,
        board: event.board,
        text: event.text,
      });
    }
  }
  return { events: slim, truncated: capped.truncated };
}

async function readWindow(
  loaded: Loaded,
  query: {
    from?: number;
    to?: number;
    tracks?: string[];
    maxFrames?: number;
    everyFrame?: boolean;
  }
): Promise<
  | {
      id: string;
      from: number;
      to: number;
      frameMs: number;
      frames: AgentFrame[];
      raw: RecordingRead;
      events: AgentEvent[];
      truncated: boolean;
      manifest: RecordingManifest;
      warnings: string[];
    }
  | { error: string }
> {
  const info = await recordingInfo(loaded.root, loaded.world);
  if ("error" in info) return info;
  const to = query.to ?? info.to;
  const from = query.from ?? Math.max(info.from, to - DEFAULT_WINDOW_S);
  const selected = selectTracks(query.tracks, info.tracks);
  const maxFrames = query.everyFrame
    ? Math.ceil((Math.max(0, to - from) * 1000) / RECORD_FRAME_MS) + 2
    : clampFrames(query.maxFrames);
  const read = await readRecording(loaded.root, loaded.world, {
    from,
    to,
    maxFrames,
    ...(selected.recorder && selected.recorder.length > 0
      ? { tracks: selected.recorder }
      : {}),
  });
  if ("error" in read) return read;
  const units = jointUnits(loaded.root, loaded.world, loaded.plan);
  const pinOrders = pinOrdersOf(loaded.plan);
  const serial = agentEvents(read.events);
  const events = capTail(serial.events);
  return {
    id: read.id,
    from,
    to,
    frameMs: read.frameMs,
    frames: read.frames.map((frame) =>
      trimFrame(frame, selected, units, pinOrders)
    ),
    raw: read,
    events: events.items,
    truncated: serial.truncated || events.truncated,
    manifest: info.manifest,
    warnings: rangeWarnings(loaded, read.frames),
  };
}

type PulseRun = {
  pulseUs: number;
  commandDeg: number | null;
  from: number;
  to: number;
};

function collapsePulses(
  frames: RecordingRead["frames"],
  part: string
): PulseRun[] {
  const runs: PulseRun[] = [];
  let open: PulseRun | null = null;
  const close = () => {
    if (!open) return;
    runs.push({
      ...open,
      pulseUs: Math.round(open.pulseUs),
      commandDeg: open.commandDeg == null ? null : round(open.commandDeg, 2),
      from: seconds(open.from),
      to: seconds(open.to),
    });
    open = null;
  };
  for (const frame of frames) {
    const row = frame.parts[part];
    const pulse = row?.pulseUs;
    if (pulse == null) {
      close();
      continue;
    }
    if (open && Math.abs(open.pulseUs - pulse) <= 1) {
      open.to = frame.t;
      continue;
    }
    close();
    const command = row?.commandDeg ?? commandDegFromPulse(pulse);
    open = {
      pulseUs: pulse,
      commandDeg: command,
      from: frame.t,
      to: frame.t,
    };
  }
  close();
  return runs;
}

function commandAck(view: {
  state: WorldState;
  lastCommand: { command: "play" | "pause"; by: WorldSender } | null;
}) {
  return {
    playing: view.state.playing,
    simTime: seconds(view.state.simTime),
    lastCommand: view.lastCommand,
  };
}

/**
 * What the agent reads when an edit, undo, or redo did not finish. A run
 * fault means the file was written and the history moved; only the
 * restart after it failed. A refusal changed nothing.
 */
export function editFailure(
  failed: EditError
): Omit<EditError, "runFault"> & { written?: true } {
  if (failed.runFault) {
    return {
      error: `The file was written, but the run did not restart: ${failed.error}`,
      written: true,
    };
  }
  return failed;
}

export const worldTools = {
  world_status: tool({
    description: `Read a world's shared run. ${WORLD_ARG} Returns sim time, who last played or paused, each board (running, fault, resets, inReset and, while in reset, resetCause "brownout" or "pin", voltage on its board node, ledCurrent in amperes through its onboard LED when that board stamps one (D13 on the Nano, RXLED on the Pro Micro), driven pins such as "D9: out H", and behaviour level, variant, and reason), each part including a ranger (pulseUs, commandDeg, state, current, voltage at V+ relative to GND, board, pin, and behaviour level, variant, and reason), each supply (terminal voltage and current, and behaviour level, variant, and reason), each joint in degrees or metres, the recording extent, validator diagnostics when the document has any, and warnings (empty when none). warnings names a board whose node is above its brownout but below its chip's minimum operating voltage at its clock, a hinge more than 1° or a slide more than 1 mm past its limit, and validator warnings. A board no supply reaches has fault "unpowered" and voltage null. boards, parts, and supplies also list axes: behaviour, body, and visual, each with class, variant, and reason.`,
    inputSchema: z.object({ world: z.string() }),
    execute: async ({ world }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      return statusOf(found);
    },
  }),
  world_play: tool({
    description: `Play a world's shared run. ${WORLD_ARG} The sender is the agent, so every client shows agent. The last play or pause wins.`,
    inputSchema: z.object({ world: z.string() }),
    execute: async ({ world }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const played = await playWorld(found.root, found.world, AGENT);
      if ("error" in played) return played;
      const view = worldRunView(found.root, found.world);
      if ("error" in view) return view;
      return commandAck(view);
    },
  }),
  world_pause: tool({
    description: `Pause a world's shared run. ${WORLD_ARG} The sender is the agent, so every client shows agent. The last play or pause wins.`,
    inputSchema: z.object({ world: z.string() }),
    execute: async ({ world }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const paused = await pauseWorld(found.root, found.world, AGENT);
      if ("error" in paused) return paused;
      const view = worldRunView(found.root, found.world);
      if ("error" in view) return view;
      return commandAck(view);
    },
  }),
  world_step: tool({
    description: `Pause the run if it is playing, then advance exactly ms of sim time (a whole number from 1 to 10000). ${WORLD_ARG} The sender is the agent. Returns world_status at the sim time that this step produced.`,
    inputSchema: z.object({
      world: z.string(),
      ms: z.number(),
    }),
    execute: async ({ world, ms }) => {
      const bad = rejectWorldStep(ms);
      if (bad) return bad;
      const found = await openRun(world);
      if ("error" in found) return found;
      const stepped = await stepWorld(found.root, found.world, ms, AGENT);
      if ("error" in stepped) return stepped;
      return statusOf(found, stepped.state);
    },
  }),
  read_recording: tool({
    description: `Read a world's recording for an agent. ${WORLD_ARG} Tracks look like joint:shoulder, joint:arm/shoulder, part:servo.pulseUs, part:servo.voltage, part:servo.torqueNm (newton-metres at the shaft, driven servos only), supply:usb.voltage (the terminal), and board:uno.voltage (the board node) or board:uno.pins. An unknown track is an error. Defaults to the last 5 seconds and 50 frames (max 500). Returns those tracks, plus resets (cause "pin" when the RESET pin held the chip, absent for a brownout), reloads, faults, and serial lines (at most 200), a provenance manifest, and warnings (empty when none). warnings cover the range: a board whose node was above its brownout but below its chip's minimum operating voltage, a hinge more than 1° or a slide more than 1 mm past its limit, and validator warnings. Serial text is the last 4000 characters. truncated is set when either cap drops data.`,
    inputSchema: z.object({
      world: z.string(),
      from: z.number().optional(),
      to: z.number().optional(),
      tracks: z.array(z.string()).optional(),
      maxFrames: z.number().optional(),
    }),
    execute: async ({ world, from, to, tracks, maxFrames }) => {
      const found = await readWorld(world);
      if ("error" in found) return found;
      const badTrack = rejectTracks(found, tracks);
      if (badTrack) return badTrack;
      const started = await ensureWorldRun(found.root, found.world);
      if ("error" in started) return started;
      const read = await readWindow(found, { from, to, tracks, maxFrames });
      if ("error" in read) return read;
      return {
        id: read.id,
        from: read.from,
        to: read.to,
        frameMs: read.frameMs,
        frames: read.frames,
        events: read.events,
        truncated: read.truncated,
        manifest: read.manifest,
        warnings: read.warnings,
      };
    },
  }),
  read_pulses: tool({
    description: `Read one servo's pulse widths from the recording. ${WORLD_ARG} part is the part id. Defaults to the last 5 seconds. Collapses runs of equal width within 1 µs and returns each run's pulseUs, mapped commandDeg, and first and last sim time, plus the board and pin. At most 200 runs; truncated is set when older runs were dropped.`,
    inputSchema: z.object({
      world: z.string(),
      part: z.string(),
      from: z.number().optional(),
      to: z.number().optional(),
    }),
    execute: async ({ world, part, from, to }) => {
      const found = await readWorld(world);
      if ("error" in found) return found;
      if (!found.plan.parts.some((item) => item.id === part)) {
        return { error: `no part "${part}"` };
      }
      const started = await ensureWorldRun(found.root, found.world);
      if ("error" in started) return started;
      const read = await readWindow(found, {
        from,
        to,
        tracks: [`part:${part}`],
        everyFrame: true,
      });
      if ("error" in read) return read;
      const drive = servoSignalDrives(found.plan).find(
        (item) => item.partId === part
      );
      const pulses = capTail(collapsePulses(read.raw.frames, part));
      return {
        part,
        board: drive?.boardId ?? null,
        pin: drive?.pin ?? null,
        from: read.from,
        to: read.to,
        pulses: pulses.items,
        truncated: pulses.truncated,
      };
    },
  }),
  world_move_target: tool({
    description: `Move an environment target to position (metres) from the next master step. ${WORLD_ARG} id is the target's id. The move is recorded. A target with only a path is unchanged until this is called. Dragging in the view is not this tool.`,
    inputSchema: z.object({
      world: z.string(),
      id: z.string(),
      position: z.tuple([z.number(), z.number(), z.number()]),
    }),
    execute: async ({ world, id, position }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const known = found.plan.environment.targets.some(
        (target) => target.id === id
      );
      if (!known) return { error: `no target "${id}"` };
      if (!position.every((n) => Number.isFinite(n))) {
        return { error: "position is not finite" };
      }
      const moved = moveWorldTarget(found.root, found.world, id, position);
      if ("error" in moved) return moved;
      return { id, position: [position[0], position[1], position[2]] };
    },
  }),
  world_edit: tool({
    description: `Change one part through typed edit operations, as one undo step, then restart the run. ${WORLD_ARG} part is a part id inside that world; the root is the default. ops is add-instance, remove-instance, set-pose, set-param, set-level, wire, unwire, rename-instance, rename-part, set-play, or a batch of those. Each op's document is the part's path. A catalog part is read-only. break: true applies an edit that drops fixed ports. Without it, removing a fixed port changes nothing and the sentence says to send it again. Returns what changed and whether undo is available.`,
    inputSchema: z.object({
      world: z.string(),
      ops: z.array(z.record(z.string(), z.unknown())).min(1),
      label: z.string().optional(),
      part: z.string().optional(),
      break: z.boolean().optional(),
    }),
    execute: async ({ world, ops, label, part, break: breaking }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      // The socket's own edit schema; an op without a document edits the
      // part this call names.
      const request = parseEditRequest({
        type: "edit",
        ops: ops.map((item) => ({
          ...item,
          document:
            typeof item.document === "string"
              ? item.document
              : (part ?? found.world),
        })),
        ...(label !== undefined ? { label } : {}),
        ...(part !== undefined ? { part } : {}),
        ...(breaking ? { confirm: "break" } : {}),
      });
      if ("error" in request) return request;
      const applied = await applyDocumentEdit(
        found.root,
        found.world,
        request.ops,
        request.label,
        request.part,
        request.confirm
      );
      if ("needsConfirm" in applied) return confirmSentence(applied.ports);
      if ("error" in applied) return editFailure(applied);
      return applied.sentence;
    },
  }),
  world_undo: tool({
    description: `Undo the last edit of one part, then restart the run. ${WORLD_ARG} part is a part id; the root is the default. Refuses when a file in the step changed outside this session.`,
    inputSchema: z.object({
      world: z.string(),
      part: z.string().optional(),
    }),
    execute: async ({ world, part }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const applied = await undoDocument(found.root, found.world, part);
      if ("error" in applied) return editFailure(applied);
      return applied.sentence;
    },
  }),
  world_redo: tool({
    description: `Redo the last undone edit of one part, then restart the run. ${WORLD_ARG} part is a part id; the root is the default.`,
    inputSchema: z.object({
      world: z.string(),
      part: z.string().optional(),
    }),
    execute: async ({ world, part }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const applied = await redoDocument(found.root, found.world, part);
      if ("error" in applied) return editFailure(applied);
      return applied.sentence;
    },
  }),
  world_set_level: tool({
    description: `Set or remove one level rule in the open world file, then restart the run. ${WORLD_ARG} scope is default, type, or path. key is the part type or the instance path (nano, fleet.rig2.servo); default takes no key. axis is behaviour, body, or visual; omit it and the class applies to all three. class is 0, 1, 2, 3, or null. null removes that rule. variant, with an axis, writes { class, variant } on that axis. The default cannot be removed. A type or path that is not in the loaded world is an error and the file is left unchanged. Returns the new level rows for the instances that rule covers, including a snapshot when one ran.`,
    inputSchema: z.object({
      world: z.string(),
      scope: z.enum(["default", "type", "path"]),
      key: z.string().optional(),
      axis: z.enum(["behaviour", "body", "visual"]).optional(),
      class: z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.null(),
      ]),
      variant: z.string().min(1).optional(),
    }),
    execute: async ({ world, scope, key, axis, class: level, variant }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const report = found.plan.report;
      if (!report) return { error: "this world has no run report" };
      const knownPaths = new Set(report.levels.map((row) => row.path));
      const knownTypes = new Set(report.levels.map((row) => row.type));
      if (scope === "path" && key && !knownPaths.has(key)) {
        return { error: `no path "${key}"` };
      }
      if (scope === "type" && key && !knownTypes.has(key)) {
        return { error: `no type "${key}"` };
      }
      const applied = await applyDocumentEdit(found.root, found.world, [
        {
          kind: "set-level",
          document: found.world,
          scope,
          ...(key !== undefined ? { key } : {}),
          ...(axis !== undefined ? { axis } : {}),
          ...(variant !== undefined ? { variant } : {}),
          class: level,
        },
      ]);
      if ("needsConfirm" in applied)
        return { error: confirmSentence(applied.ports) };
      if ("error" in applied) return editFailure(applied);
      return {
        rows: levelRows(
          applied.report,
          coveredPaths(applied.report, scope, key)
        ),
      };
    },
  }),
  world_restart: tool({
    description: `Start a world's run over from sim time 0, paused, with a new recording. ${WORLD_ARG} Reloads the document the way a file edit does, without writing it. Returns world_status.`,
    inputSchema: z.object({ world: z.string() }),
    execute: async ({ world }) => {
      const found = await openRun(world);
      if ("error" in found) return found;
      const restarted = await restartWorld(found.root, found.world);
      if ("error" in restarted) return restarted;
      return statusOf(found);
    },
  }),
};
