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
import { Worker } from "node:worker_threads";

import type { WorldServerMessage } from "@sfab-bench/contract";
import { compileWorld, ensureMujocoCompiler } from "@sfab-bench/engine-body";
import { RX_BACKLOG } from "@sfab-bench/engine-mcu";

import { handleProjectFile } from "./cad-pkg";
import { closeRootWatches, listProjectFiles } from "./projects";
import { projectReal, readerFor } from "./world/files";
import {
  attachWorld,
  boardRx,
  faultWorld,
  readSerial,
  stopWorld,
  type WorldHandle,
  worldWorkerCount,
  worldWorkerEntry,
} from "./world/host";
import { planWorld } from "./world/plan";
import { readDraft, writeDraft } from "./world/selfcheck-draft";
import type { FromWorker, ToWorker } from "./world/worker";

/**
 * The arm fixture, sim time only. Wall-clock play is not what this checks:
 * `step(n)` advances exactly n milliseconds of simulation.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitUntil(
  pred: () => boolean,
  label: string,
  ms = 8000
): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timed out: ${label}`));
    }, ms);
    const poll = setInterval(() => {
      if (!pred()) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 15);
  });
}

const rootReal = projectReal(armDir);
expect(rootReal, "arm fixture resolves");
if (!rootReal) throw new Error("unreachable");
const planned = planWorld(rootReal, "parts/sfab/arm-bench@1.0.0.json");
expect(
  planned.ok,
  planned.ok ? "" : planned.errors.map((error) => error.message).join("; ")
);
if (!planned.ok) throw new Error("unreachable");
const compiled = await compileWorld(
  planned.plan,
  readerFor(rootReal, "parts/sfab/arm-bench@1.0.0.json")
);
expect(
  compiled.ok,
  `compile: ${compiled.ok ? "" : compiled.errors.map((e) => e.message).join("; ")}`
);
if (!compiled.ok) throw new Error("unreachable");
const { index } = compiled;
expect(
  index.nbody >= 3,
  `bodies ${index.nbody} (${index.bodyNames.join(",")})`
);
expect(index.bodyNames.includes("world"), "world body");
expect(
  index.bodyNames.includes("arm/base"),
  `base body in ${index.bodyNames.join(",")}`
);
expect(
  index.bodyNames.includes("arm/upper_arm"),
  `upper arm body in ${index.bodyNames.join(",")}`
);
expect(
  index.geomNames.includes("ground"),
  `ground geom in ${index.geomNames.join(",")}`
);
expect(
  index.njnt === 1,
  `joints ${index.njnt} (${index.jointNames.join(",")})`
);
expect(index.jointNames.join(",") === "arm/shoulder", "shoulder joint");
expect(index.nu === 1, `actuators ${index.nu}`);
expect(index.actuatorNames.join(",") === "servo", "servo actuator");
expect(
  index.nmesh === 2,
  `meshes ${index.nmesh} (${index.meshNames.join(",")})`
);
expect(index.parts.servo === 0, `servo actuator id ${index.parts.servo}`);
expect(
  index.joints.arm?.shoulder === 0,
  `shoulder qpos ${index.joints.arm?.shoulder}`
);
expect((index.links.arm?.base ?? -1) > 0, "base body id");
expect((index.links.arm?.upper_arm ?? -1) > 0, "upper_arm body id");
compiled.model.delete();
compiled.vfs.delete();

const stripped = ensureMujocoCompiler(
  readFileSync(join(armDir, "robot/arm.urdf"), "utf8").replace(
    /<mujoco>[\s\S]*?<\/mujoco>\s*/,
    ""
  )
);
expect(stripped.includes('fusestatic="false"'), "injected fusestatic");
expect(stripped.includes('discardvisual="false"'), "injected discardvisual");
const keptCompiler = ensureMujocoCompiler(
  `<robot name="arm"><mujoco><compiler balanceinertia="true" fusestatic="true" meshdir="meshes"/></mujoco></robot>`
);
expect(
  keptCompiler.includes('balanceinertia="true"'),
  `balanceinertia survived: ${keptCompiler}`
);
expect(keptCompiler.includes('fusestatic="false"'), "fusestatic overridden");
expect(
  keptCompiler.includes('discardvisual="false"'),
  "discardvisual overridden"
);
expect(
  keptCompiler.includes('meshdir=""'),
  `meshdir overridden: ${keptCompiler}`
);
const bareRoot = mkdtempSync(join(tmpdir(), "sfab-world-bare-"));
cpSync(armDir, bareRoot, { recursive: true });
writeFileSync(
  join(bareRoot, "robot/arm.urdf"),
  readFileSync(join(armDir, "robot/arm.urdf"), "utf8").replace(
    /<mujoco>[\s\S]*?<\/mujoco>\s*/,
    ""
  )
);
const bareReal = projectReal(bareRoot);
expect(bareReal, "bare copy resolves");
if (!bareReal) throw new Error("unreachable");
const barePlanned = planWorld(bareReal, "parts/sfab/arm-bench@1.0.0.json");
expect(
  barePlanned.ok,
  barePlanned.ok
    ? ""
    : barePlanned.errors.map((error) => error.message).join("; ")
);
if (!barePlanned.ok) throw new Error("unreachable");
const bare = await compileWorld(
  barePlanned.plan,
  readerFor(bareReal, "parts/sfab/arm-bench@1.0.0.json")
);
expect(
  bare.ok,
  `bare urdf compile: ${bare.ok ? "" : bare.errors.map((e) => e.code).join(",")}`
);
if (bare.ok) {
  expect(bare.index.bodyNames.includes("arm/base"), "bare urdf keeps base");
  expect(
    bare.index.bodyNames.includes("arm/upper_arm"),
    "bare urdf keeps upper_arm"
  );
  bare.model.delete();
  bare.vfs.delete();
}
rmSync(bareRoot, { recursive: true, force: true });

