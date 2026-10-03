/**
 * Columnar recording of one world run. The worker calls `commit` once per
 * simulated millisecond. A frame is written every 10 ms and covers (t−10 ms, t]:
 * the value at t, plus the minimum terminal and board-node voltage, the
 * maximum current, the worst part state, any reset, any out-of-SOA
 * supply, and the furthest a joint passed its limit in that window.
 * A 1 ms dip therefore lands on the frame that closes the window.
 *
 * Storage is typed-array chunks. Queries copy out plain objects. Downsampling
 * picks real frames and widens those window fields across the frames it skips.
 * Pin masks and poses are copied from the picked frame and never blended.
 */

import {
  boardTrackId,
  bodyTrackId,
  jointTrackId,
  partTrackId,
  RECORD_BOUND_MS,
  RECORD_FRAME_MS,
  type RecordedFrame,
  type RecordingEvent,
  type RecordingInfo,
  type RecordingManifest,
  type RecordingRead,
  type RecordingSummary,
  type RecordingTracks,
  supplyTrackId,
  type TimelineMarker,
  type TimelineTrack,
  type WorldPartMotion,
  type WorldPinState,
  type WorldSender,
} from "@sfab-bench/contract";

/** Frames kept in one typed-array block. 256 × 10 ms is 2.56 s. */
const CHUNK = 256;

const MOTION_NAME = ["idle", "moving", "stall"] as const;

export function motionRank(state: WorldPartMotion): number {
  if (state === "stall") return 2;
  if (state === "moving") return 1;
  return 0;
}

function motionName(rank: number): WorldPartMotion {
  return MOTION_NAME[rank] ?? "idle";
}

/**
 * Bytes of frame storage for one minute of sim time, channels only.
 * Measured from the chunk layout, so a new column is counted. A chunk may
 * hold a little more until its front is dropped. Events sit beside this
 * and are not counted.
 */
export function recordingFootprint(counts: ChunkCounts): {
  bytesPerFrame: number;
  bytesPerMinute: number;
} {
  let bytes = 0;
  for (const column of Object.values(createChunk(counts))) {
    if (ArrayBuffer.isView(column)) bytes += column.byteLength;
  }
  const bytesPerFrame = bytes / CHUNK;
  const framesPerMinute = 60_000 / RECORD_FRAME_MS;
  return {
    bytesPerFrame,
    bytesPerMinute: bytesPerFrame * framesPerMinute,
  };
}

export type RecordSpec = {
  id: string;
  boundMs?: number;
  manifest: RecordingManifest;
  joints: { robot: string; joint: string }[];
  bodies: { robot: string; link: string }[];
  parts: string[];
  /** Parallel to `parts`. True when that part records a ranger reading. */
  partRanger?: boolean[];
  supplies: string[];
  boards: string[];
  /**
   * Words of pin state per board. Absent is one word, the layout a board
   * of at most 32 pins has always used.
   */
  pinWords?: number[];
  /** Parallel to `boards`. True when that board records `leds[onboardLedPath(id)]`. */
  boardLed?: boolean[];
  /** LED paths on each board. Each frame stores that LED's mean current. */
  leds?: { board: string; path: string }[];
};

type Chunk = {
  start: number;
  count: number;
  tMs: Uint32Array;
  joint: Float32Array;
  limitDeg: Float32Array;
  pose: Float32Array;
  pulse: Float32Array;
  command: Float32Array;
  state: Uint8Array;
  worst: Uint8Array;
  partCurrent: Float32Array;
  partMax: Float32Array;
  partVoltage: Float32Array;
  /** NaN when that part has no driven motor. */
  partTorque: Float32Array;
  voltage: Float32Array;
  minVoltage: Float32Array;
  supplyCurrent: Float32Array;
  supplyMax: Float32Array;
  /** NaN when that supply has no state of charge. */
  supplySoc: Float32Array;
  boardVoltage: Float32Array;
  boardMinVoltage: Float32Array;
  regulatorA: Float32Array;
  regulatorMax: Float32Array;
  /** Null when no board on this run records D13 LED current. */
  boardLed: Float32Array | null;
  /** Null when this run stamps no LED. One sample per `ledPaths` entry. */
  leds: Float32Array | null;
  /** Null when no part on this run is a ranger. Metres; NaN is no echo. */
  rangerDistance: Float32Array | null;
  /** 1 when the last trigger hit. Null when no part is a ranger. */
  rangerHit: Uint8Array | null;
  ddr: Uint32Array;
  level: Uint32Array;
  toggled: Uint32Array;
  running: Uint8Array;
  inReset: Uint8Array;
  inResetAny: Uint8Array;
  belowSoa: Uint8Array;
};

type StoredEvent = {
  timeMs: number;
  kind: RecordingEvent["kind"];
  board?: string;
  text?: string;
  from?: number;
  to?: number;
  message?: string;
  by?: WorldSender;
  id?: string;
  position?: [number, number, number];
  cause?: "pin";
};

type Slot = { chunk: Chunk; slot: number; timeMs: number };

function channel(index: number, slot: number): number {
  return index * CHUNK + slot;
}

export type RecordingQuery = {
  from: number;
  to: number;
  tracks?: string[];
  maxFrames?: number;
};

