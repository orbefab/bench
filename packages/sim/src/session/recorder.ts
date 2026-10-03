/** Recorder: the live state sample, the recording layout and manifest, and the recorded query answers. */
import {
  boardPinState,
  DEFAULT_TIMESTEP_S,
  emptyPinState,
  type JointLimitKind,
  onboardLedPath,
  pastLimitAmount,
  pinWordCount,
  RECORD_FRAME_MS,
  type RecordingManifest,
  type RecordingPartCatalog,
  soaWarning,
  type WorldPartState,
  type WorldState,
} from "@sfab-bench/contract";
import type { RunPlan } from "../plan";
import { probeTracks } from "../probe";
import type { RailCircuit } from "../rail-circuit";
import { motionRank, RunRecorder, timelineFromRead } from "../record";
import type { RecordBody, RecordQuery, ToWorker } from "../sim";
import { boardInSoa, ledCurrentOf, ledReading, regulatorAmps } from "./boards";
import { post, simMs } from "./common";
import { boardNodeOf, boardVolts } from "./rails";
import type { RecLayout, SessionState } from "./state";

const INTEGRATORS = [
  "euler",
  "rk4",
  "implicit",
  "implicitfast",
  "discrete",
] as const;

function tuple3(value: Float64Array): [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

function tuple4(value: Float64Array): [number, number, number, number] {
  return [value[0] ?? 1, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
}

export function scalar(value: Float64Array): number {
  return value[0] ?? 0;
}

export function sample(s: SessionState): WorldState | null {
  if (!s.sim) return null;
  const { mj, model, data, index } = s.sim;
  mj.mj_forward(model, data);
  const poses: WorldState["poses"] = {};
  for (const [robotId, links] of Object.entries(index.linkNames)) {
    const robot: WorldState["poses"][string] = {};
    for (const [link, mjName] of Object.entries(links)) {
      const body = data.body(mjName);
      robot[link] = {
        p: tuple3(body.xpos as Float64Array),
        q: tuple4(body.xquat as Float64Array),
      };
    }
    poses[robotId] = robot;
  }
  const joints: WorldState["joints"] = {};
  for (const [robotId, names] of Object.entries(index.jointNamesByRobot)) {
    const robot: WorldState["joints"][string] = {};
    for (const [joint, mjName] of Object.entries(names)) {
      robot[joint] = scalar(data.jnt(mjName).qpos as Float64Array);
    }
    joints[robotId] = robot;
  }
  const boardState: WorldState["boards"] = {};
  for (const board of s.boards) {
    const spec = s.specs.find((item) => item.id === board.id);
    const pins = boardPinState(board.takePins(), spec?.pinCount ?? 0);
    const power = s.boardPower.get(board.id);
    const unpowered = !power?.supplyId;
    const node = power?.supplyId ? boardVolts(s, board.id) : 0;
    const minVoltage = spec?.minOperatingVoltage;
    const clock = spec?.clock;
    const brownoutVoltage = power?.brownoutVoltage;
    const soa =
      minVoltage != null &&
      brownoutVoltage != null &&
      clock &&
      board.running &&
      !board.inReset &&
      !board.fault &&
      !unpowered
        ? soaWarning(node, brownoutVoltage, minVoltage, clock)
        : null;
    boardState[board.id] = {
      ...(board.fault
        ? { running: false as const, fault: board.fault, pins }
        : { running: board.running, pins }),
      ...(unpowered ? { unpowered: true as const } : {}),
      resets: power?.resets ?? 0,
      inReset: board.inReset,
      ...(board.inReset && power?.reset.cause
        ? { resetCause: power.reset.cause }
        : {}),
      ...(power?.supplyId ? { voltage: node } : {}),
      ...ledReading(s, board.id),
      ...(() => {
        const extra = s.degradedLive.filter(
          (row) => row.path === board.id || row.path.startsWith(`${board.id}.`)
        );
        const warnings = [
          ...(soa ? [soa] : []),
          ...extra.map((row) => ({
            code: "degraded" as const,
            message: row.message,
          })),
        ];
        return warnings.length > 0 ? { warnings } : {};
      })(),
    };
  }
  const parts: Record<string, WorldPartState> = {};
  for (const load of s.loads) {
    // Only a servo with a signal wire is on the wire. A setTarget
    // command has no pulse. An unwired V+ still draws through `loads`.
    if (!load.drive?.board) continue;
    parts[load.partId] = {
      pulseUs: load.drive?.track.pulseUs ?? null,
      commandDeg: load.drive?.track.commandDeg ?? null,
      state: load.state,
      current: load.current,
      voltage: load.drive?.board
        ? boardVolts(s, load.drive.board.id)
        : load.supplyId
          ? boardNodeOf(s, load.supplyId)
          : 0,
    };
  }
  for (const ranger of s.rangers) {
    const echoUs = ranger.echoS === null ? null : ranger.echoS * 1e6;
    parts[ranger.spec.id] = {
      pulseUs: echoUs,
      commandDeg: null,
      state: "idle",
      current: ranger.current,
      voltage: ranger.supplyId ? boardNodeOf(s, ranger.supplyId) : 0,
      distanceM: ranger.distanceM,
      echoS: ranger.echoS,
      hit: ranger.hit,
    };
  }
  return {
    simTime: data.time,
    playing: s.playing,
    poses,
    joints,
    boards: boardState,
    parts,
    supplies: s.supplyLive,
    ...(s.degradedLive.length > 0
      ? {
          diagnostics: s.degradedLive.map((row) => ({
            severity: "degraded" as const,
            code: row.code ?? "idle",
            path: row.path,
            message: row.message,
          })),
        }
      : {}),
    ...(s.recorder ? { recording: s.recorder.summary(data.time) } : {}),
  };
}

function fillRecorder(s: SessionState, full: boolean) {
  const rec = s.recorder;
  const lay = s.layout;
  if (!rec || !lay || !s.sim) return;
  for (let i = 0; i < lay.joints.length; i++) {
    const spec = lay.joints[i];
    if (!spec) continue;
    const qpos = (s.sim.data.qpos as Float64Array)[spec.qposadr] ?? 0;
    rec.pastLimit[i] = pastLimitAmount(qpos, spec.lower, spec.upper, spec.kind);
    if (full) rec.joint[i] = qpos;
  }
  if (full) {
    let pose = 0;
    for (const spec of lay.bodies) {
      const body = s.sim.data.body(spec.mj);
      const p = body.xpos as Float64Array;
      const q = body.xquat as Float64Array;
      rec.pose[pose] = p[0] ?? 0;
      rec.pose[pose + 1] = p[1] ?? 0;
      rec.pose[pose + 2] = p[2] ?? 0;
      rec.pose[pose + 3] = q[0] ?? 1;
      rec.pose[pose + 4] = q[1] ?? 0;
      rec.pose[pose + 5] = q[2] ?? 0;
      rec.pose[pose + 6] = q[3] ?? 0;
      pose += 7;
    }
    for (let i = 0; i < lay.parts.length; i++) {
      const drive = lay.parts[i]?.drive;
      rec.pulse[i] = drive?.track.pulseUs ?? Number.NaN;
      rec.command[i] =
        (drive?.board ? drive.track.commandDeg : drive?.manualDeg) ??
        Number.NaN;
    }
    for (let i = 0; i < lay.rangers.length; i++) {
      const ranger = lay.rangers[i];
      const index = lay.parts.length + i;
      if (!ranger || !rec.rangerDistance || !rec.rangerHit) continue;
      rec.pulse[index] =
        ranger.echoS === null ? Number.NaN : ranger.echoS * 1e6;
      rec.command[index] = Number.NaN;
      rec.rangerDistance[index] = ranger.distanceM ?? Number.NaN;
      rec.rangerHit[index] = ranger.hit ? 1 : 0;
    }
    for (let i = 0; i < lay.boards.length; i++) {
      const id = lay.boards[i];
      const board = s.boards.find((item) => item.id === id);
      const pinCount = s.specs.find((item) => item.id === id)?.pinCount ?? 0;
      rec.setPins(
        i,
        board ? boardPinState(board.peekPins(), pinCount) : emptyPinState()
      );
      rec.running[i] = board?.running ? 1 : 0;
    }
  }
  for (let i = 0; i < lay.parts.length; i++) {
    const load = lay.parts[i];
    if (!load) continue;
    rec.state[i] = motionRank(load.state);
    rec.partCurrent[i] = load.current;
    rec.partVoltage[i] = load.drive?.board
      ? boardVolts(s, load.drive.board.id)
      : load.supplyId
        ? boardNodeOf(s, load.supplyId)
        : 0;
  }
  for (let i = 0; i < lay.rangers.length; i++) {
    const ranger = lay.rangers[i];
    if (!ranger) continue;
    const index = lay.parts.length + i;
    rec.state[index] = 0;
    rec.partCurrent[index] = ranger.current;
    rec.partVoltage[index] = ranger.supplyId
      ? boardNodeOf(s, ranger.supplyId)
      : 0;
  }
  for (let i = 0; i < lay.supplies.length; i++) {
    const spec = lay.supplies[i];
    const live = spec ? s.supplyLive[spec.id] : undefined;
    rec.voltage[i] = live?.voltage ?? 0;
    rec.supplyCurrent[i] = live?.current ?? 0;
    rec.supplySoc[i] = live?.soc ?? Number.NaN;
  }
  const ledFrames = new Map<string, ReturnType<RailCircuit["takeLedFrame"]>>();
  const ledFrameOf = (supplyId: string) => {
    const cached = ledFrames.get(supplyId);
    if (cached) return cached;
    const circuit = s.rails.get(supplyId)?.circuit;
    if (!circuit) return undefined;
    const frame = full ? circuit.takeLedFrame() : undefined;
    if (frame) ledFrames.set(supplyId, frame);
    return frame;
  };
  for (let i = 0; i < lay.boards.length; i++) {
    const id = lay.boards[i];
    const board = s.boards.find((item) => item.id === id);
    rec.boardVoltage[i] = id ? boardVolts(s, id) : 0;
    rec.regulatorA[i] = id ? regulatorAmps(s, id) : 0;
    if (rec.ledOn[i]) {
      const supplyId = id ? s.boardPower.get(id)?.supplyId : undefined;
      const frame = supplyId ? ledFrameOf(supplyId) : undefined;
      const key = onboardLedPath(id);
      rec.ledCurrent[i] = !id
        ? 0
        : frame && key in frame.leds
          ? (frame.leds[key] ?? 0)
          : (ledCurrentOf(s, id) ?? 0);
    }
    rec.inReset[i] = board?.inReset ? 1 : 0;
    rec.belowSoa[i] = board && boardInSoa(s, board) ? 1 : 0;
  }
  for (let k = 0; k < rec.ledPaths.length; k++) {
    const row = rec.ledPaths[k];
    if (!row) continue;
    const supplyId = s.boardPower.get(row.board)?.supplyId;
    const frame = supplyId ? ledFrameOf(supplyId) : undefined;
    const group = supplyId ? s.rails.get(supplyId) : undefined;
    rec.ledAmps[k] = frame
      ? (frame.leds[row.path] ?? 0)
      : (group?.circuit.leds[row.path] ?? 0);
  }
}

export function openRecorder(s: SessionState) {
  s.recorder = null;
  s.layout = null;
  s.txSeen.clear();
  s.pendingNotes.length = 0;
  if (!s.sim) return;
  const joints: RecLayout["joints"] = [];
  const jointType = s.sim.mj.mjtObj.mjOBJ_JOINT.value;
  const limits = s.sim.model.jnt_range as Float64Array;
  const qposadr = s.sim.model.jnt_qposadr as Int32Array;
  const jntType = s.sim.model.jnt_type as Int32Array;
  const slide = s.sim.mj.mjtJoint.mjJNT_SLIDE.value;
  for (const [robot, names] of Object.entries(s.sim.index.jointNamesByRobot)) {
    for (const [joint, mjName] of Object.entries(names)) {
      const id = s.sim.mj.mj_name2id(s.sim.model, jointType, mjName);
      const type = jntType[id] ?? 0;
      // A ball joint's qpos is a quaternion. URDF has none; treat anything
      // that is not a slide as a hinge angle.
      const kind: JointLimitKind = type === slide ? "slide" : "hinge";
      joints.push({
        robot,
        joint,
        mj: mjName,
        lower: limits[id * 2] ?? 0,
        upper: limits[id * 2 + 1] ?? 0,
        kind,
        qposadr: qposadr[id] ?? 0,
      });
    }
  }
  const bodies: RecLayout["bodies"] = [];
  for (const [robot, names] of Object.entries(s.sim.index.linkNames)) {
    for (const [link, mj] of Object.entries(names)) {
      bodies.push({ robot, link, mj });
    }
  }
  const parts = s.loads.filter((load) => load.drive);
  const boardIds = s.boards.map((board) => board.id);
  s.layout = {
    joints,
    bodies,
    parts,
    rangers: s.rangers,
    supplies: s.supplySpecs,
    boards: boardIds,
  };
  s.recordingSeq += 1;
  s.recorder = new RunRecorder({
    id: `r${s.recordingSeq}`,
    manifest: manifestOf(s),
    joints: joints.map(({ robot, joint }) => ({ robot, joint })),
    bodies: bodies.map(({ robot, link }) => ({ robot, link })),
    parts: [
      ...parts.map((load) => load.partId),
      ...s.rangers.map((ranger) => ranger.spec.id),
    ],
    partRanger: [...parts.map(() => false), ...s.rangers.map(() => true)],
    supplies: s.supplySpecs.map((supply) => supply.id),
    boards: boardIds,
    pinWords: boardIds.map((id) =>
      pinWordCount(
        s.runPlan?.boards.find((board) => board.id === id)?.pinOrder.length ?? 0
      )
    ),
    boardLed: boardIds.map((id) => {
      const supplyId = s.boardPower.get(id)?.supplyId;
      const group = supplyId ? s.rails.get(supplyId) : undefined;
      return group?.circuit.ledPaths.includes(onboardLedPath(id)) ?? false;
    }),
    leds: boardIds.flatMap((id) => {
      const supplyId = s.boardPower.get(id)?.supplyId;
      const group = supplyId ? s.rails.get(supplyId) : undefined;
      return (group?.circuit.ledPaths ?? []).map((path) => ({
        board: id,
        path,
      }));
    }),
  });
  fillRecorder(s, true);
  s.recorder.commit(simMs(s));
  for (const board of s.boards) {
    if (!board.fault) continue;
    s.recorder.noteEvent({
      timeMs: simMs(s),
      kind: "fault",
      board: board.id,
      message: board.fault,
    });
  }
}

function catalogOf(part: RunPlan["parts"][number]): RecordingPartCatalog {
  return {
    ...(part.torqueNm !== undefined ? { torqueNm: part.torqueNm } : {}),
    ...(part.supply ? { supply: part.supply } : {}),
    ...(part.motor ? { motor: part.motor } : {}),
  };
}

function manifestOf(s: SessionState): RecordingManifest {
  const timestep = s.sim?.model.opt.timestep ?? DEFAULT_TIMESTEP_S;
  const which = s.sim?.model.opt.integrator ?? 3;
  const parts: RecordingManifest["parts"] = {};
  for (const part of s.runPlan?.parts ?? []) {
    if (parts[part.model]) continue;
    parts[part.model] = catalogOf(part);
  }
  return {
    mujoco: s.host.versions.mujoco,
    avr8js: s.host.versions.avr8js,
    timestep,
    integrator: INTEGRATORS[which] ?? String(which),
    frameMs: RECORD_FRAME_MS,
    worldSha256: s.worldSha256,
    boards: s.specs.map((spec) => ({
      id: spec.id,
      firmware: spec.firmware,
      sha256: s.firmwareSha.get(spec.id) ?? "",
    })),
    parts,
  };
}

export function recordStep(s: SessionState) {
  const rec = s.recorder;
  if (!rec?.enabled || !s.sim) {
    s.pendingNotes.length = 0;
    return;
  }
  const ms = simMs(s);
  fillRecorder(s, ms % RECORD_FRAME_MS === 0);
  for (const board of s.boards) {
    const text = board.peekTx();
    let seen = s.txSeen.get(board.id) ?? 0;
    if (text.length < seen) seen = 0;
    if (text.length > seen) {
      rec.noteSerial(board.id, text.slice(seen), ms);
      seen = text.length;
    }
    s.txSeen.set(board.id, seen);
  }
  for (const note of s.pendingNotes) {
    rec.noteEvent({
      timeMs: ms,
      kind: note.kind,
      board: note.board,
      ...(note.cause ? { cause: note.cause } : {}),
    });
  }
  s.pendingNotes.length = 0;
  rec.commit(ms);
}

export function record(s: SessionState, query: RecordQuery): RecordBody {
  if (!s.recorder || !s.sim) {
    return { op: "error", message: "world is not running" };
  }
  if (query.op === "config") {
    if (query.boundMs !== undefined) s.recorder.setBoundMs(query.boundMs);
    if (query.enabled !== undefined) s.recorder.enabled = query.enabled;
    return { op: "ack" };
  }
  if (query.op === "info") {
    return { op: "info", info: s.recorder.info(s.sim.data.time) };
  }
  if (query.op === "adc") {
    if (!s.adcTrace) return { op: "error", message: "ADC trace is off" };
    return { op: "adc", trace: { nodes: s.adcNodes, samples: s.adcSamples } };
  }
  if (query.op === "frame") {
    return {
      op: "frame",
      id: s.recorder.id,
      frame: s.recorder.frameAt(query.t),
    };
  }
  if (query.op === "timeline") {
    const info = s.recorder.info(s.sim.data.time);
    const read = s.recorder.read({
      from: query.from,
      to: query.to,
      tracks: [
        ...info.tracks.joints,
        ...info.tracks.supplies,
        ...info.tracks.parts,
      ],
      maxFrames: query.maxPoints,
    });
    const built = timelineFromRead(read);
    if (query.tracks === undefined) {
      return {
        op: "timeline",
        id: info.id,
        from: query.from,
        to: query.to,
        tracks: built.tracks,
        markers: built.markers,
      };
    }
    const shafts: Record<string, string> = {};
    for (const load of s.loads) {
      if (load.drive) shafts[load.partId] = load.drive.jointName;
    }
    const pins: Record<string, readonly string[]> = {};
    for (const board of s.runPlan?.boards ?? [])
      pins[board.id] = board.pinOrder;
    const probed = probeTracks(read, query.tracks, { shafts, pins });
    return {
      op: "timeline",
      id: info.id,
      from: query.from,
      to: query.to,
      tracks: [...built.tracks, ...probed.tracks],
      markers: built.markers,
      unrecorded: probed.unrecorded,
    };
  }
  return {
    op: "read",
    read: s.recorder.read({
      from: query.from,
      to: query.to,
      ...(query.tracks ? { tracks: query.tracks } : {}),
      ...(query.maxFrames !== undefined ? { maxFrames: query.maxFrames } : {}),
    }),
  };
}

export function answerRecord(
  s: SessionState,
  message: Extract<ToWorker, { type: "record" }>
) {
  const body: RecordBody =
    message.generation !== s.generation
      ? { op: "error", message: "world reloaded" }
      : record(s, message.query);
  post(s, {
    type: "record",
    generation: s.generation,
    request: message.request,
    body,
  });
}