const restRoot = mkdtempSync(join(tmpdir(), "sfab-world-rest-"));
try {
  cpSync(armDir, restRoot, { recursive: true });
  writeDraft(restRoot, "rest.world.json", {
    environment: { ground: { plane: false }, gravity: [0, 0, 0] },
    robots: [
      {
        id: "arm",
        urdf: "robot/arm.urdf",
        pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
      },
    ],
    boards: [],
    supplies: [],
    parts: [],
    wires: [],
  });
  const restReal = projectReal(restRoot);
  expect(restReal, "zero-g copy resolves");
  if (!restReal) throw new Error("unreachable");
  const restPlan = planWorld(restReal, "rest.world.json");
  expect(
    restPlan.ok,
    restPlan.ok ? "" : restPlan.errors.map((error) => error.message).join("; ")
  );
  if (!restPlan.ok) throw new Error("unreachable");
  const rest = await compileWorld(
    restPlan.plan,
    readerFor(restReal, "rest.world.json")
  );
  expect(
    rest.ok,
    `zero-g compile: ${rest.ok ? "" : rest.errors.map((error) => error.message).join("; ")}`
  );
  if (!rest.ok) throw new Error("unreachable");
  const data = new rest.mj.MjData(rest.model);
  const qpos = data.qpos as Float64Array;
  const q0 = qpos[0] ?? 0;
  for (let i = 0; i < 1000; i++) rest.mj.mj_step(rest.model, data);
  const q1 = qpos[0] ?? 0;
  expect(q0 === q1, `zero gravity moved the shoulder from ${q0} to ${q1}`);
  console.log("zero gravity: unpowered shoulder stays at rest");
  data.delete();
  rest.model.delete();
  rest.vfs.delete();
} finally {
  rmSync(restRoot, { recursive: true, force: true });
}

const worker = new Worker(worldWorkerEntry());
const fromWorker: FromWorker[] = [];
worker.on("message", (message: FromWorker) => {
  fromWorker.push(message);
});
worker.postMessage({
  type: "load",
  project: armDir,
  world: "parts/sfab/arm-bench@1.0.0.json",
  generation: 1,
} satisfies ToWorker);
await withTimeout(
  waitUntil(
    () => fromWorker.some((message) => message.type === "ready"),
    "worker ready",
    20000
  ),
  20000,
  "worker ready"
);
const ready = fromWorker.find((message) => message.type === "ready");
if (!ready || ready.type !== "ready") {
  throw new Error("worker did not become ready");
}
expect(ready.counts.nbody >= 3, `worker bodies ${ready.counts.nbody}`);
expect(ready.counts.njnt === 1, "worker joint count");
expect(ready.counts.nu === 1, "worker actuator count");
expect(ready.counts.nmesh === 2, "worker mesh count");
expect(
  ready.counts.actuatorNames.join(",") === "servo",
  "worker actuator name"
);
await waitUntil(
  () => fromWorker.some((message) => message.type === "state"),
  "initial state"
);
worker.postMessage({
  type: "setTarget",
  partId: "servo",
  radians: Math.PI / 2,
  generation: 1,
} satisfies ToWorker);
worker.postMessage({ type: "step", n: 2000, generation: 1 } satisfies ToWorker);
await withTimeout(
  waitUntil(
    () =>
      fromWorker.some(
        (message) => message.type === "state" && message.state.simTime > 1
      ),
    "stepped state",
    20000
  ),
  20000,
  "stepped state"
);
const stepped = fromWorker.find(
  (message) => message.type === "state" && message.state.simTime > 1
);
if (!stepped || stepped.type !== "state") {
  throw new Error("stepped state missing");
}
const shoulder = stepped.state.joints.arm?.shoulder ?? Number.NaN;
const shoulderDeg = deg(shoulder);
// The wired servo overrides setTarget, so follow the sketch's command.
const commanded = stepped.state.parts?.servo?.commandDeg ?? Number.NaN;
expect(
  Math.abs(shoulderDeg - commanded) < 2,
  `shoulder ${shoulderDeg.toFixed(3)}° is within 2° of the command ${commanded}`
);
expect(
  stepped.state.simTime.toFixed(3) === "2.000",
  `simTime ${stepped.state.simTime}`
);
expect(stepped.state.playing === false, "step does not start play");
console.log(
  `arm step: shoulder ${shoulderDeg.toFixed(3)}° simTime ${stepped.state.simTime.toFixed(3)}s bodies ${index.nbody} joints ${index.njnt} actuators ${index.nu} meshes ${index.nmesh}`
);
const workerExit = new Promise<number>((resolve) => {
  worker.once("exit", (code) => resolve(code));
});
await worker.terminate();
await workerExit;