export class RunRecorder {
  readonly id: string;
  enabled = true;
  /** Filled by the worker before `commit`. Ranks are idle 0, moving 1, stall 2. */
  readonly joint: Float64Array;
  readonly pose: Float64Array;
  readonly pulse: Float64Array;
  readonly command: Float64Array;
  readonly state: Uint8Array;
  readonly partCurrent: Float64Array;
  /** Volts at V+ relative to GND. */
  readonly partVoltage: Float64Array;
  /** Newton-metres at the shaft. NaN when that part has no driven motor. */
  readonly partTorque: Float64Array;
  readonly voltage: Float64Array;
  readonly supplyCurrent: Float64Array;
  /** NaN when that supply has no state of charge. */
  readonly supplySoc: Float64Array;
  /** Volts on each board's 5V node. */
  readonly boardVoltage: Float64Array;
  /** Regulator pass current into that node. */
  readonly regulatorA: Float64Array;
  /** Amperes through each board's onboard LED. Read only where `ledOn` is set. */
  readonly ledCurrent: Float64Array;
  /** True when this board's frames carry `ledCurrent`. */
  readonly ledOn: readonly boolean[];
  /** LED instance paths, in record order. */
  readonly ledPaths: readonly { board: string; path: string }[];
  /** Forward current of each `ledPaths` entry, amperes. */
  readonly ledAmps: Float64Array;
  readonly ddr: Uint32Array;
  readonly level: Uint32Array;
  readonly toggled: Uint32Array;
  readonly running: Uint8Array;
  readonly inReset: Uint8Array;
  /** 1 when this step's supply is in the 16 MHz out-of-SOA band. */
  readonly belowSoa: Uint8Array;
  /** Degrees past the joint limit at this step. The frame keeps the max. */
  readonly pastLimit: Float64Array;
  /** Metres. Null when this run has no ranger. */
  readonly rangerDistance: Float64Array | null;
  /** 1 on a hit. Null when this run has no ranger. */
  readonly rangerHit: Uint8Array | null;

  private boundMs: number;
  readonly manifest: RecordingManifest;
  private readonly joints: { robot: string; joint: string; id: string }[];
  private readonly bodies: { robot: string; link: string; id: string }[];
  private readonly parts: { id: string; track: string }[];
  private readonly partRanger: boolean[];
  private readonly hasRanger: boolean;
  private readonly supplies: { id: string; track: string }[];
  private readonly boards: { id: string; track: string }[];
  /** Words stored for each board. One while every board has at most 32 pins. */
  private readonly pinWords: readonly number[];
  /** Max of `pinWords`. Channel `board * pinStride + word` is that word. */
  private readonly pinStride: number;
  private readonly minV: Float64Array;
  private readonly maxSupply: Float64Array;
  private readonly minBoardV: Float64Array;
  private readonly maxRegulator: Float64Array;
  private readonly worst: Uint8Array;
  private readonly partMax: Float64Array;
  private readonly inResetAny: Uint8Array;
  private readonly soaAny: Uint8Array;
  private readonly pastMax: Float64Array;
  private readonly chunks: Chunk[] = [];
  private readonly events: StoredEvent[] = [];
  private eventStart = 0;
  private serialNext = new Map<string, number>();
  private lastCommitMs = -1;
  private dropped = false;
  private keptFromMs = 0;

  constructor(spec: RecordSpec) {
    this.id = spec.id;
    this.manifest = spec.manifest;
    this.boundMs = spec.boundMs ?? RECORD_BOUND_MS;
    this.joints = spec.joints.map((item) => ({
      ...item,
      id: jointTrackId(item.robot, item.joint),
    }));
    this.bodies = spec.bodies.map((item) => ({
      ...item,
      id: bodyTrackId(item.robot, item.link),
    }));
    this.parts = spec.parts.map((id) => ({ id, track: partTrackId(id) }));
    this.partRanger = spec.partRanger ?? spec.parts.map(() => false);
    this.hasRanger = this.partRanger.some(Boolean);
    this.supplies = spec.supplies.map((id) => ({
      id,
      track: supplyTrackId(id),
    }));
    this.boards = spec.boards.map((id) => ({ id, track: boardTrackId(id) }));
    this.pinWords = spec.boards.map((_, index) =>
      Math.max(1, spec.pinWords?.[index] ?? 1)
    );
    this.pinStride = this.pinWords.reduce(
      (max, words) => Math.max(max, words),
      1
    );
    const nJ = this.joints.length;
    const nB = this.bodies.length;
    const nP = this.parts.length;
    const nS = this.supplies.length;
    const nD = this.boards.length;
    this.joint = new Float64Array(nJ);
    this.pastLimit = new Float64Array(nJ);
    this.pastMax = new Float64Array(nJ);
    this.pose = new Float64Array(nB * 7);
    this.pulse = new Float64Array(nP);
    this.command = new Float64Array(nP);
    this.state = new Uint8Array(nP);
    this.partCurrent = new Float64Array(nP);
    this.partVoltage = new Float64Array(nP);
    this.partTorque = new Float64Array(nP).fill(Number.NaN);
    this.rangerDistance = this.hasRanger ? new Float64Array(nP) : null;
    this.rangerHit = this.hasRanger ? new Uint8Array(nP) : null;
    this.rangerDistance?.fill(Number.NaN);
    this.voltage = new Float64Array(nS);
    this.supplyCurrent = new Float64Array(nS);
    this.supplySoc = new Float64Array(nS);
    this.supplySoc.fill(Number.NaN);
    this.boardVoltage = new Float64Array(nD);
    this.regulatorA = new Float64Array(nD);
    this.ledCurrent = new Float64Array(nD);
    this.ledOn = spec.boardLed ?? this.boards.map(() => false);
    this.ledPaths = spec.leds ?? [];
    this.ledAmps = new Float64Array(this.ledPaths.length);
    const nPins = nD * this.pinStride;
    this.ddr = new Uint32Array(nPins);
    this.level = new Uint32Array(nPins);
    this.toggled = new Uint32Array(nPins);
    this.running = new Uint8Array(nD);
    this.inReset = new Uint8Array(nD);
    this.belowSoa = new Uint8Array(nD);
    this.soaAny = new Uint8Array(nD);
    this.minV = new Float64Array(nS);
    this.maxSupply = new Float64Array(nS);
    this.minBoardV = new Float64Array(nD);
    this.maxRegulator = new Float64Array(nD);
    this.worst = new Uint8Array(nP);
    this.partMax = new Float64Array(nP);
    this.inResetAny = new Uint8Array(nD);
    this.resetFold();
  }

