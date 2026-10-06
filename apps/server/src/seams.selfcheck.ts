/**
 * Energy residual at the motor seam (G2).
 * The arm's SG90 is the healthy run. A servo held on its joint stop is
 * the closed form (ω ≈ 0). A light joint, commanded after a quiet
 * window, grows the coupling lag until the seam is flagged. An open
 * bridge sends nothing while the joint swings, so its seam is priced at
 * rest, as a limp lumped servo is.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RunReport, SeamEnergy } from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { SEAM_WARNING_CODE, seamLine } from "@sfab-bench/sim/seams";
import { Sim } from "@sfab-bench/sim/sim";
import { runHeadless } from "./run";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const ledDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function simHost(onReport: (report: RunReport) => void) {
  return {
    post(message: { type: string; report?: RunReport }) {
      if (message.type === "state" && message.report) onReport(message.report);
    },
    now: () => performance.now(),
    schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    sha256: sha256Bytes,
    versions: {
      mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
      avr8js: packageVersion("avr8js", import.meta.url),
    },
    projectReal,
    readInside,
    readerFor,
    plan: nodePlanEnv,
    keepSerial: false,
  };
}

async function runWorld(
  project: string,
  world: string,
  ms: number,
  before?: (sim: Sim) => void
): Promise<RunReport> {
  const box: { report: RunReport | null } = { report: null };
  const sim = new Sim(
    simHost((next) => {
      box.report = next;
    })
  );
  try {
    const loaded = await sim.load({ project, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((item) => item.message).join("; "));
    }
    before?.(sim);
    await sim.step(ms);
    const report = box.report;
    if (!report) throw new Error(`${world} published no report`);
    return report;
  } finally {
    sim.dispose();
  }
}

function motorOf(report: RunReport, path: string): SeamEnergy {
  const row = report.seams?.find((item) => item.path === path);
  expect(row, `${path} has no motor seam`);
  if (!row) throw new Error("unreachable");
  return row;
}

function ratioOf(row: SeamEnergy): number {
  const sent = Math.abs(row.sent);
  if (!(sent > 0)) return 0;
  return Math.abs(row.residual) / sent;
}

{
  const report = await runWorld(ledDir, "parts/sfab/nano-led@1.0.0.json", 300);
  expect(report.seams === undefined, "a world with no motor gained a seam");
  expect(
    !report.warnings.some((item) => item.code === SEAM_WARNING_CODE),
    "a world with no motor flagged a seam"
  );
  console.log("nano-led: no motor seam");
}

{
  const report = await runWorld(
    armDir,
    "parts/sfab/arm-bench@1.0.0.json",
    2000
  );
  const row = motorOf(report, "servo");
  const ratio = ratioOf(row);
  expect(!row.flagged, `healthy servo flagged\n${seamLine(row)}`);
  expect(Math.abs(row.sent) > 1e-4, `healthy servo sent ${row.sent} J`);
  expect(
    ratio < 0.02,
    `healthy |residual| / |sent| ${(ratio * 100).toFixed(2)} %`
  );
  console.log(`healthy arm: ${seamLine(row)}`);
  console.log(
    `servo motor coupling lag: |residual| / |sent| = ${(ratio * 100).toFixed(2)} % ` +
      `over 2000 ms (the rail prices ω from 1 ms earlier; not flagged)`
  );
}

{
  const posted: { sent: number | null } = { sent: null };
  const sim = new Sim(
    simHost((next) => {
      const row = next.seams?.find((item) => item.path === "servo");
      if (row) posted.sent = row.sent;
    })
  );
  let ledgerSent = 0;
  try {
    const loaded = await sim.load({
      project: armDir,
      world: "parts/sfab/arm-bench@1.0.0.json",
      generation: 1,
    });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((item) => item.message).join("; "));
    }
    await sim.step(1100);
    const ledger = sim.seams().find((item) => item.path === "servo");
    expect(ledger, "1100 ms arm has no motor seam");
    if (!ledger) throw new Error("unreachable");
    ledgerSent = ledger.sent;
  } finally {
    sim.dispose();
  }
  const cli = await runHeadless({
    project: armDir,
    world: "parts/sfab/arm-bench@1.0.0.json",
    ms: 1100,
  });
  const printed = cli.seams.find((item) => item.path === "servo");
  expect(printed, "bench run 1100 ms printed no motor seam");
  if (!printed) throw new Error("unreachable");
  expect(
    printed.sent === ledgerSent,
    `bench run sent ${printed.sent} J, ledger ${ledgerSent} J`
  );
  expect(
    posted.sent !== null && printed.sent !== posted.sent,
    "1100 ms total collapsed to the last closed window"
  );
  console.log(
    `bench run 1100 ms: sent ${printed.sent.toFixed(6)} J equals the ledger`
  );
}

{
  // The servo group (behaviour 2) with no pulse wire: the bridge stays
  // open, and sideways gravity swings the arm through it.
  const dir = mkdtempSync(join(tmpdir(), "sfab-seam-open-"));
  try {
    cpSync(armDir, dir, { recursive: true });
    const parts = join(dir, "parts", "sfab");
    const sceneFile = join(parts, "arm-scene@1.0.0.json");
    const scene = JSON.parse(readFileSync(sceneFile, "utf8"));
    const netlist = scene.axes.behaviour["2"].variants.netlist.netlist;
    netlist.wires = netlist.wires.filter(
      (wire: string[]) => wire[1] !== "servo.signal"
    );
    writeFileSync(sceneFile, JSON.stringify(scene));
    const benchFile = join(parts, "arm-open@1.0.0.json");
    const bench = JSON.parse(
      readFileSync(join(parts, "arm-bench@1.0.0.json"), "utf8")
    );
    bench.id = "sfab/arm-open@1.0.0";
    bench.play.gravity = [0, -9.81, 0];
    bench.play.levels = { default: 1, paths: { servo: { behaviour: 2 } } };
    writeFileSync(benchFile, JSON.stringify(bench));
    const report = await runWorld(dir, "parts/sfab/arm-open@1.0.0.json", 2000);
    const row = report.seams?.find((item) => item.path === "servo");
    expect(row, "the open bridge has no motor seam");
    if (!row) throw new Error("unreachable");
    expect(
      row.received !== 0 && row.sent === 0 && row.declared === 0,
      `an open bridge sent energy: ${seamLine(row)}`
    );
    console.log(`open bridge, arm swinging: ${seamLine(row)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const root = mkdtempSync(join(tmpdir(), "sfab-seam-"));
try {
  mkdirSync(join(root, "parts", "sfab"), { recursive: true });
  mkdirSync(join(root, "robot"), { recursive: true });
  writeFileSync(
    join(root, "robot", "stop.urdf"),
    `<?xml version="1.0"?>
<robot name="stop">
  <link name="base">
    <inertial>
      <mass value="0.05"/>
      <inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5"/>
    </inertial>
  </link>
  <link name="upper_arm">
    <inertial>
      <origin xyz="0.02 0 0" rpy="0 0 0"/>
      <mass value="0.01"/>
      <inertia ixx="1e-6" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5"/>
    </inertial>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base"/>
    <child link="upper_arm"/>
    <origin xyz="0 0 0.02" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="0" upper="1" effort="2" velocity="20"/>
  </joint>
</robot>
`
  );
  writeFileSync(
    join(root, "parts", "sfab", "stop-arm@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/stop-arm@1.0.0",
      type: "robot-arm",
      foreign: false,
      axes: {
        behaviour: {
          "1": {
            default: "rigid",
            variants: {
              rigid: {
                kind: "form",
                form: "multibody@1",
                params: {},
                omits: ["joint flexibility"],
              },
            },
          },
        },
        body: {
          "1": {
            default: "urdf",
            variants: {
              urdf: {
                kind: "urdf",
                file: "robot/stop.urdf",
                omits: ["link flex"],
              },
            },
          },
        },
        visual: {
          "0": {
            default: "box",
            variants: {
              box: {
                kind: "box",
                size: [0.04, 0.02, 0.02],
                omits: ["meshes"],
              },
            },
          },
        },
      },
    })
  );
  writeFileSync(
    join(root, "parts", "sfab", "stop-scene@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/stop-scene@1.0.0",
      type: "assembly",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["stall scene"],
                netlist: {
                  instances: {
                    arm: { part: "sfab/stop-arm@1.0.0" },
                    bench: {
                      part: "sfab/bench-supply@1.0.0",
                      params: { V: 5, Ilimit: 2 },
                    },
                    servo: { part: "sfab/sg90@1.0.0" },
                  },
                  wires: [
                    ["bench.5V", "servo.V+"],
                    ["bench.GND", "servo.GND"],
                    ["servo.shaft", "arm.shoulder"],
                    ["servo.mount", "arm.base"],
                  ],
                  expose: {},
                },
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: {
              none: { kind: "none", omits: ["assembly adds no body"] },
            },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: {
              none: { kind: "none", omits: ["assembly adds no visual"] },
            },
          },
        },
      },
    })
  );
  writeFileSync(
    join(root, "stop.world.json"),
    JSON.stringify({
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 1 } },
      root: { id: "scene", part: "sfab/stop-scene@1.0.0" },
    })
  );

  const hold = (sim: Sim) => {
    sim.setTarget("servo", -0.4);
  };
  const brief = await runWorld(root, "stop.world.json", 250, hold);
  const stalled = await runWorld(root, "stop.world.json", 500, hold);
  const engage = motorOf(brief, "servo");
  const stall = motorOf(stalled, "servo");
  const settledSent = stall.sent - engage.sent;
  const settledReceived = stall.received - engage.received;
  const settledResidual = stall.residual - engage.residual;
  const settledTol = 1e-9;
  expect(!stall.flagged, `stall flagged\n${seamLine(stall)}`);
  expect(
    Math.abs(settledSent) < settledTol &&
      Math.abs(settledReceived) < settledTol &&
      Math.abs(settledResidual) < settledTol,
    `stall window not closed form sent ${settledSent} received ${settledReceived} residual ${settledResidual}`
  );
  console.log(`stall stop: ${seamLine(stall)}`);
  console.log(
    `stall settled 250 ms: sent ${settledSent.toExponential(1)} J, ` +
      `received ${settledReceived.toExponential(1)} J, ` +
      `residual ${settledResidual.toExponential(1)} J ` +
      `(ω ≈ 0 on the stop, within ${settledTol.toExponential(0)} J)`
  );

  writeFileSync(
    join(root, "robot", "vane.urdf"),
    `<?xml version="1.0"?>
<robot name="vane">
  <link name="base">
    <inertial>
      <mass value="0.01"/>
      <inertia ixx="1e-6" ixy="0" ixz="0" iyy="1e-6" iyz="0" izz="1e-6"/>
    </inertial>
  </link>
  <link name="upper_arm">
    <inertial>
      <origin xyz="0.005 0 0" rpy="0 0 0"/>
      <mass value="0.0001"/>
      <inertia ixx="1e-9" ixy="0" ixz="0" iyy="1e-9" iyz="0" izz="1e-9"/>
    </inertial>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base"/>
    <child link="upper_arm"/>
    <origin xyz="0 0 0.01" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="-3" upper="3" effort="2" velocity="100"/>
    <dynamics damping="0" friction="0"/>
  </joint>
</robot>
`
  );
  // Armature sits just under the explicit-damping limit dt·K²/(R·J) = 2,
  // so the 1 ms lag reverses the joint each step and the residual grows.
  writeFileSync(
    join(root, "parts", "sfab", "lag-servo@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/lag-servo@1.0.0",
      type: "hobby-servo-3wire",
      foreign: false,
      ratings: {
        "V+": { voltage: [4, 6] },
        shaft: { torque: [-2, 2] },
      },
      axes: {
        behaviour: {
          "1": {
            default: "lag",
            variants: {
              lag: {
                kind: "form",
                form: "position-servo@1",
                params: {
                  K: 1,
                  R: 3,
                  efficiency: 1,
                  eSat: 1,
                  quiescent: 0,
                },
                omits: ["winding heat"],
              },
            },
          },
        },
        body: {
          "1": {
            default: "lumped",
            variants: {
              lumped: {
                kind: "lumped",
                mass: 0.009,
                com: [0, 0, 0],
                inertia: [1e-6, 1e-6, 1e-6, 0, 0, 0],
                joint: {
                  armature: 1.64e-4,
                  frictionloss: 0,
                  damping: 0,
                },
                omits: ["gear stages"],
              },
            },
          },
        },
        visual: {
          "0": {
            default: "box",
            variants: {
              box: {
                kind: "box",
                size: [0.02, 0.01, 0.02],
                omits: ["case mesh"],
              },
            },
          },
        },
      },
    })
  );
  writeFileSync(
    join(root, "parts", "sfab", "vane-arm@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/vane-arm@1.0.0",
      type: "robot-arm",
      foreign: false,
      axes: {
        behaviour: {
          "1": {
            default: "rigid",
            variants: {
              rigid: {
                kind: "form",
                form: "multibody@1",
                params: {},
                omits: ["joint flexibility"],
              },
            },
          },
        },
        body: {
          "1": {
            default: "urdf",
            variants: {
              urdf: {
                kind: "urdf",
                file: "robot/vane.urdf",
                omits: ["link flex"],
              },
            },
          },
        },
        visual: {
          "0": {
            default: "box",
            variants: {
              box: {
                kind: "box",
                size: [0.02, 0.01, 0.01],
                omits: ["meshes"],
              },
            },
          },
        },
      },
    })
  );
  writeFileSync(
    join(root, "parts", "sfab", "lag-scene@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/lag-scene@1.0.0",
      type: "assembly",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["lag scene"],
                netlist: {
                  instances: {
                    arm: { part: "sfab/vane-arm@1.0.0" },
                    bench: {
                      part: "sfab/bench-supply@1.0.0",
                      params: { V: 5, Rs: 0.01, Ilimit: 5 },
                    },
                    servo: { part: "sfab/lag-servo@1.0.0" },
                  },
                  wires: [
                    ["bench.5V", "servo.V+"],
                    ["bench.GND", "servo.GND"],
                    ["servo.shaft", "arm.shoulder"],
                    ["servo.mount", "arm.base"],
                  ],
                  expose: {},
                },
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: {
              none: { kind: "none", omits: ["assembly adds no body"] },
            },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: {
              none: { kind: "none", omits: ["assembly adds no visual"] },
            },
          },
        },
      },
    })
  );
  writeFileSync(
    join(root, "lag.world.json"),
    JSON.stringify({
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, 0] },
      run: { seed: 1, levels: { default: 1 } },
      root: { id: "scene", part: "sfab/lag-scene@1.0.0" },
    })
  );

  const box: { report: RunReport | null } = { report: null };
  const sim = new Sim(
    simHost((next) => {
      box.report = next;
    })
  );
  try {
    const loaded = await sim.load({
      project: root,
      world: "lag.world.json",
      generation: 1,
    });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((item) => item.message).join("; "));
    }
    await sim.step(250);
    sim.setTarget("servo", 0.5);
    await sim.step(1000);
    const report = box.report;
    if (!report) throw new Error("lag world published no report");
    const row = motorOf(report, "servo");
    const warning = report.warnings.find(
      (item) => item.code === SEAM_WARNING_CODE
    );
    expect(row.flagged && warning, `lag did not flag\n${seamLine(row)}`);
    if (!warning) throw new Error("unreachable");
    expect(
      warning.severity === "warning",
      `lag flag severity ${warning.severity}`
    );
    console.log(`growing lag: ${seamLine(row)}`);
    console.log(warning.message);
  } finally {
    sim.dispose();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("seams.selfcheck ok");