const shared = mkdtempSync(join(tmpdir(), "sfab-world-host-"));
cpSync(armDir, shared, { recursive: true });
const eventsA: WorldServerMessage[] = [];
const eventsB: WorldServerMessage[] = [];
let handleA: WorldHandle | null = null;
let handleB: WorldHandle | null = null;
try {
  const attachedA = await withTimeout(
    attachWorld(shared, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Headset A" },
      onEvent(event) {
        eventsA.push(event);
      },
    }),
    20000,
    "attach A"
  );
  if ("error" in attachedA) throw new Error(String(attachedA.error));
  handleA = attachedA;
  const attachedB = await withTimeout(
    attachWorld(shared, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Headset B" },
      onEvent(event) {
        eventsB.push(event);
      },
    }),
    20000,
    "attach B"
  );
  if ("error" in attachedB) throw new Error(String(attachedB.error));
  handleB = attachedB;
  expect(
    worldWorkerCount() === 1,
    `one worker while shared, saw ${worldWorkerCount()}`
  );
  const stateA = eventsA.find((event) => event.type === "state");
  const stateB = eventsB.find((event) => event.type === "state");
  expect(
    stateA?.type === "state" && stateB?.type === "state",
    "both got a state"
  );
  if (stateA?.type === "state" && stateB?.type === "state") {
    expect(stateA.state.simTime === stateB.state.simTime, "shared simTime");
    expect(
      stateA.state.playing === false && stateB.state.playing === false,
      "starts paused"
    );
  }
  const markA = eventsA.length;
  const markB = eventsB.length;
  handleA.pause("tab-a");
  await waitUntil(
    () =>
      eventsB.some(
        (event) => event.type === "command" && event.command === "pause"
      ),
    "pause seen by B"
  );
  const pause = eventsB.find((event) => event.type === "command");
  expect(pause?.type === "command", "B saw a command");
  if (pause?.type === "command") {
    expect(pause.command === "pause", "command is pause");
    expect(pause.by.kind === "paired", `sender kind ${pause.by.kind}`);
    expect(
      pause.by.kind === "paired" && pause.by.label === "Headset A",
      "sender is A"
    );
    expect(pause.nonce === "tab-a", "B receives A's nonce");
  }
  const eventsC: WorldServerMessage[] = [];
  const attachedC = await withTimeout(
    attachWorld(shared, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Headset C" },
      onEvent(event) {
        eventsC.push(event);
      },
    }),
    20000,
    "attach C"
  );
  if ("error" in attachedC) throw new Error(String(attachedC.error));
  const lateState = eventsC.findIndex((event) => event.type === "state");
  const lateCommand = eventsC.find((event) => event.type === "command");
  expect(lateState === 0, "late joiner gets state first");
  expect(lateCommand?.type === "command", "late joiner gets the last command");
  if (lateCommand?.type === "command") {
    expect(lateCommand.command === "pause", "late command is pause");
    expect(
      lateCommand.by.kind === "paired" && lateCommand.by.label === "Headset A",
      "late joiner learns A paused"
    );
    expect(lateCommand.nonce === "tab-a", "late joiner receives A's nonce");
  }
  attachedC.detach();
  handleA.step(10);
  const sawStep = (events: WorldServerMessage[], from: number) =>
    events
      .slice(from)
      .some((event) => event.type === "state" && event.state.simTime > 0);
  await waitUntil(() => sawStep(eventsA, markA), "A saw the step");
  await waitUntil(() => sawStep(eventsB, markB), "B saw the step");
  const seqA = eventsA.slice(markA).filter((event) => event.type === "state");
  const seqB = eventsB.slice(markB).filter((event) => event.type === "state");
  expect(
    seqA.length > 0 && seqA.length === seqB.length,
    `state sequence length ${seqA.length} vs ${seqB.length}`
  );
  expect(
    JSON.stringify(seqA) === JSON.stringify(seqB),
    "subscribers saw the same states"
  );

  handleA.play();
  await waitUntil(
    () =>
      eventsB.some((event) => event.type === "state" && event.state.playing),
    "B sees play"
  );
  const beforeStep = eventsB.length;
  handleA.step(5);
  await waitUntil(
    () =>
      eventsB
        .slice(beforeStep)
        .some((event) => event.type === "command" && event.command === "pause"),
    "step while playing pauses"
  );
  const stepPause = eventsB
    .slice(beforeStep)
    .find((event) => event.type === "command");
  expect(stepPause?.type === "command", "step broadcast a command");
  if (stepPause?.type === "command") {
    expect(stepPause.command === "pause", "step's command is pause");
    expect(
      stepPause.by.kind === "paired" && stepPause.by.label === "Headset A",
      "step pause names A"
    );
    expect(stepPause.nonce === undefined, "a step pause has no client nonce");
  }
  await waitUntil(
    () =>
      eventsB
        .slice(beforeStep)
        .some(
          (event) =>
            event.type === "state" &&
            !event.state.playing &&
            event.state.simTime > 0
        ),
    "step settled paused"
  );

  const beforeReload = eventsB.length;
  writeFileSync(
    join(shared, "parts/sfab/arm-bench@1.0.0.json"),
    readFileSync(join(shared, "parts/sfab/arm-bench@1.0.0.json"))
  );
  await waitUntil(() => {
    const slice = eventsB.slice(beforeReload);
    const reloadedAt = slice.findIndex((event) => event.type === "reloaded");
    if (reloadedAt < 0) return false;
    return slice.slice(reloadedAt).some((event) => event.type === "state");
  }, "state after reload");
  const slice = eventsB.slice(beforeReload);
  const reloadedAt = slice.findIndex((event) => event.type === "reloaded");
  const after = slice.slice(reloadedAt).find((event) => event.type === "state");
  expect(after?.type === "state", "state after reload");
  if (after?.type === "state") {
    expect(after.state.playing === false, "reload pauses");
    expect(after.state.simTime === 0, `reload simTime ${after.state.simTime}`);
  }
} finally {
  handleA?.detach();
  handleB?.detach();
  await stopWorld(shared, "parts/sfab/arm-bench@1.0.0.json");
  rmSync(shared, { recursive: true, force: true });
}
expect(worldWorkerCount() === 0, `worker leaked (${worldWorkerCount()})`);