  setBoundMs(ms: number) {
    if (!Number.isInteger(ms) || ms < RECORD_FRAME_MS) return;
    this.boundMs = ms;
    const newest = this.newestMs();
    if (newest === null) return;
    const cutoff = newest - ms;
    if (cutoff > 0) this.dropBefore(cutoff);
  }

  /**
   * One simulated millisecond. `timeMs` is an integer. On a 10 ms boundary
   * the scratch values are the sample at t, and the fold is the window.
   */
  commit(timeMs: number) {
    if (!this.enabled) return;
    if (!Number.isInteger(timeMs) || timeMs < 0) return;
    if (timeMs <= this.lastCommitMs) return;
    this.lastCommitMs = timeMs;
    this.fold();
    if (timeMs % RECORD_FRAME_MS !== 0) return;
    this.write(timeMs);
    this.resetFold();
    const cutoff = timeMs - this.boundMs;
    if (cutoff > 0) this.dropBefore(cutoff);
  }

  /**
   * A master step inside a millisecond: fold its extremes into the window.
   * The sample at the millisecond is still the one `commit` takes.
   */
  foldStep() {
    if (!this.enabled) return;
    this.fold();
  }

  noteSerial(board: string, text: string, timeMs: number) {
    if (!this.enabled || !text) return;
    const from = this.serialNext.get(board) ?? 0;
    const to = from + text.length;
    this.serialNext.set(board, to);
    this.events.push({
      timeMs,
      kind: "serial",
      board,
      text,
      from,
      to,
    });
  }

  noteEvent(event: StoredEvent) {
    if (!this.enabled) return;
    this.events.push(event);
  }

  summary(simTimeS: number): RecordingSummary {
    return { id: this.id, from: this.fromS(), to: simTimeS };
  }

  info(simTimeS: number): RecordingInfo {
    return {
      ...this.summary(simTimeS),
      frameMs: RECORD_FRAME_MS,
      tracks: this.tracks(),
      manifest: this.manifest,
    };
  }

  tracks(): RecordingTracks {
    return {
      joints: this.joints.map((item) => item.id),
      bodies: this.bodies.map((item) => item.id),
      parts: this.parts.map((item) => item.track),
      supplies: this.supplies.map((item) => item.track),
      boards: this.boards.map((item) => item.track),
    };
  }

  frameAt(tS: number): RecordedFrame | null {
    if (!Number.isFinite(tS)) return null;
    const index = this.latestIndex(Math.round(tS * 1000));
    if (index === null) return null;
    return this.materialize(index, index, index, null).frame;
  }

  read(query: RecordingQuery): RecordingRead {
    const fromMs = Number.isFinite(query.from)
      ? Math.round(query.from * 1000)
      : 0;
    const toMs = Number.isFinite(query.to)
      ? Math.round(query.to * 1000)
      : fromMs;
    const indexes = fromMs <= toMs ? this.collect(fromMs, toMs) : [];
    const tracks =
      query.tracks && query.tracks.length > 0 ? new Set(query.tracks) : null;
    const frames: RecordedFrame[] = [];
    const max = query.maxFrames;
    const buckets = bucketIndexes(
      indexes,
      max !== undefined && max > 0 ? max : indexes.length
    );
    for (const bucket of buckets) {
      const last = bucket[bucket.length - 1];
      const first = bucket[0];
      if (last === undefined || first === undefined) continue;
      frames.push(this.materialize(last, first, last, tracks).frame);
    }
    return {
      id: this.id,
      from: query.from,
      to: query.to,
      frameMs: RECORD_FRAME_MS,
      frames,
      events: this.eventsBetween(fromMs, toMs),
    };
  }

  private fromS(): number {
    return this.fromMs() / 1000;
  }

  private fromMs(): number {
    if (this.dropped) return this.keptFromMs;
    return 0;
  }

  private fold() {
    for (let i = 0; i < this.supplies.length; i++) {
      const voltage = this.voltage[i] ?? 0;
      const current = this.supplyCurrent[i] ?? 0;
      if (voltage < (this.minV[i] ?? Number.POSITIVE_INFINITY)) {
        this.minV[i] = voltage;
      }
      if (current > (this.maxSupply[i] ?? Number.NEGATIVE_INFINITY)) {
        this.maxSupply[i] = current;
      }
    }
    for (let i = 0; i < this.parts.length; i++) {
      const rank = this.state[i] ?? 0;
      if (rank > (this.worst[i] ?? 0)) this.worst[i] = rank;
      const current = this.partCurrent[i] ?? 0;
      if (current > (this.partMax[i] ?? Number.NEGATIVE_INFINITY)) {
        this.partMax[i] = current;
      }
    }
    for (let i = 0; i < this.boards.length; i++) {
      const voltage = this.boardVoltage[i] ?? 0;
      if (voltage < (this.minBoardV[i] ?? Number.POSITIVE_INFINITY)) {
        this.minBoardV[i] = voltage;
      }
      const pass = this.regulatorA[i] ?? 0;
      if (pass > (this.maxRegulator[i] ?? Number.NEGATIVE_INFINITY)) {
        this.maxRegulator[i] = pass;
      }
      if ((this.inReset[i] ?? 0) !== 0) this.inResetAny[i] = 1;
      if ((this.belowSoa[i] ?? 0) !== 0) this.soaAny[i] = 1;
    }
    for (let i = 0; i < this.joints.length; i++) {
      const past = this.pastLimit[i] ?? 0;
      if (past > (this.pastMax[i] ?? 0)) this.pastMax[i] = past;
    }
  }

  private resetFold() {
    this.minV.fill(Number.POSITIVE_INFINITY);
    this.maxSupply.fill(Number.NEGATIVE_INFINITY);
    this.minBoardV.fill(Number.POSITIVE_INFINITY);
    this.maxRegulator.fill(Number.NEGATIVE_INFINITY);
    this.worst.fill(0);
    this.partMax.fill(Number.NEGATIVE_INFINITY);
    this.inResetAny.fill(0);
    this.soaAny.fill(0);
    this.pastMax.fill(0);
  }

