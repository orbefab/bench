import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  jointTrackId,
  supplyTrackId,
  type WorldServerMessage,
  type WorldState,
} from "@sfab-bench/contract";

import { BROWNOUT_RESET, FIRMWARE_RELOADED } from "@sfab-bench/engine-mcu";

import { closeRootWatches } from "./projects";
import {
  attachWorld,
  frameAt,
  readRecording,
  readSerial,
  recordingInfo,
  setRecordingBound,
  setRecordingEnabled,
  stopWorld,
} from "./world/host";
import {
  motionRank,
  RunRecorder as Recorder,
  type RunRecorder,
  recordingFootprint,
} from "./world/record";
import { readDraft, writeDraft } from "./world/selfcheck-draft";

/**
 * The run's recording. Sim time only. A world reload starts a new
 * recording; a hex restart does not. Scrub is per subscriber.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function msOf(t: number): number {
  return Math.round(t * 1000);
}

function close(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected) < 1e-4, `${label}: ${actual}`);
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function shoulderUpperRad(urdf: string): number {
  const block = urdf.match(/<joint[^>]*name="shoulder"[\s\S]*?<\/joint>/);
  const upper = block?.[0].match(/upper="([^"]+)"/);
  if (!upper?.[1]) throw new Error("shoulder limit");
  return Number(upper[1]);
}

function fill(
  rec: RunRecorder,
  sample: {
    joint?: number;
    voltage?: number;
    state?: "idle" | "moving" | "stall";
    current?: number;
    ddr?: number;
    brownout?: boolean;
    command?: number;
  }
) {
  rec.joint[0] = sample.joint ?? 0;
  rec.pose[3] = 1;
  rec.pulse[0] = Number.NaN;
  rec.command[0] = sample.command ?? Number.NaN;
  rec.state[0] = motionRank(sample.state ?? "idle");
  rec.partCurrent[0] = sample.current ?? 0.01;
  rec.voltage[0] = sample.voltage ?? 5;
  rec.supplyCurrent[0] = 0.06;
  rec.ddr[0] = sample.ddr ?? 0;
  rec.running[0] = 1;
  rec.brownout[0] = sample.brownout ? 1 : 0;
}

function unitRecorder(boundMs?: number): RunRecorder {
  return new Recorder({
    id: "unit",
    ...(boundMs !== undefined ? { boundMs } : {}),
    manifest: {
      mujoco: "3.14.0",
      avr8js: "0.21.1",
      timestep: 0.001,
      integrator: "implicitfast",
      frameMs: 10,
      worldSha256: "0".repeat(64),
      boards: [],
      parts: {},
    },
    joints: [{ robot: "arm", joint: "shoulder" }],
    bodies: [{ robot: "arm", link: "base" }],
    parts: ["servo"],
    supplies: ["usb"],
    boards: ["uno"],
  });
}

const regular = unitRecorder();
for (let ms = 0; ms <= 40; ms++) {
  const dip = ms === 5;
  fill(regular, {
    voltage: dip ? 1.2 : 5,
    state: dip ? "stall" : "idle",
    ddr: ms,
    joint: ms / 100,
  });
  regular.commit(ms);
}
const all = regular.read({ from: 0, to: 0.04 });
const times = all.frames.map((frame) => msOf(frame.t));
expect(
  times.join(",") === "0,10,20,30,40",
  `frames every 10 ms, saw ${times.join(",")}`
);
expect(msOf(regular.frameAt(0)?.t ?? -1) === 0, "frameAt at 0");
expect(msOf(regular.frameAt(0.005)?.t ?? -1) === 0, "frameAt between frames");
expect(msOf(regular.frameAt(0.01)?.t ?? -1) === 10, "frameAt on a frame");
expect(msOf(regular.frameAt(0.015)?.t ?? -1) === 10, "frameAt after a frame");
const early = regular.frameAt(0);
const closed = regular.frameAt(0.01);
expect(
  early?.parts.servo?.worst === "idle",
  "the dip is not on the earlier frame"
);
close(early?.supplies.usb?.minVoltage ?? 0, 5, "frame 0 voltage is nominal");
expect(
  closed?.parts.servo?.worst === "stall",
  "the 1 ms stall is on the closing frame"
);
close(closed?.supplies.usb?.minVoltage ?? 0, 1.2, "min voltage");
close(closed?.supplies.usb?.voltage ?? 0, 5, "the value at t recovered");
expect(closed?.boards.uno?.pins.ddr === 10, "pins are the sample at the frame");
console.log("recorder: 10 ms frames, frameAt, and the 1 ms dip");

const shaped = unitRecorder();
const marks: {
  ms: number;
  voltage: number;
  ddr: number;
  state: "idle" | "stall";
}[] = [
  { ms: 0, voltage: 0.4, ddr: 1, state: "idle" },
  { ms: 10, voltage: 5, ddr: 2, state: "idle" },
  { ms: 20, voltage: 5, ddr: 3, state: "stall" },
  { ms: 30, voltage: 5, ddr: 4, state: "idle" },
];
for (const mark of marks) {
  fill(shaped, mark);
  shaped.commit(mark.ms);
}
const down = shaped.read({ from: 0, to: 0.03, maxFrames: 2 });
expect(down.frames.length === 2, `downsampled to ${down.frames.length}`);
const first = down.frames[0];
const second = down.frames[1];
expect(
  msOf(first?.t ?? -1) === 10,
  "the first bucket picks its last real frame"
);
close(
  first?.supplies.usb?.voltage ?? 0,
  5,
  "the picked voltage is not blended"
);
close(
  first?.supplies.usb?.minVoltage ?? 0,
  0.4,
  "the skipped frame keeps its minimum voltage"
);
expect(first?.boards.uno?.pins.ddr === 2, "the pin mask is the picked frame's");
expect(msOf(second?.t ?? -1) === 30, "the second bucket picks the last frame");
expect(second?.parts.servo?.worst === "stall", "the skipped stall is kept");
expect(second?.boards.uno?.pins.ddr === 4, "the later pin mask is not blended");
console.log("recorder: downsample picks frames and keeps extremes");

const bounded = unitRecorder(30);
bounded.noteEvent({ timeMs: 0, kind: "reset", board: "uno" });
bounded.noteEvent({
  timeMs: 5,
  kind: "fault",
  board: "uno",
  message: "dip",
});
bounded.noteEvent({ timeMs: 10, kind: "reload", board: "uno" });
for (let ms = 0; ms <= 40; ms++) {
  fill(bounded, {});
  bounded.commit(ms);
}
const info = bounded.info(0.04);
expect(info.from > 0, `bound did not move from (${info.from})`);
expect(msOf(info.from) === 10, `from is ${info.from}`);
expect(bounded.frameAt(0) === null, "the dropped frame is gone");
expect(msOf(bounded.frameAt(0.01)?.t ?? -1) === 10, "the retained frame stays");
const kept = bounded.read({ from: 0, to: 1 });
expect(
  !kept.events.some((event) => event.kind === "reset"),
  "the event in the dropped front is gone"
);
expect(
  kept.events.some((event) => event.kind === "reload"),
  "the event on the new front stays"
);
expect(
  kept.events.some((event) => event.kind === "fault"),
  "an event inside the kept frame's window stays"
);
console.log(`recorder: bound reports from ${info.from} s`);

type Waiter = {
  seconds: number;
  resolve: (state: WorldState) => void;
  reject: (err: Error) => void;
};

function openTrace(project: string, worldRel: string) {
  const events: WorldServerMessage[] = [];
  const waiters: Waiter[] = [];
  const fail = (err: Error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(err);
  };
  const attached = attachWorld(project, worldRel, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      events.push(event);
      if (event.type === "error" && event.errors.length > 0) {
        fail(new Error(event.message ?? "world error"));
        return;
      }
      if (event.type !== "state") return;
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (!waiter) continue;
        if (Math.abs(event.state.simTime - waiter.seconds) > 0.0004) continue;
        waiters.splice(i, 1);
        waiter.resolve(event.state);
      }
    },
  });
  return {
    events,
    attached,
    at(seconds: number): Promise<WorldState> {
      const hit = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "state" &&
            Math.abs(event.state.simTime - seconds) <= 0.0004
        );
      if (hit?.type === "state") return Promise.resolve(hit.state);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(
            (waiter) => waiter.resolve === resolve
          );
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out at ${seconds.toFixed(3)} s`));
        }, 30000);
        waiters.push({
          seconds,
          resolve: (state) => {
            clearTimeout(timer);
            resolve(state);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
  };
}

function serialOf(
  events: { kind: string; board?: string; text?: string }[],
  board: string
): string {
  let text = "";
  for (const event of events) {
    if (event.kind === "serial" && event.board === board)
      text += event.text ?? "";
  }
  return text;
}

async function recordedRun(project: string, worldRel: string, totalMs: number) {
  const trace = openTrace(project, worldRel);
  const attached = await trace.attached;
  if ("error" in attached) throw new Error(attached.error);
  attached.step(totalMs);
  const state = await trace.at(totalMs / 1000);
  const read = await readRecording(project, worldRel, {
    from: 0,
    to: totalMs / 1000,
  });
  if ("error" in read) throw new Error(read.error);
  return { trace, attached, state, read };
}

const TARGETS = [10, 90, 120] as const;

function holdWindows(
  frames: {
    t: number;
    angle: number;
    command: number | null;
  }[]
) {
  const starts: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < frames.length; i++) {
    const command = frames[i]?.command ?? null;
    if (command === null) {
      prev = null;
      continue;
    }
    if (prev === null || Math.abs(command - prev) > 2) starts.push(i);
    prev = command;
  }
  const holds: { end: number; rows: typeof frames }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = starts[i + 1];
    if (from === undefined) continue;
    const start = frames[from]?.t;
    if (start === undefined) continue;
    const end =
      to === undefined
        ? (frames[frames.length - 1]?.t ?? start) + 0.01
        : (frames[to]?.t ?? start);
    if (end - start < 0.9 || end - start > 1.15) continue;
    holds.push({
      end,
      rows: frames.filter((row) => row.t >= start && row.t < end),
    });
  }
  return holds;
}

const demo1 = await recordedRun(
  armDir,
  "parts/sfab/arm-bench@1.0.0.json",
  3500
);
try {
  const foot = await recordingInfo(armDir, "parts/sfab/arm-bench@1.0.0.json");
  if ("error" in foot) throw new Error(foot.error);
  const bytes = recordingFootprint({
    joints: foot.tracks.joints.length,
    bodies: foot.tracks.bodies.length,
    parts: foot.tracks.parts.length,
    supplies: foot.tracks.supplies.length,
    boards: foot.tracks.boards.length,
  });
  console.log(
    `fixture: ${foot.tracks.bodies.length} bodies, ${foot.tracks.joints.length} joint, ` +
      `${bytes.bytesPerFrame} B/frame, ${(bytes.bytesPerMinute / 1024).toFixed(1)} KiB/min`
  );
  const rows = demo1.read.frames.map((frame) => ({
    t: frame.t,
    angle: deg(frame.joints.arm?.shoulder ?? Number.NaN),
    command: frame.parts.servo?.commandDeg ?? null,
  }));
  const holds = holdWindows(rows);
  expect(holds.length >= 3, `recorded holds ${holds.length}`);
  const errors: number[] = [];
  for (let i = 0; i < 3; i++) {
    const slot = holds[i];
    const target = TARGETS[i];
    if (!slot || target === undefined) throw new Error("hold missing");
    const tail = slot.rows.filter((row) => row.t >= slot.end - 0.2);
    expect(tail.length >= 10, `hold ${i} tail ${tail.length}`);
    let maxErr = 0;
    for (const row of tail) {
      const err = Math.abs(row.angle - (row.command ?? target));
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr <= 2, `hold ${target}° error ${maxErr.toFixed(3)}°`);
    errors.push(maxErr);
  }
  expect(
    !demo1.read.events.some((event) => event.kind === "reset"),
    "demo 1 recorded a reset"
  );
  let minV = Infinity;
  for (const frame of demo1.read.frames) {
    const voltage = frame.boards.uno?.minVoltage ?? 0;
    if (voltage < minV) minV = voltage;
    expect(voltage >= 4.5, `recorded rail ${voltage} V at ${frame.t}`);
  }
  const printed = serialOf(demo1.read.events, "uno");
  const ring = readSerial(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno", 0);
  if ("error" in ring) throw new Error(ring.error);
  expect(
    printed === ring.text,
    `recording serial ${JSON.stringify(printed)} ring ${JSON.stringify(ring.text)}`
  );
  let cursor = 0;
  for (const event of demo1.read.events) {
    if (event.kind !== "serial" || event.board !== "uno") continue;
    expect(
      event.from === cursor && event.to === cursor + event.text.length,
      "serial offsets overlap"
    );
    cursor = event.to;
  }
  expect(cursor === ring.next, `serial offset ${cursor} ring ${ring.next}`);
  expect(printed.includes("10\r\n"), "the hold line was not recorded");
  console.log(
    `demo 1 recording: last-200ms max error ${errors.map((item) => item.toFixed(3)).join(", ")}°, ` +
      `min supply ${minV.toFixed(3)} V, no reset`
  );
} finally {
  demo1.attached.detach();
  await stopWorld(armDir, "parts/sfab/arm-bench@1.0.0.json");
}

const demo2 = await recordedRun(
  armDir,
  "parts/sfab/arm-stall@1.0.0.json",
  2000
);
try {
  const resets = demo2.read.events.filter((event) => event.kind === "reset");
  const reboots = demo2.read.events.filter((event) => event.kind === "reboot");
  let minV = Infinity;
  let minAt = 0;
  const start = demo2.read.frames[0]?.joints.arm?.shoulder ?? 0;
  const upper = shoulderUpperRad(
    readFileSync(join(armDir, "robot/arm.urdf"), "utf8")
  );
  for (const frame of demo2.read.frames) {
    const voltage = frame.boards.uno?.minVoltage ?? 5;
    if (voltage < minV) {
      minV = voltage;
      minAt = frame.t;
    }
    const angle = frame.joints.arm?.shoulder ?? start;
    expect(
      angle < upper,
      `arm ${deg(angle).toFixed(3)}° at ${frame.t.toFixed(3)} s reached the stop ${deg(upper).toFixed(3)}°`
    );
  }
  // The capacitors hold the board node during the brownout.
  expect(Math.abs(minV - 2.099) <= 0.02, `recorded minimum ${minV} V`);
  expect(resets.length >= 1, "no recorded reset within 2 s");
  expect(
    reboots.length === resets.length,
    `reboots ${reboots.length} resets ${resets.length}`
  );
  const marker = serialOf(demo2.read.events, "uno");
  const markerCount = marker.split(BROWNOUT_RESET).length - 1;
  expect(
    markerCount === reboots.length,
    `reboots ${reboots.length} markers ${markerCount}`
  );
  const firstReboot = reboots[0];
  const markerEvent = demo2.read.events.find(
    (event) => event.kind === "serial" && event.text.includes("brownout reset")
  );
  expect(
    firstReboot && markerEvent && msOf(firstReboot.t) === msOf(markerEvent.t),
    "the reboot and its serial line differ"
  );
  const firstReset = resets[0];
  expect(firstReset && firstReboot, "reset and reboot");
  if (!firstReset || !firstReboot) throw new Error("unreachable");
  // The rail recovers on the step after the assert, so the 66 ms hold
  // is one millisecond less than the reset-to-reboot gap.
  const gapMs = msOf(firstReboot.t) - msOf(firstReset.t);
  expect(Math.abs(gapMs - 67) <= 1, `reset to reboot ${gapMs} ms`);
  for (const frame of demo2.read.frames) {
    if (frame.t <= firstReset.t || frame.t >= firstReboot.t) continue;
    const board = frame.boards.uno;
    expect(
      board?.brownout === true &&
        board.pins.ddr === 0 &&
        board.pins.level === 0,
      `driven at ${frame.t.toFixed(3)} s`
    );
  }
  console.log(
    `demo 2 recording: min ${minV.toFixed(3)} V at ${minAt.toFixed(3)} s, ` +
      `reset ${firstReset.t.toFixed(3)} s, reboot ${firstReboot.t.toFixed(3)} s ` +
      `(${gapMs} ms, ${resets.length} cycles)`
  );
} finally {
  demo2.attached.detach();
  await stopWorld(armDir, "parts/sfab/arm-stall@1.0.0.json");
}

const reloadRoot = mkdtempSync(join(tmpdir(), "sfab-record-reload-"));
try {
  cpSync(armDir, reloadRoot, { recursive: true });
  const trace = openTrace(reloadRoot, "parts/sfab/arm-bench@1.0.0.json");
  const attached = await trace.attached;
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(200);
    const before = await trace.at(0.2);
    const id = before.recording?.id;
    expect(id, "the run has no recording");
    const hexPath = join(reloadRoot, "firmware/hold/hold.hex");
    const from = trace.events.length;
    writeFileSync(hexPath, readFileSync(hexPath));
    const sawReload = () =>
      trace.events
        .slice(from)
        .some(
          (event) =>
            event.type === "serial" && event.text.includes("firmware reloaded")
        );
    const started = Date.now();
    while (!sawReload()) {
      if (Date.now() - started > 10000) throw new Error("hex reload timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const afterHex = await readRecording(
      reloadRoot,
      "parts/sfab/arm-bench@1.0.0.json",
      {
        from: 0,
        to: 1,
      }
    );
    if ("error" in afterHex) throw new Error(afterHex.error);
    const reloads = afterHex.events.filter((event) => event.kind === "reload");
    expect(reloads.length === 1, `reload events ${reloads.length}`);
    expect(msOf(reloads[0]?.t ?? -1) === 200, `reload at ${reloads[0]?.t}`);
    const still = await recordingInfo(
      reloadRoot,
      "parts/sfab/arm-bench@1.0.0.json"
    );
    if ("error" in still) throw new Error(still.error);
    expect(still.id === id, `hex restart changed recording ${still.id}`);
    const worldPath = join(reloadRoot, "parts/sfab/arm-bench@1.0.0.json");
    const at = trace.events.length;
    writeFileSync(worldPath, readFileSync(worldPath));
    const startedDoc = Date.now();
    let nextId = "";
    while (!nextId) {
      if (Date.now() - startedDoc > 10000)
        throw new Error("world reload timed out");
      const hit = trace.events
        .slice(at)
        .find(
          (event) =>
            event.type === "state" &&
            event.state.recording &&
            event.state.recording.id !== id &&
            event.state.simTime < 0.05
        );
      if (hit?.type === "state" && hit.state.recording) {
        nextId = hit.state.recording.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(nextId !== id, "a world edit kept the recording");
    console.log(
      `reload: hex kept ${id} with one ${FIRMWARE_RELOADED.trim()} at 0.200 s; document edit started ${nextId}`
    );
  } finally {
    attached.detach();
    await stopWorld(reloadRoot, "parts/sfab/arm-bench@1.0.0.json");
  }
} finally {
  rmSync(reloadRoot, { recursive: true, force: true });
}

const seekTraceA: WorldServerMessage[] = [];
const seekTraceB: WorldServerMessage[] = [];
const seekA = await attachWorld(armDir, "parts/sfab/arm-bench@1.0.0.json", {
  sender: { kind: "loopback", label: "Mac" },
  onEvent(event) {
    seekTraceA.push(event);
  },
});
const seekB = await attachWorld(armDir, "parts/sfab/arm-bench@1.0.0.json", {
  sender: { kind: "paired", label: "Quest" },
  onEvent(event) {
    seekTraceB.push(event);
  },
});
if ("error" in seekA) throw new Error(seekA.error);
if ("error" in seekB) throw new Error(seekB.error);
try {
  seekA.step(100);
  const started = Date.now();
  while (true) {
    const last = [...seekTraceA]
      .reverse()
      .find((event) => event.type === "state");
    const other = [...seekTraceB]
      .reverse()
      .find((event) => event.type === "state");
    if (
      last?.type === "state" &&
      other?.type === "state" &&
      msOf(last.state.simTime) === 100 &&
      msOf(other.state.simTime) === 100
    ) {
      break;
    }
    if (Date.now() - started > 20000) throw new Error("seek setup timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const beforeB = seekTraceB.length;
  const beforeA = seekTraceA.length;
  const frame = await seekA.seek(0.05, "seek-a");
  if ("error" in frame) throw new Error(frame.error);
  expect(
    frame.type === "frame" && frame.frame !== null,
    "the seeker got no frame"
  );
  expect(msOf(frame.t) === 50, `frame at ${frame.t}`);
  expect(seekTraceB.length === beforeB, "the other subscriber heard the seek");
  expect(
    !seekTraceA.slice(beforeA).some((event) => event.type === "frame"),
    "a seek is not broadcast, even to the sender"
  );
  const last = [...seekTraceA]
    .reverse()
    .find((event) => event.type === "state");
  expect(
    last?.type === "state" &&
      msOf(last.state.simTime) === 100 &&
      last.state.playing === false,
    "seek moved the shared run"
  );
  const exact = await frameAt(armDir, "parts/sfab/arm-bench@1.0.0.json", 0.05);
  if (!exact || "error" in exact) throw new Error("frameAt missed 0.05 s");
  expect(msOf(exact.t) === 50, "host frameAt");
  console.log(
    "per client: one seek, the other subscriber stays on the live run"
  );
} finally {
  seekA.detach();
  seekB.detach();
  await stopWorld(armDir, "parts/sfab/arm-bench@1.0.0.json");
}

const pairRoot = mkdtempSync(join(tmpdir(), "sfab-record-pair-"));
try {
  cpSync(armDir, pairRoot, { recursive: true });
  const world = readDraft(pairRoot, "parts/sfab/arm-bench@1.0.0.json");
  const robot = world.robots[0];
  const uno = world.boards[0];
  const servo = world.parts[0];
  const supply = world.supplies[0];
  if (!robot || !uno || !servo?.drives || !supply)
    throw new Error("fixture shape");
  world.robots = [
    { ...robot, id: "hold-arm" },
    {
      ...robot,
      id: "stall-arm",
      pose: { position: [0.3, 0, 0], rotation: [1, 0, 0, 0] },
    },
  ];
  world.boards = [
    {
      ...uno,
      id: "hold",
      firmware: "firmware/hold/hold.hex",
      source: "firmware/hold/hold.ino",
    },
    {
      ...uno,
      id: "stall",
      firmware: "firmware/stall/stall.hex",
      source: "firmware/stall/stall.ino",
      pose: { position: [0.4, 0, 0.006], rotation: [1, 0, 0, 0] },
    },
  ];
  world.parts = [
    {
      ...servo,
      id: "hold-servo",
      drives: { robot: "hold-arm", joint: "shoulder" },
    },
    {
      ...servo,
      id: "stall-servo",
      drives: { robot: "stall-arm", joint: "shoulder" },
    },
  ];
  world.supplies = [
    { ...supply, id: "usb-hold" },
    {
      ...supply,
      id: "usb-stall",
      kind: "bench",
      voltage: 5,
      currentLimit: 0.3,
      rSeries: 0.05,
    },
  ];
  world.wires = [
    ["usb-hold.5V", "hold.5V"],
    ["usb-hold.GND", "hold.GND"],
    ["hold.D9", "hold-servo.signal"],
    ["hold.5V", "hold-servo.V+"],
    ["hold.GND", "hold-servo.GND"],
    ["usb-stall.5V", "stall.5V"],
    ["usb-stall.GND", "stall.GND"],
    ["stall.D9", "stall-servo.signal"],
    ["stall.5V", "stall-servo.V+"],
    ["stall.GND", "stall-servo.GND"],
  ];
  writeDraft(pairRoot, "split.world.json", world);
  const split = await recordedRun(pairRoot, "split.world.json", 2000);
  try {
    const tracks = split.state.recording
      ? await recordingInfo(pairRoot, "split.world.json")
      : null;
    if (!tracks || "error" in tracks) throw new Error("no split recording");
    expect(
      tracks.tracks.joints.includes(jointTrackId("hold-arm", "shoulder")) &&
        tracks.tracks.joints.includes(jointTrackId("stall-arm", "shoulder")),
      "both joints are recorded"
    );
    expect(
      tracks.tracks.supplies.includes(supplyTrackId("usb-hold")) &&
        tracks.tracks.supplies.includes(supplyTrackId("usb-stall")),
      "both supplies are recorded"
    );
    let holdMin = Infinity;
    for (const frame of split.read.frames) {
      const voltage = frame.boards.hold?.minVoltage ?? 0;
      if (voltage < holdMin) holdMin = voltage;
      expect(voltage >= 4.5, `hold rail ${voltage}`);
    }
    const stallSag = split.read.frames.some(
      (frame) => (frame.boards.stall?.minVoltage ?? 5) < 2.675
    );
    expect(stallSag, "the stall supply never sagged");
    const resets = split.read.events.filter((event) => event.kind === "reset");
    expect(
      resets.length >= 1 && resets.every((event) => event.board === "stall"),
      "a reset was attributed to the hold board"
    );
    expect(
      serialOf(split.read.events, "stall").includes("boot"),
      "stall serial missing"
    );
    expect(
      !serialOf(split.read.events, "hold").includes("boot\r\n"),
      "hold printed the stall firmware"
    );
    console.log(
      `two robots: hold rail ≥ ${holdMin.toFixed(2)} V, stall resets on its own board`
    );
  } finally {
    split.attached.detach();
    await stopWorld(pairRoot, "split.world.json");
  }
} finally {
  rmSync(pairRoot, { recursive: true, force: true });
}

async function factor(enabled: boolean): Promise<number> {
  const trace = openTrace(armDir, "parts/sfab/arm-bench@1.0.0.json");
  const attached = await trace.attached;
  if ("error" in attached) throw new Error(attached.error);
  try {
    if (!enabled) {
      const off = await setRecordingEnabled(
        armDir,
        "parts/sfab/arm-bench@1.0.0.json",
        false
      );
      if ("error" in off) throw new Error(off.error);
    }
    attached.step(200);
    await trace.at(0.2);
    const start = performance.now();
    attached.step(1500);
    await trace.at(1.7);
    const wall = performance.now() - start;
    return 1500 / wall;
  } finally {
    attached.detach();
    await stopWorld(armDir, "parts/sfab/arm-bench@1.0.0.json");
  }
}

const withRecorder = await factor(true);
const without = await factor(false);
const ratio = without > 0 ? withRecorder / without : 0;
if (process.env.BENCH_TIMINGS === "1")
  console.log(
    `real-time factor with recorder ${withRecorder.toFixed(2)}×, without ${without.toFixed(2)}× (${(ratio * 100).toFixed(0)}%)`
  );
expect(
  ratio >= 0.8,
  `recorder factor ${withRecorder.toFixed(2)} is below 80% of ${without.toFixed(2)}`
);

const boundTrace = openTrace(armDir, "parts/sfab/arm-bench@1.0.0.json");
const boundHandle = await boundTrace.attached;
if ("error" in boundHandle) throw new Error(boundHandle.error);
try {
  const set = await setRecordingBound(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    40
  );
  if ("error" in set) throw new Error(set.error);
  boundHandle.step(200);
  await boundTrace.at(0.2);
  const boundedInfo = await recordingInfo(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json"
  );
  if ("error" in boundedInfo) throw new Error(boundedInfo.error);
  expect(
    boundedInfo.from > 0,
    `injected bound left from at ${boundedInfo.from}`
  );
  console.log(
    `injected bound: from ${boundedInfo.from.toFixed(3)} s after 0.200 s`
  );
} finally {
  boundHandle.detach();
  await stopWorld(armDir, "parts/sfab/arm-bench@1.0.0.json");
  closeRootWatches();
}

console.log("recording.selfcheck ok");