const bad = mkdtempSync(join(tmpdir(), "sfab-world-bad-"));
try {
  cpSync(armDir, bad, { recursive: true });
  writeFileSync(
    join(bad, "robot/arm.urdf"),
    readFileSync(join(bad, "robot/arm.urdf"), "utf8").replaceAll(
      "meshes/base.stl",
      "meshes/base.3mf"
    )
  );
  const errors: WorldServerMessage[] = [];
  const attached = await withTimeout(
    attachWorld(bad, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "agent" },
      onEvent(event) {
        errors.push(event);
      },
    }),
    20000,
    "attach bad world"
  );
  expect(!("error" in attached), "bad world still attaches");
  const failure = errors.find((event) => event.type === "error");
  expect(failure?.type === "error", "bad world reports an error");
  if (failure?.type === "error") {
    expect(
      failure.errors.some((issue) => issue.code === "mesh-format"),
      `codes ${failure.errors.map((issue) => issue.code).join(",")}`
    );
  }
  expect(
    worldWorkerCount() === 0,
    `invalid world left a worker (${worldWorkerCount()})`
  );
  const again: WorldServerMessage[] = [];
  const reattached = await withTimeout(
    attachWorld(bad, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Retry" },
      onEvent(event) {
        again.push(event);
      },
    }),
    20000,
    "re-attach bad world"
  );
  expect(!("error" in reattached), "a failed world accepts another attach");
  const againFailure = again.find((event) => event.type === "error");
  expect(
    againFailure?.type === "error",
    "re-attach receives the validation error"
  );
  if (againFailure?.type === "error") {
    expect(
      againFailure.errors.some((issue) => issue.code === "mesh-format"),
      `re-attach codes ${againFailure.errors.map((issue) => issue.code).join(",")}`
    );
  }
  if (!("error" in attached)) attached.detach();
  if (!("error" in reattached)) reattached.detach();
  await stopWorld(bad, "parts/sfab/arm-bench@1.0.0.json");
  expect(worldWorkerCount() === 0, "stop leaves no worker");
} finally {
  rmSync(bad, { recursive: true, force: true });
}

const faultRoot = mkdtempSync(join(tmpdir(), "sfab-world-fault-"));
cpSync(armDir, faultRoot, { recursive: true });
const faultEvents: WorldServerMessage[] = [];
let faultHandle: WorldHandle | null = null;
try {
  const attached = await withTimeout(
    attachWorld(faultRoot, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        faultEvents.push(event);
      },
    }),
    20000,
    "attach fault world"
  );
  if ("error" in attached) throw new Error(String(attached.error));
  faultHandle = attached;
  expect(worldWorkerCount() === 1, "fault world has one worker");
  faultWorld(faultRoot, "parts/sfab/arm-bench@1.0.0.json");
  faultHandle.step(1);
  await waitUntil(
    () => faultEvents.some((event) => event.type === "error"),
    "step fault reaches the subscriber"
  );
  const fault = faultEvents.find((event) => event.type === "error");
  expect(fault?.type === "error", "subscriber got an error");
  if (fault?.type === "error") {
    expect(
      fault.message?.includes("injected step fault"),
      `fault message ${fault.message ?? ""}`
    );
  }
  expect(worldWorkerCount() === 1, "a caught step fault leaves the thread up");
  expect(process.exitCode == null, "the host process is still running");
  const lateFault: WorldServerMessage[] = [];
  const lateFaultAttach = await withTimeout(
    attachWorld(faultRoot, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Late" },
      onEvent(event) {
        lateFault.push(event);
      },
    }),
    20000,
    "attach after fault"
  );
  if ("error" in lateFaultAttach)
    throw new Error(String(lateFaultAttach.error));
  const lateFaultEvent = lateFault.find((event) => event.type === "error");
  expect(lateFaultEvent?.type === "error", "late joiner receives the fault");
  if (lateFaultEvent?.type === "error") {
    expect(
      lateFaultEvent.message?.includes("injected step fault"),
      `late fault message ${lateFaultEvent.message ?? ""}`
    );
  }
  console.log("late joiner after step fault: received injected step fault");
  lateFaultAttach.detach();
} finally {
  faultHandle?.detach();
  await stopWorld(faultRoot, "parts/sfab/arm-bench@1.0.0.json");
  rmSync(faultRoot, { recursive: true, force: true });
}
expect(worldWorkerCount() === 0, "fault world did not leak a worker");