  private write(timeMs: number) {
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.start + chunk.count >= CHUNK) {
      chunk = createChunk(this.counts());
      this.chunks.push(chunk);
    }
    const slot = chunk.start + chunk.count;
    chunk.tMs[slot] = timeMs;
    for (let i = 0; i < this.joints.length; i++) {
      chunk.joint[channel(i, slot)] = this.joint[i] ?? 0;
      chunk.limitDeg[channel(i, slot)] = this.pastMax[i] ?? 0;
    }
    for (let i = 0; i < this.pose.length; i++) {
      chunk.pose[channel(i, slot)] = this.pose[i] ?? 0;
    }
    for (let i = 0; i < this.parts.length; i++) {
      chunk.pulse[channel(i, slot)] = this.pulse[i] ?? Number.NaN;
      chunk.command[channel(i, slot)] = this.command[i] ?? Number.NaN;
      chunk.state[channel(i, slot)] = this.state[i] ?? 0;
      chunk.worst[channel(i, slot)] = this.worst[i] ?? 0;
      chunk.partCurrent[channel(i, slot)] = this.partCurrent[i] ?? 0;
      chunk.partMax[channel(i, slot)] = this.partMax[i] ?? 0;
      chunk.partVoltage[channel(i, slot)] = this.partVoltage[i] ?? 0;
      chunk.partTorque[channel(i, slot)] = this.partTorque[i] ?? Number.NaN;
      if (chunk.rangerDistance && this.rangerDistance) {
        chunk.rangerDistance[channel(i, slot)] =
          this.rangerDistance[i] ?? Number.NaN;
      }
      if (chunk.rangerHit && this.rangerHit) {
        chunk.rangerHit[channel(i, slot)] = this.rangerHit[i] ?? 0;
      }
    }
    for (let i = 0; i < this.supplies.length; i++) {
      chunk.voltage[channel(i, slot)] = this.voltage[i] ?? 0;
      chunk.minVoltage[channel(i, slot)] = this.minV[i] ?? 0;
      chunk.supplyCurrent[channel(i, slot)] = this.supplyCurrent[i] ?? 0;
      chunk.supplyMax[channel(i, slot)] = this.maxSupply[i] ?? 0;
      chunk.supplySoc[channel(i, slot)] = this.supplySoc[i] ?? Number.NaN;
    }
    for (let i = 0; i < this.boards.length; i++) {
      const words = this.pinWords[i] ?? 1;
      for (let w = 0; w < words; w++) {
        const index = i * this.pinStride + w;
        chunk.ddr[channel(index, slot)] = this.ddr[index] ?? 0;
        chunk.level[channel(index, slot)] = this.level[index] ?? 0;
        chunk.toggled[channel(index, slot)] = this.toggled[index] ?? 0;
      }
      chunk.running[channel(i, slot)] = this.running[i] ?? 0;
      chunk.inReset[channel(i, slot)] = this.inReset[i] ?? 0;
      chunk.inResetAny[channel(i, slot)] = this.inResetAny[i] ?? 0;
      chunk.belowSoa[channel(i, slot)] = this.soaAny[i] ?? 0;
      chunk.boardVoltage[channel(i, slot)] = this.boardVoltage[i] ?? 0;
      chunk.boardMinVoltage[channel(i, slot)] = this.minBoardV[i] ?? 0;
      chunk.regulatorA[channel(i, slot)] = this.regulatorA[i] ?? 0;
      chunk.regulatorMax[channel(i, slot)] = this.maxRegulator[i] ?? 0;
      if (chunk.boardLed) {
        chunk.boardLed[channel(i, slot)] = this.ledCurrent[i] ?? 0;
      }
    }
    if (chunk.leds) {
      for (let i = 0; i < this.ledPaths.length; i++) {
        chunk.leds[channel(i, slot)] = this.ledAmps[i] ?? 0;
      }
    }
    chunk.count += 1;
  }

  /** Copy this board's pin words. `i` is the board, not the word. */
  setPins(i: number, pins: WorldPinState): void {
    const words = this.pinWords[i] ?? 1;
    for (let w = 0; w < words; w++) {
      const at = i * this.pinStride + w;
      this.ddr[at] = pins.ddr[w] ?? 0;
      this.level[at] = pins.level[w] ?? 0;
      this.toggled[at] = pins.toggled[w] ?? 0;
    }
  }

  private storedPins(chunk: Chunk, board: number, slot: number): WorldPinState {
    const words = this.pinWords[board] ?? 1;
    const take = (field: Uint32Array) => {
      const out: number[] = [];
      for (let w = 0; w < words; w++) {
        out.push(field[channel(board * this.pinStride + w, slot)] ?? 0);
      }
      return out;
    };
    return {
      ddr: take(chunk.ddr),
      level: take(chunk.level),
      toggled: take(chunk.toggled),
    };
  }

  private counts() {
    return {
      joints: this.joints.length,
      bodies: this.bodies.length,
      parts: this.parts.length,
      supplies: this.supplies.length,
      boards: this.boards.length,
      pinStride: this.pinStride,
      boardLed: this.ledOn.some(Boolean),
      leds: this.ledPaths.length,
      ranger: this.hasRanger,
    };
  }

  private dropBefore(cutoffMs: number) {
    let removed = false;
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (!chunk || chunk.count === 0) {
        this.chunks.shift();
        removed = true;
        continue;
      }
      const last = chunk.tMs[chunk.start + chunk.count - 1] ?? 0;
      if (last < cutoffMs) {
        this.chunks.shift();
        removed = true;
        continue;
      }
      let skip = 0;
      while (
        skip < chunk.count &&
        (chunk.tMs[chunk.start + skip] ?? 0) < cutoffMs
      ) {
        skip += 1;
      }
      if (skip > 0) {
        chunk.start += skip;
        chunk.count -= skip;
        removed = true;
        if (chunk.count === 0) this.chunks.shift();
      }
      break;
    }
    if (!removed) return;
    this.dropped = true;
    const oldest = this.oldestMs();
    this.keptFromMs = oldest ?? cutoffMs;
    const from = this.keptFromMs;
    // The oldest frame still covers (from − frame, from]. An event in
    // that window stays, or the dip remains and its reset does not.
    const keepAfter = from - RECORD_FRAME_MS;
    while (this.eventStart < this.events.length) {
      const event = this.events[this.eventStart];
      if (!event || event.timeMs > keepAfter) break;
      this.eventStart += 1;
    }
    if (this.eventStart > 1024) {
      this.events.splice(0, this.eventStart);
      this.eventStart = 0;
    }
  }

  private oldestMs(): number | null {
    const chunk = this.chunks[0];
    if (!chunk || chunk.count === 0) return null;
    return chunk.tMs[chunk.start] ?? null;
  }

  private newestMs(): number | null {
    const chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.count === 0) return null;
    return chunk.tMs[chunk.start + chunk.count - 1] ?? null;
  }

  private locate(index: number): Slot | null {
    let left = index;
    for (const chunk of this.chunks) {
      if (left < chunk.count) {
        const slot = chunk.start + left;
        return { chunk, slot, timeMs: chunk.tMs[slot] ?? 0 };
      }
      left -= chunk.count;
    }
    return null;
  }

  private collect(fromMs: number, toMs: number): number[] {
    const out: number[] = [];
    let index = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.count; i++) {
        const t = chunk.tMs[chunk.start + i] ?? 0;
        if (t > toMs) return out;
        if (t >= fromMs) out.push(index);
        index += 1;
      }
    }
    return out;
  }

  private latestIndex(ms: number): number | null {
    let index = 0;
    let found: number | null = null;
    for (const chunk of this.chunks) {
      if (chunk.count === 0) continue;
      const first = chunk.tMs[chunk.start] ?? 0;
      if (first > ms) break;
      const last = chunk.tMs[chunk.start + chunk.count - 1] ?? 0;
      if (last <= ms) {
        found = index + chunk.count - 1;
        index += chunk.count;
        continue;
      }
      let lo = 0;
      let hi = chunk.count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = chunk.tMs[chunk.start + mid] ?? 0;
        if (t <= ms) {
          found = index + mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      break;
    }
    return found;
  }

  private materialize(
    pick: number,
    start: number,
    end: number,
    tracks: Set<string> | null
  ): { frame: RecordedFrame } {
    const chosen = this.locate(pick);
    const frame = this.frameFrom(chosen, tracks);
    if (!chosen) return { frame };
    const minV = this.supplies.map(
      (_item, i) => chosen.chunk.minVoltage[channel(i, chosen.slot)] ?? 0
    );
    const maxSupply = this.supplies.map(
      (_item, i) => chosen.chunk.supplyMax[channel(i, chosen.slot)] ?? 0
    );
    const worst = this.parts.map(
      (_item, i) => chosen.chunk.worst[channel(i, chosen.slot)] ?? 0
    );
    const partMax = this.parts.map(
      (_item, i) => chosen.chunk.partMax[channel(i, chosen.slot)] ?? 0
    );
    const held = this.boards.map(
      (_item, i) =>
        (chosen.chunk.inResetAny[channel(i, chosen.slot)] ?? 0) !== 0
    );
    const soa = this.boards.map(
      (_item, i) => (chosen.chunk.belowSoa[channel(i, chosen.slot)] ?? 0) !== 0
    );
    const minBoard = this.boards.map(
      (_item, i) => chosen.chunk.boardMinVoltage[channel(i, chosen.slot)] ?? 0
    );
    const maxPass = this.boards.map(
      (_item, i) => chosen.chunk.regulatorMax[channel(i, chosen.slot)] ?? 0
    );
    const past = this.joints.map(
      (_item, i) => chosen.chunk.limitDeg[channel(i, chosen.slot)] ?? 0
    );
    for (let index = start; index <= end; index++) {
      if (index === pick) continue;
      const slot = this.locate(index);
      if (!slot) continue;
      for (let i = 0; i < this.supplies.length; i++) {
        const voltage = slot.chunk.minVoltage[channel(i, slot.slot)] ?? 0;
        const current = slot.chunk.supplyMax[channel(i, slot.slot)] ?? 0;
        if (voltage < (minV[i] ?? 0)) minV[i] = voltage;
        if (current > (maxSupply[i] ?? 0)) maxSupply[i] = current;
      }
      for (let i = 0; i < this.parts.length; i++) {
        const rank = slot.chunk.worst[channel(i, slot.slot)] ?? 0;
        const current = slot.chunk.partMax[channel(i, slot.slot)] ?? 0;
        if (rank > (worst[i] ?? 0)) worst[i] = rank;
        if (current > (partMax[i] ?? 0)) partMax[i] = current;
      }
      for (let i = 0; i < this.boards.length; i++) {
        if ((slot.chunk.inResetAny[channel(i, slot.slot)] ?? 0) !== 0) {
          held[i] = true;
        }
        if ((slot.chunk.belowSoa[channel(i, slot.slot)] ?? 0) !== 0) {
          soa[i] = true;
        }
        const voltage = slot.chunk.boardMinVoltage[channel(i, slot.slot)] ?? 0;
        if (voltage < (minBoard[i] ?? 0)) minBoard[i] = voltage;
        const pass = slot.chunk.regulatorMax[channel(i, slot.slot)] ?? 0;
        if (pass > (maxPass[i] ?? 0)) maxPass[i] = pass;
      }
      for (let i = 0; i < this.joints.length; i++) {
        const deg = slot.chunk.limitDeg[channel(i, slot.slot)] ?? 0;
        if (deg > (past[i] ?? 0)) past[i] = deg;
      }
    }
    for (let i = 0; i < this.supplies.length; i++) {
      const supply = this.supplies[i];
      const row = supply ? frame.supplies[supply.id] : undefined;
      if (!row) continue;
      row.minVoltage = minV[i] ?? row.minVoltage;
      row.maxCurrent = maxSupply[i] ?? row.maxCurrent;
    }
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const row = part ? frame.parts[part.id] : undefined;
      if (!row) continue;
      row.worst = motionName(worst[i] ?? 0);
      row.maxCurrent = partMax[i] ?? row.maxCurrent;
    }
    for (let i = 0; i < this.boards.length; i++) {
      const board = this.boards[i];
      const row = board ? frame.boards[board.id] : undefined;
      if (!row) continue;
      row.inResetAny = held[i] ?? row.inResetAny;
      row.belowSoa = soa[i] ?? row.belowSoa;
      row.minVoltage = minBoard[i] ?? row.minVoltage;
      row.regulatorMax = maxPass[i] ?? row.regulatorMax;
    }
    for (let i = 0; i < this.joints.length; i++) {
      const spec = this.joints[i];
      const row = spec ? frame.limitDeg[spec.robot] : undefined;
      if (!spec || !row) continue;
      row[spec.joint] = past[i] ?? row[spec.joint] ?? 0;
    }
    return { frame };
  }

  private frameFrom(
    slot: Slot | null,
    tracks: Set<string> | null
  ): RecordedFrame {
    const want = (id: string) => tracks === null || tracks.has(id);
    const joints: RecordedFrame["joints"] = {};
    const limitDeg: RecordedFrame["limitDeg"] = {};
    const poses: RecordedFrame["poses"] = {};
    const parts: RecordedFrame["parts"] = {};
    const supplies: RecordedFrame["supplies"] = {};
    const boards: RecordedFrame["boards"] = {};
    if (!slot) {
      return { t: 0, joints, limitDeg, poses, parts, supplies, boards };
    }
    for (let i = 0; i < this.joints.length; i++) {
      const spec = this.joints[i];
      if (!spec) continue;
      const pastRobot = limitDeg[spec.robot] ?? {};
      pastRobot[spec.joint] = slot.chunk.limitDeg[channel(i, slot.slot)] ?? 0;
      limitDeg[spec.robot] = pastRobot;
      if (!want(spec.id)) continue;
      const robot = joints[spec.robot] ?? {};
      robot[spec.joint] = slot.chunk.joint[channel(i, slot.slot)] ?? 0;
      joints[spec.robot] = robot;
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const spec = this.bodies[i];
      if (!spec || !want(spec.id)) continue;
      const base = i * 7;
      const robot = poses[spec.robot] ?? {};
      robot[spec.link] = {
        p: [
          slot.chunk.pose[channel(base, slot.slot)] ?? 0,
          slot.chunk.pose[channel(base + 1, slot.slot)] ?? 0,
          slot.chunk.pose[channel(base + 2, slot.slot)] ?? 0,
        ],
        q: [
          slot.chunk.pose[channel(base + 3, slot.slot)] ?? 1,
          slot.chunk.pose[channel(base + 4, slot.slot)] ?? 0,
          slot.chunk.pose[channel(base + 5, slot.slot)] ?? 0,
          slot.chunk.pose[channel(base + 6, slot.slot)] ?? 0,
        ],
      };
      poses[spec.robot] = robot;
    }
    for (let i = 0; i < this.parts.length; i++) {
      const spec = this.parts[i];
      if (!spec || !want(spec.track)) continue;
      const pulse = slot.chunk.pulse[channel(i, slot.slot)] ?? Number.NaN;
      const command = slot.chunk.command[channel(i, slot.slot)] ?? Number.NaN;
      const torque = slot.chunk.partTorque[channel(i, slot.slot)] ?? Number.NaN;
      parts[spec.id] = {
        pulseUs: Number.isNaN(pulse) ? null : pulse,
        commandDeg: Number.isNaN(command) ? null : command,
        state: motionName(slot.chunk.state[channel(i, slot.slot)] ?? 0),
        worst: motionName(slot.chunk.worst[channel(i, slot.slot)] ?? 0),
        current: slot.chunk.partCurrent[channel(i, slot.slot)] ?? 0,
        maxCurrent: slot.chunk.partMax[channel(i, slot.slot)] ?? 0,
        voltage: slot.chunk.partVoltage[channel(i, slot.slot)] ?? 0,
        ...(Number.isNaN(torque) ? {} : { torqueNm: torque }),
        ...(this.partRanger[i]
          ? {
              distanceM: Number.isNaN(
                slot.chunk.rangerDistance?.[channel(i, slot.slot)] ?? Number.NaN
              )
                ? null
                : (slot.chunk.rangerDistance?.[channel(i, slot.slot)] ?? null),
              echoS: Number.isNaN(pulse) ? null : pulse / 1e6,
              hit: (slot.chunk.rangerHit?.[channel(i, slot.slot)] ?? 0) !== 0,
            }
          : {}),
      };
    }
    for (let i = 0; i < this.supplies.length; i++) {
      const spec = this.supplies[i];
      if (!spec || !want(spec.track)) continue;
      const soc = slot.chunk.supplySoc[channel(i, slot.slot)];
      supplies[spec.id] = {
        voltage: slot.chunk.voltage[channel(i, slot.slot)] ?? 0,
        minVoltage: slot.chunk.minVoltage[channel(i, slot.slot)] ?? 0,
        current: slot.chunk.supplyCurrent[channel(i, slot.slot)] ?? 0,
        maxCurrent: slot.chunk.supplyMax[channel(i, slot.slot)] ?? 0,
        ...(typeof soc === "number" && Number.isFinite(soc) ? { soc } : {}),
      };
    }
    for (let i = 0; i < this.boards.length; i++) {
      const spec = this.boards[i];
      if (!spec || !want(spec.track)) continue;
      boards[spec.id] = {
        pins: this.storedPins(slot.chunk, i, slot.slot),
        running: (slot.chunk.running[channel(i, slot.slot)] ?? 0) !== 0,
        inReset: (slot.chunk.inReset[channel(i, slot.slot)] ?? 0) !== 0,
        inResetAny: (slot.chunk.inResetAny[channel(i, slot.slot)] ?? 0) !== 0,
        belowSoa: (slot.chunk.belowSoa[channel(i, slot.slot)] ?? 0) !== 0,
        voltage: slot.chunk.boardVoltage[channel(i, slot.slot)] ?? 0,
        minVoltage: slot.chunk.boardMinVoltage[channel(i, slot.slot)] ?? 0,
        regulatorA: slot.chunk.regulatorA[channel(i, slot.slot)] ?? 0,
        regulatorMax: slot.chunk.regulatorMax[channel(i, slot.slot)] ?? 0,
        ...(this.ledOn[i]
          ? {
              ledCurrent: slot.chunk.boardLed?.[channel(i, slot.slot)] ?? 0,
            }
          : {}),
      };
    }
    // Envelope flags survive a track filter. A pulse-only read still
    // reports a joint that left its stop and the board row from this slot.
    for (let i = 0; i < this.boards.length; i++) {
      const spec = this.boards[i];
      if (!spec || boards[spec.id]) continue;
      const at = channel(i, slot.slot);
      boards[spec.id] = {
        pins: this.storedPins(slot.chunk, i, slot.slot),
        running: (slot.chunk.running[at] ?? 0) !== 0,
        inReset: (slot.chunk.inReset[at] ?? 0) !== 0,
        inResetAny: (slot.chunk.inResetAny[at] ?? 0) !== 0,
        belowSoa: (slot.chunk.belowSoa[at] ?? 0) !== 0,
        voltage: slot.chunk.boardVoltage[at] ?? 0,
        minVoltage: slot.chunk.boardMinVoltage[at] ?? 0,
        regulatorA: slot.chunk.regulatorA[at] ?? 0,
        regulatorMax: slot.chunk.regulatorMax[at] ?? 0,
        ...(this.ledOn[i]
          ? { ledCurrent: slot.chunk.boardLed?.[at] ?? 0 }
          : {}),
      };
    }
    this.attachLeds(boards, slot);
    return {
      t: slot.timeMs / 1000,
      joints,
      limitDeg,
      poses,
      parts,
      supplies,
      boards,
    };
  }

  private attachLeds(boards: RecordedFrame["boards"], slot: Slot): void {
    if (!slot.chunk.leds) return;
    for (let k = 0; k < this.ledPaths.length; k++) {
      const row = this.ledPaths[k];
      if (!row) continue;
      const board = boards[row.board];
      if (!board) continue;
      const amps = slot.chunk.leds[channel(k, slot.slot)] ?? 0;
      board.leds = { ...(board.leds ?? {}), [row.path]: amps };
    }
  }

  private eventsBetween(fromMs: number, toMs: number): RecordingEvent[] {
    const out: RecordingEvent[] = [];
    for (let i = this.eventStart; i < this.events.length; i++) {
      const event = this.events[i];
      if (!event || event.timeMs < fromMs) continue;
      if (event.timeMs > toMs) break;
      const pub = publishEvent(event);
      if (pub) out.push(pub);
    }
    return out;
  }
}