const twoRoot = mkdtempSync(join(tmpdir(), "sfab-world-two-"));
cpSync(armDir, twoRoot, { recursive: true });
writeFileSync(
  join(twoRoot, "robot/crane.urdf"),
  `<?xml version="1.0"?>
<robot name="crane">
  <link name="stand">
    <inertial>
      <origin xyz="0 0 0.02" rpy="0 0 0"/>
      <mass value="0.05"/>
      <inertia ixx="0.00002" ixy="0" ixz="0" iyy="0.00002" iyz="0" izz="0.00002"/>
    </inertial>
    <visual>
      <geometry><box size="0.04 0.04 0.04"/></geometry>
    </visual>
  </link>
  <link name="box">
    <inertial>
      <origin xyz="0.05 0 0" rpy="0 0 0"/>
      <mass value="0.03"/>
      <inertia ixx="0.00001" ixy="0" ixz="0" iyy="0.00004" iyz="0" izz="0.00004"/>
    </inertial>
    <visual>
      <geometry>
        <mesh filename="meshes/base.stl" scale="0.001 0.001 0.001"/>
      </geometry>
    </visual>
  </link>
  <joint name="hinge" type="revolute">
    <parent link="stand"/>
    <child link="box"/>
    <origin xyz="0 0 0.04" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="0" upper="2.617993877991494" effort="0.18" velocity="10.472"/>
    <dynamics damping="0.001" friction="0"/>
  </joint>
</robot>
`
);
const twoWorld = readDraft(twoRoot, "parts/sfab/arm-bench@1.0.0.json");
twoWorld.robots.push({
  id: "crane",
  urdf: "robot/crane.urdf",
  pose: { position: [0.3, 0, 0], rotation: [1, 0, 0, 0] },
});
twoWorld.parts.push({
  id: "elbow",
  model: "sg90",
  drives: { robot: "crane", joint: "hinge" },
});
// No signal wire. V+ lets setTarget's motor-law command move the joint.
twoWorld.wires.push(["usb.5V", "elbow.V+"], ["usb.GND", "elbow.GND"]);
writeDraft(twoRoot, "arm.world.json", twoWorld);
const twoWorker = new Worker(worldWorkerEntry());
const twoMessages: FromWorker[] = [];
twoWorker.on("message", (message: FromWorker) => {
  twoMessages.push(message);
});
try {
  twoWorker.postMessage({
    type: "load",
    project: twoRoot,
    world: "arm.world.json",
    generation: 1,
  } satisfies ToWorker);
  await withTimeout(
    waitUntil(
      () => twoMessages.some((message) => message.type === "ready"),
      "two-robot ready",
      20000
    ),
    20000,
    "two-robot ready"
  );
  const twoReady = twoMessages.find((message) => message.type === "ready");
  if (!twoReady || twoReady.type !== "ready") {
    throw new Error("two-robot world did not become ready");
  }
  const bodies = twoReady.counts.bodyNames;
  for (const name of [
    "arm/base",
    "arm/upper_arm",
    "crane/stand",
    "crane/box",
  ]) {
    expect(bodies.includes(name), `${name} missing from ${bodies.join(",")}`);
  }
  expect(
    !bodies.some((name) => name.startsWith("arm/") && name.endsWith("box")),
    "arm did not take the crane link"
  );
  expect(
    !bodies.some((name) => name.startsWith("crane/") && name.endsWith("base")),
    "crane did not take the arm link"
  );
  expect(
    twoReady.counts.actuatorNames.includes("servo") &&
      twoReady.counts.actuatorNames.includes("elbow"),
    `actuators ${twoReady.counts.actuatorNames.join(",")}`
  );
  const latest = () => {
    const hit = [...twoMessages]
      .reverse()
      .find((message) => message.type === "state");
    return hit?.type === "state" ? hit.state : null;
  };
  const jointOf = (robot: string, joint: string) =>
    latest()?.joints[robot]?.[joint] ?? Number.NaN;
  twoWorker.postMessage({
    type: "setTarget",
    partId: "elbow",
    radians: Math.PI / 2,
    generation: 1,
  } satisfies ToWorker);
  twoWorker.postMessage({
    type: "step",
    n: 2000,
    generation: 1,
  } satisfies ToWorker);
  await withTimeout(
    waitUntil(
      () => {
        const hit = [...twoMessages]
          .reverse()
          .find((message) => message.type === "state");
        return hit?.type === "state" && hit.state.simTime > 1;
      },
      "crane stepped",
      20000
    ),
    20000,
    "crane stepped"
  );
  // The arm servo follows hold.hex. The elbow is unwired, so only
  // setTarget moves it. Each must stay on its own command.
  const hingeOnly = deg(jointOf("crane", "hinge"));
  const shoulderStill = deg(jointOf("arm", "shoulder"));
  const commandAt2 = latest()?.parts?.servo?.commandDeg;
  expect(
    Math.abs(hingeOnly - 90) < 2,
    `crane hinge ${hingeOnly.toFixed(3)}° after its own target`
  );
  expect(latest()?.parts?.elbow === undefined, "unwired elbow has no pulse");
  expect(
    commandAt2 !== undefined && commandAt2 !== null,
    "wired arm servo has a command"
  );
  expect(
    Math.abs(shoulderStill - (commandAt2 ?? Number.NaN)) < 2,
    `arm shoulder ${shoulderStill.toFixed(3)}° vs its command ${commandAt2}`
  );
  twoWorker.postMessage({
    type: "setTarget",
    partId: "servo",
    radians: Math.PI / 2,
    generation: 1,
  } satisfies ToWorker);
  twoWorker.postMessage({
    type: "step",
    n: 2000,
    generation: 1,
  } satisfies ToWorker);
  await withTimeout(
    waitUntil(
      () => {
        const hit = [...twoMessages]
          .reverse()
          .find((message) => message.type === "state");
        return (
          hit?.type === "state" && hit.state.simTime > 3 && !hit.state.playing
        );
      },
      "both robots stepped",
      20000
    ),
    20000,
    "both robots stepped"
  );
  const shoulderMoved = deg(jointOf("arm", "shoulder"));
  const hingeHeld = deg(jointOf("crane", "hinge"));
  const commandAt4 = latest()?.parts?.servo?.commandDeg;
  expect(
    Math.abs(hingeHeld - 90) < 2,
    `crane hinge ${hingeHeld.toFixed(3)}° moved with the arm`
  );
  expect(
    commandAt4 !== undefined && commandAt4 !== null,
    "arm servo still has a command"
  );
  expect(
    Math.abs(shoulderMoved - commandAt4) < 2,
    `arm shoulder ${shoulderMoved.toFixed(3)}° vs its command ${commandAt4}`
  );
  expect(
    Math.abs(commandAt4 - (commandAt2 ?? 0)) > 20,
    `arm command changed on its own (${commandAt2} → ${commandAt4})`
  );
  console.log(
    `two robots: hinge ${hingeOnly.toFixed(3)}° shoulder ${shoulderStill.toFixed(3)}° (command ${commandAt2}) then shoulder ${shoulderMoved.toFixed(3)}° (command ${commandAt4}) hinge ${hingeHeld.toFixed(3)}°`
  );
} finally {
  const twoExit = new Promise<number>((resolve) => {
    twoWorker.once("exit", (code) => resolve(code));
  });
  await twoWorker.terminate();
  await twoExit;
  rmSync(twoRoot, { recursive: true, force: true });
}

const catalog = listProjectFiles(armDir);
expect(
  catalog.some(
    (file) =>
      file.path === "parts/sfab/arm-bench@1.0.0.json" && file.kind === "world"
  ),
  "catalog lists the world"
);
expect(
  catalog.some(
    (file) =>
      file.path === "parts/sfab/arm-stall@1.0.0.json" && file.kind === "world"
  ),
  "catalog lists the stall world"
);
expect(
  !catalog.some((file) => file.path.endsWith(".stl")),
  "meshes are not documents"
);
expect(
  !catalog.some((file) => file.path.endsWith(".urdf")),
  "urdf is not a document"
);