function publishEvent(event: StoredEvent): RecordingEvent | null {
  const t = event.timeMs / 1000;
  if (event.kind === "serial" && event.board && event.text !== undefined) {
    return {
      t,
      kind: "serial",
      board: event.board,
      text: event.text,
      from: event.from ?? 0,
      to: event.to ?? 0,
    };
  }
  if (
    event.kind === "serial-send" &&
    event.board &&
    event.text !== undefined &&
    event.by
  ) {
    return {
      t,
      kind: "serial-send",
      board: event.board,
      text: event.text,
      by: event.by,
    };
  }
  if (event.kind === "fault" && event.board) {
    return {
      t,
      kind: "fault",
      board: event.board,
      message: event.message ?? "",
    };
  }
  if (event.kind === "reset" && event.board) {
    return event.cause
      ? { t, kind: "reset", board: event.board, cause: event.cause }
      : { t, kind: "reset", board: event.board };
  }
  if ((event.kind === "reboot" || event.kind === "reload") && event.board) {
    return { t, kind: event.kind, board: event.board };
  }
  if (
    event.kind === "move-target" &&
    event.id &&
    event.position &&
    event.position.length === 3
  ) {
    return {
      t,
      kind: "move-target",
      id: event.id,
      position: [event.position[0], event.position[1], event.position[2]],
    };
  }
  if ((event.kind === "play" || event.kind === "pause") && event.by) {
    return { t, kind: event.kind, by: event.by };
  }
  return null;
}

function bucketIndexes(indexes: number[], maxFrames: number): number[][] {
  if (indexes.length === 0) return [];
  const max = Math.max(1, Math.floor(maxFrames));
  if (indexes.length <= max) return indexes.map((index) => [index]);
  const out: number[][] = [];
  const n = indexes.length;
  for (let i = 0; i < max; i++) {
    const start = Math.floor((i * n) / max);
    const end = Math.floor(((i + 1) * n) / max);
    if (end <= start) continue;
    const bucket: number[] = [];
    for (let j = start; j < end; j++) {
      const index = indexes[j];
      if (index !== undefined) bucket.push(index);
    }
    if (bucket.length > 0) out.push(bucket);
  }
  return out;
}

type ChunkCounts = {
  joints: number;
  bodies: number;
  parts: number;
  supplies: number;
  boards: number;
  /** Words per board. Absent is one, so a 32-pin board keeps the old stride. */
  pinStride?: number;
  boardLed?: boolean;
  leds?: number;
  ranger?: boolean;
};

function createChunk(counts: ChunkCounts): Chunk {
  return {
    start: 0,
    count: 0,
    tMs: new Uint32Array(CHUNK),
    joint: new Float32Array(counts.joints * CHUNK),
    limitDeg: new Float32Array(counts.joints * CHUNK),
    pose: new Float32Array(counts.bodies * 7 * CHUNK),
    pulse: new Float32Array(counts.parts * CHUNK),
    command: new Float32Array(counts.parts * CHUNK),
    state: new Uint8Array(counts.parts * CHUNK),
    worst: new Uint8Array(counts.parts * CHUNK),
    partCurrent: new Float32Array(counts.parts * CHUNK),
    partMax: new Float32Array(counts.parts * CHUNK),
    partVoltage: new Float32Array(counts.parts * CHUNK),
    partTorque: new Float32Array(counts.parts * CHUNK),
    voltage: new Float32Array(counts.supplies * CHUNK),
    minVoltage: new Float32Array(counts.supplies * CHUNK),
    supplyCurrent: new Float32Array(counts.supplies * CHUNK),
    supplyMax: new Float32Array(counts.supplies * CHUNK),
    supplySoc: new Float32Array(counts.supplies * CHUNK).fill(Number.NaN),
    boardVoltage: new Float32Array(counts.boards * CHUNK),
    boardMinVoltage: new Float32Array(counts.boards * CHUNK),
    regulatorA: new Float32Array(counts.boards * CHUNK),
    regulatorMax: new Float32Array(counts.boards * CHUNK),
    boardLed: counts.boardLed ? new Float32Array(counts.boards * CHUNK) : null,
    leds: counts.leds ? new Float32Array(counts.leds * CHUNK) : null,
    rangerDistance: counts.ranger
      ? new Float32Array(counts.parts * CHUNK)
      : null,
    rangerHit: counts.ranger ? new Uint8Array(counts.parts * CHUNK) : null,
    ddr: new Uint32Array(counts.boards * (counts.pinStride ?? 1) * CHUNK),
    level: new Uint32Array(counts.boards * (counts.pinStride ?? 1) * CHUNK),
    toggled: new Uint32Array(counts.boards * (counts.pinStride ?? 1) * CHUNK),
    running: new Uint8Array(counts.boards * CHUNK),
    inReset: new Uint8Array(counts.boards * CHUNK),
    inResetAny: new Uint8Array(counts.boards * CHUNK),
    belowSoa: new Uint8Array(counts.boards * CHUNK),
  };
}