const stl = await handleProjectFile(
  new Request("http://bench.local/api/files/robot/meshes/base.stl"),
  armDir
);
expect(stl.status === 200, `stl status ${stl.status}`);
expect(
  stl.headers.get("content-type") === "model/stl",
  `stl type ${stl.headers.get("content-type")}`
);
const worldFile = await handleProjectFile(
  new Request("http://bench.local/api/files/parts/sfab/arm-bench@1.0.0.json"),
  armDir
);
expect(worldFile.status === 200, "world json is served");
expect(
  worldFile.headers.get("content-type") === "application/json",
  "world json type"
);
const urdf = await handleProjectFile(
  new Request("http://bench.local/api/files/robot/arm.urdf"),
  armDir
);
expect(urdf.status === 200, "urdf is served");
expect(urdf.headers.get("content-type") === "application/xml", "urdf type");
const escaped = await handleProjectFile(
  new Request("http://bench.local/api/files/../package.json"),
  armDir
);
expect(escaped.status === 404, `escape status ${escaped.status}`);
const outside = await handleProjectFile(
  new Request("http://bench.local/api/files/firmware/hold/hold.hex"),
  armDir
);
expect(outside.status === 404, "hex is not a world asset");
const source = await handleProjectFile(
  new Request("http://bench.local/api/files/firmware/hold/hold.ino"),
  armDir
);
expect(source.status === 200, `ino status ${source.status}`);
expect(
  (source.headers.get("content-type") ?? "").startsWith("text/plain"),
  `ino type ${source.headers.get("content-type")}`
);
expect(
  (await source.text()).includes("Serial.println"),
  "ino source is served"
);