function senderLine(by: WorldSender, text: string): string {
  const who = by.kind === "agent" ? "agent" : by.label || "someone";
  const line = text.endsWith("\n") ? text : `${text}\n`;
  return `‹ sent by ${who} › ${line}`;
}

/** Strip series from an already downsampled read. Joints are degrees. */
export function timelineFromRead(read: RecordingRead): {
  tracks: TimelineTrack[];
  markers: TimelineMarker[];
} {
  const jointIds: string[] = [];
  const partIds: string[] = [];
  const supplyIds: string[] = [];
  const boardIds: string[] = [];
  const seen = new Set<string>();
  for (const frame of read.frames) {
    for (const [robot, joints] of Object.entries(frame.joints)) {
      for (const joint of Object.keys(joints)) {
        const id = jointTrackId(robot, joint);
        if (seen.has(id)) continue;
        seen.add(id);
        jointIds.push(id);
      }
    }
    for (const id of Object.keys(frame.parts)) {
      const track = partTrackId(id);
      if (seen.has(track)) continue;
      seen.add(track);
      partIds.push(id);
    }
    for (const id of Object.keys(frame.supplies)) {
      const track = supplyTrackId(id);
      if (seen.has(track)) continue;
      seen.add(track);
      supplyIds.push(id);
    }
    for (const id of Object.keys(frame.boards)) {
      const track = boardTrackId(id);
      if (seen.has(track)) continue;
      seen.add(track);
      boardIds.push(id);
    }
  }
  const tracks: TimelineTrack[] = [];
  for (const id of jointIds) {
    const split = id.slice("joint:".length);
    const slash = split.indexOf("/");
    const robot = split.slice(0, slash);
    const joint = split.slice(slash + 1);
    tracks.push({
      id,
      unit: "deg",
      t: read.frames.map((frame) => frame.t),
      v: read.frames.map((frame) => {
        const rad = frame.joints[robot]?.[joint];
        return rad === undefined ? null : (rad * 180) / Math.PI;
      }),
    });
  }
  for (const id of supplyIds) {
    tracks.push({
      id: supplyTrackId(id),
      unit: "V",
      t: read.frames.map((frame) => frame.t),
      v: read.frames.map((frame) => frame.supplies[id]?.voltage ?? null),
      lo: read.frames.map((frame) => frame.supplies[id]?.minVoltage ?? 0),
    });
  }
  for (const id of boardIds) {
    tracks.push({
      id: boardTrackId(id),
      unit: "V",
      t: read.frames.map((frame) => frame.t),
      v: read.frames.map((frame) => frame.boards[id]?.voltage ?? null),
      lo: read.frames.map((frame) => frame.boards[id]?.minVoltage ?? 0),
    });
  }
  for (const id of partIds) {
    tracks.push({
      id: partTrackId(id),
      unit: "deg",
      t: read.frames.map((frame) => frame.t),
      v: read.frames.map((frame) => frame.parts[id]?.commandDeg ?? null),
    });
  }
  const markers: TimelineMarker[] = [];
  for (const event of read.events) {
    if (event.kind === "reset") {
      markers.push({ t: event.t, kind: "reset", board: event.board });
    } else if (event.kind === "reload") {
      markers.push({ t: event.t, kind: "reload", board: event.board });
    } else if (event.kind === "fault") {
      markers.push({
        t: event.t,
        kind: "fault",
        board: event.board,
        text: event.message,
      });
    } else if (event.kind === "serial") {
      markers.push({
        t: event.t,
        kind: "serial",
        board: event.board,
        text: event.text,
      });
    } else if (event.kind === "serial-send") {
      markers.push({
        t: event.t,
        kind: "serial",
        board: event.board,
        text: senderLine(event.by, event.text),
      });
    }
  }
  return { tracks, markers };
}