function inOrder(text: string, parts: readonly string[]): boolean {
  let at = 0;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const serialEvents: WorldServerMessage[] = [];
let serialHandle: WorldHandle | null = null;
try {
  const attached = await withTimeout(
    attachWorld(armDir, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        serialEvents.push(event);
      },
    }),
    20000,
    "attach hold world"
  );
  if ("error" in attached) throw new Error(attached.error);
  serialHandle = attached;
  const started = performance.now();
  serialHandle.step(3500);
  await withTimeout(
    waitUntil(() => {
      const page = readSerial(
        armDir,
        "parts/sfab/arm-bench@1.0.0.json",
        "uno",
        0
      );
      return !("error" in page) && page.text.includes("120\r\n");
    }, "hold printed 120"),
    30000,
    "hold printed 120"
  );
  const wallS = (performance.now() - started) / 1000;
  const page = readSerial(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno", 0);
  if ("error" in page) throw new Error(page.error);
  expect(
    inOrder(page.text, ["10\r\n", "90\r\n", "120\r\n"]),
    `serial order ${JSON.stringify(page.text)}`
  );
  console.log(
    `board lockstep rtf ${(3.5 / wallS).toFixed(3)} (3.500 sim s / ${wallS.toFixed(3)} wall s)`
  );
  const mid = page.text.indexOf("90\r\n");
  const newer = readSerial(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    "uno",
    mid
  );
  if ("error" in newer) throw new Error(newer.error);
  expect(newer.text === page.text.slice(mid), "from returns only newer text");
  expect(newer.next === page.next, "next is the ring end");
  const done = readSerial(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    "uno",
    page.next
  );
  if ("error" in done) throw new Error(done.error);
  expect(done.text === "", "from next is empty");
  expect(
    serialEvents.some(
      (event) =>
        event.type === "serial" &&
        event.board === "uno" &&
        event.text.includes("10\r\n")
    ),
    "subscriber receives serial"
  );

  serialHandle.pause();
  const frozen = readSerial(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    "uno",
    0
  );
  if ("error" in frozen) throw new Error(frozen.error);
  await sleep(300);
  const still = readSerial(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno", 0);
  if ("error" in still) throw new Error(still.error);
  expect(still.next === frozen.next, "pausing stops serial");

  serialHandle.play();
  await withTimeout(
    waitUntil(() => {
      const live = readSerial(
        armDir,
        "parts/sfab/arm-bench@1.0.0.json",
        "uno",
        0
      );
      return !("error" in live) && live.next > frozen.next;
    }, "serial while playing"),
    8000,
    "serial while playing"
  );
  serialHandle.pause();
  const paused = readSerial(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    "uno",
    0
  );
  if ("error" in paused) throw new Error(paused.error);
  await sleep(350);
  const held = readSerial(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno", 0);
  if ("error" in held) throw new Error(held.error);
  expect(held.next === paused.next, "pause after play stops serial");

  const late: WorldServerMessage[] = [];
  const lateAttached = await withTimeout(
    attachWorld(armDir, "parts/sfab/arm-bench@1.0.0.json", {
      sender: { kind: "paired", label: "Late" },
      onEvent(event) {
        late.push(event);
      },
    }),
    20000,
    "late serial joiner"
  );
  if ("error" in lateAttached) throw new Error(lateAttached.error);
  const tail = late.find((event) => event.type === "serial");
  expect(tail?.type === "serial", "late joiner gets a serial tail");
  if (tail?.type === "serial") {
    expect(
      inOrder(tail.text, ["10\r\n", "90\r\n", "120\r\n"]),
      `late tail ${JSON.stringify(tail.text)}`
    );
    expect(tail.board === "uno", "late tail names the board");
  }
  lateAttached.detach();

  const beforeSend = serialEvents.length;
  const sent = serialHandle.sendSerial("uno", "ping", "line-1");
  expect(!("error" in sent) && sent.ok === true, "serial-send accepted");
  await waitUntil(
    () =>
      serialEvents
        .slice(beforeSend)
        .some((event) => event.type === "serial-sent"),
    "serial-sent echo"
  );
  const echo = serialEvents
    .slice(beforeSend)
    .find((event) => event.type === "serial-sent");
  expect(echo?.type === "serial-sent", "echo event");
  if (echo?.type === "serial-sent") {
    expect(echo.board === "uno" && echo.text === "ping", "echo text");
    expect(
      echo.by.kind === "loopback" && echo.by.label === "Mac",
      "echo sender"
    );
    expect(echo.nonce === "line-1", "echo nonce");
  }
  await waitUntil(() => {
    const rx = boardRx(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno");
    return !("error" in rx) && rx.queued === 4 && rx.accepted === 0;
  }, "rx queued while paused");
  serialHandle.step(5);
  await waitUntil(() => {
    const rx = boardRx(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno");
    return !("error" in rx) && rx.accepted > 0;
  }, "rx reached the USART");
  const rx = boardRx(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno");
  if ("error" in rx) throw new Error(rx.error);
  console.log(
    `serial-send reached USART0 RX (hold.ino does not echo): accepted ${rx.accepted}, still queued ${rx.queued}`
  );
  const chunk = "x".repeat(1000);
  let fitted = 0;
  let full: { error: string } | { ok: true } | undefined;
  for (let i = 0; i < 8; i++) {
    const attempt = serialHandle.sendSerial("uno", chunk, `cap-${i}`);
    if ("error" in attempt) {
      full = attempt;
      break;
    }
    fitted += 1;
  }
  expect(full && "error" in full, "a send past the RX cap is rejected");
  if (full && "error" in full) {
    expect(full.error === "serial input is full", full.error);
  }
  expect(fitted * chunk.length <= RX_BACKLOG, "accepted sends fit in the cap");
  await waitUntil(() => {
    const queued = boardRx(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno");
    return (
      !("error" in queued) &&
      queued.queued === fitted * chunk.length &&
      queued.queued <= RX_BACKLOG
    );
  }, "rx backlog stayed within the cap");
  const backlog = boardRx(armDir, "parts/sfab/arm-bench@1.0.0.json", "uno");
  if ("error" in backlog) throw new Error(backlog.error);
  expect(backlog.queued <= RX_BACKLOG, `queued ${backlog.queued}`);
  console.log(
    `rx backlog capped at ${RX_BACKLOG}: queued ${backlog.queued} after ${fitted} sends`
  );
  const beforeReject = serialEvents.length;
  const playingAtReject = [...serialEvents]
    .reverse()
    .find((event) => event.type === "state");
  const unknown = serialHandle.sendSerial("missing", "x", "nope");
  expect("error" in unknown, "unknown board is rejected");
  const rejection = serialEvents
    .slice(beforeReject)
    .find((event) => event.type === "board-error");
  expect(rejection?.type === "board-error", "rejection is a board-error");
  if (rejection?.type === "board-error") {
    expect(rejection.board === "missing", "rejection names the board");
    expect(rejection.nonce === "nope", "rejection echoes the sender nonce");
    expect(rejection.message.includes("no board"), rejection.message);
  }
  expect(
    !serialEvents.slice(beforeReject).some((event) => event.type === "error"),
    "a rejected send is not a world error"
  );
  const playingAfter = [...serialEvents]
    .reverse()
    .find((event) => event.type === "state");
  expect(
    playingAtReject?.type === "state" &&
      playingAfter?.type === "state" &&
      playingAfter.state.playing === playingAtReject.state.playing,
    "a rejected send leaves play state alone"
  );
  const emptySend = serialHandle.sendSerial("uno", "", "empty");
  expect("error" in emptySend, "empty serial is rejected");
  expect(
    serialEvents.some(
      (event) =>
        event.type === "board-error" &&
        event.nonce === "empty" &&
        event.message.includes("empty")
    ),
    "empty text is a board-error"
  );
} finally {
  serialHandle?.detach();
  await stopWorld(armDir, "parts/sfab/arm-bench@1.0.0.json");
}

const pairRoot = mkdtempSync(join(tmpdir(), "sfab-world-boards-"));
cpSync(armDir, pairRoot, { recursive: true });
const pairDoc = readDraft(pairRoot, "parts/sfab/arm-bench@1.0.0.json");
const pairUno = pairDoc.boards[0];
if (!pairUno) throw new Error("fixture board");
pairDoc.boards.push({
  ...pairUno,
  id: "stall",
  firmware: "firmware/stall/stall.hex",
  source: "firmware/stall/stall.ino",
  pose: {
    position: [0.2, 0, 0.006],
    rotation: [1, 0, 0, 0],
  },
});
// An unwired board does not run. The stall CPU is here for its own
// serial ring, so it takes the same USB rail. Two boards plus the hold
// servo stay under 500 mA, and neither board browns out.
pairDoc.wires.push(["usb.5V", "stall.5V"], ["usb.GND", "stall.GND"]);
writeDraft(pairRoot, "two.world.json", pairDoc);
const holdHexPath = join(pairRoot, "firmware/hold/hold.hex");
const goodHex = readFileSync(holdHexPath);
const pairEvents: WorldServerMessage[] = [];
let pairHandle: WorldHandle | null = null;
try {
  const attached = await withTimeout(
    attachWorld(pairRoot, "two.world.json", {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        pairEvents.push(event);
      },
    }),
    20000,
    "attach two boards"
  );
  if ("error" in attached) throw new Error(attached.error);
  pairHandle = attached;
  pairHandle.step(3500);
  await withTimeout(
    waitUntil(() => {
      const holdPage = readSerial(pairRoot, "two.world.json", "uno", 0);
      const stallPage = readSerial(pairRoot, "two.world.json", "stall", 0);
      return (
        !("error" in holdPage) &&
        holdPage.text.includes("120\r\n") &&
        !("error" in stallPage) &&
        stallPage.text.includes("boot\r\n")
      );
    }, "both boards printed"),
    40000,
    "both boards printed"
  );
  const holdPage = readSerial(pairRoot, "two.world.json", "uno", 0);
  const stallPage = readSerial(pairRoot, "two.world.json", "stall", 0);
  if ("error" in holdPage) throw new Error(holdPage.error);
  if ("error" in stallPage) throw new Error(stallPage.error);
  expect(
    inOrder(holdPage.text, ["10\r\n", "90\r\n", "120\r\n"]),
    `hold ring ${JSON.stringify(holdPage.text)}`
  );
  expect(
    !holdPage.text.includes("boot\r\n"),
    "hold ring is not the stall firmware"
  );
  expect(
    stallPage.text.includes("boot\r\n"),
    "stall ring has its own firmware"
  );
  expect(
    !stallPage.text.includes("90\r\n"),
    "stall ring is not the hold firmware"
  );
  // Serial can land before the state tick that closes the step.
  const atSim = (at: string) => () => {
    const last = [...pairEvents]
      .reverse()
      .find((event) => event.type === "state");
    return last?.type === "state" && last.state.simTime.toFixed(3) === at;
  };
  await waitUntil(atSim("3.500"), "two-board state at 3.5 s");
  const simBefore =
    [...pairEvents].reverse().find((event) => event.type === "state") ?? null;
  expect(simBefore?.type === "state", "two-board state");
  const simAt = simBefore?.type === "state" ? simBefore.state.simTime : -1;
  expect(simAt.toFixed(3) === "3.500", `two-board simTime ${simAt}`);

  const stallNext = stallPage.next;
  writeFileSync(holdHexPath, ":0000000001\n");
  await withTimeout(
    waitUntil(() => {
      const state = [...pairEvents]
        .reverse()
        .find((event) => event.type === "state");
      return (
        state?.type === "state" &&
        state.state.boards.uno?.running === false &&
        (state.state.boards.uno?.fault ?? "").includes("checksum")
      );
    }, "bad hex faults uno"),
    10000,
    "bad hex faults uno"
  );
  const faultEvent = pairEvents.find(
    (event) => event.type === "board-error" && event.board === "uno"
  );
  expect(faultEvent?.type === "board-error", "a board fault is a board-error");
  if (faultEvent?.type === "board-error") {
    expect(faultEvent.message.includes("checksum"), faultEvent.message);
    expect(faultEvent.nonce === undefined, "a firmware fault has no nonce");
  }
  expect(
    !pairEvents.some((event) => event.type === "error"),
    "a board fault is not a world error"
  );
  const faulted = [...pairEvents]
    .reverse()
    .find((event) => event.type === "state");
  expect(faulted?.type === "state", "state after the fault");
  if (faulted?.type === "state") {
    expect(faulted.state.boards.uno?.running === false, "uno stopped");
    expect(
      (faulted.state.boards.uno?.fault ?? "").includes("checksum"),
      `uno fault ${faulted.state.boards.uno?.fault ?? ""}`
    );
    expect(faulted.state.boards.stall?.running === true, "stall keeps running");
    expect(
      faulted.state.simTime.toFixed(3) === "3.500",
      `fault did not reset simTime ${faulted.state.simTime}`
    );
  }
  const stallHeld = readSerial(pairRoot, "two.world.json", "stall", 0);
  if ("error" in stallHeld) throw new Error(stallHeld.error);
  expect(
    stallHeld.text === stallPage.text,
    "stall ring survived the other board's fault"
  );
  expect(stallHeld.next === stallNext, "stall offsets survived");

  const beforeGood = pairEvents.length;
  writeFileSync(holdHexPath, goodHex);
  await withTimeout(
    waitUntil(
      () =>
        pairEvents
          .slice(beforeGood)
          .some(
            (event) =>
              event.type === "serial" &&
              event.board === "uno" &&
              event.text.includes("firmware reloaded")
          ),
      "good hex reloads uno"
    ),
    10000,
    "good hex reloads uno"
  );
  // The reload marker can arrive before the state tick that shows it.
  await waitUntil(() => {
    const last = [...pairEvents]
      .reverse()
      .find((event) => event.type === "state");
    return last?.type === "state" && last.state.boards.uno?.running === true;
  }, "uno running after recovery");
  const recovered = [...pairEvents]
    .reverse()
    .find((event) => event.type === "state");
  expect(recovered?.type === "state", "state after recovery");
  if (recovered?.type === "state") {
    expect(
      recovered.state.boards.uno?.running === true,
      "uno is running again"
    );
    expect(
      recovered.state.boards.uno?.fault === undefined,
      "uno fault cleared"
    );
    expect(
      recovered.state.simTime.toFixed(3) === "3.500",
      `recovery kept simTime ${recovered.state.simTime}`
    );
  }
  pairHandle.step(1200);
  await waitUntil(() => {
    const again = readSerial(pairRoot, "two.world.json", "uno", 0);
    return (
      !("error" in again) &&
      again.text.includes("firmware reloaded") &&
      again.text.includes("10\r\n")
    );
  }, "reloaded uno prints");
  const again = readSerial(pairRoot, "two.world.json", "uno", 0);
  if ("error" in again) throw new Error(again.error);
  expect(again.text.includes("firmware reloaded"), "marker is in the new ring");
  const stallAfter = readSerial(pairRoot, "two.world.json", "stall", 0);
  if ("error" in stallAfter) throw new Error(stallAfter.error);
  expect(
    stallAfter.text === stallPage.text,
    "stall ring unchanged after uno reloaded"
  );
  expect(
    !stallAfter.text.includes("firmware reloaded"),
    "reload marker is only on the board whose hex changed"
  );
  await waitUntil(atSim("4.700"), "two-board state at 4.7 s");
  const moved = [...pairEvents]
    .reverse()
    .find((event) => event.type === "state");
  expect(moved?.type === "state", "state after the extra step");
  if (moved?.type === "state") {
    expect(
      moved.state.simTime.toFixed(3) === "4.700",
      `sim time continued ${moved.state.simTime}`
    );
  }
  console.log("two boards: separate rings, hex fault, and hex reload");
} finally {
  pairHandle?.detach();
  await stopWorld(pairRoot, "two.world.json");
  rmSync(pairRoot, { recursive: true, force: true });
}

closeRootWatches();
console.log("world-runtime.selfcheck ok");
