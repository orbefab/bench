/**
 * A root part replays the v2 world it was converted from.
 * Frames and serial stay byte-identical. The report names the document.
 * apps/server/fixtures/v2-worlds/ is git show b6fa416 of each example world.
 */
import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RunReport, WorldView, WorldViewNode } from "@sfab-bench/contract";
import { compileWorld } from "@sfab-bench/engine-body";
import { convertWorldFile, loadWorldV2, sha256Bytes } from "@sfab-bench/parts";
import type { SerialChunk } from "@sfab-bench/sim/sim";
import { Sim } from "@sfab-bench/sim/sim";
import { viewIdsAreNodes, viewOf } from "@sfab-bench/sim/view";
import { projectReal, readerFor, readInside } from "./world/files";
import { nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { catalogRoot, planWorld } from "./world/plan";
import { nodePlanEnv } from "./world/plan-host";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const SPAN_MS = 3000;

const examples: { dir: string; world: string; part: string }[] = [
  {
    dir: "examples/arm",
    world: "arm.world.json",
    part: "parts/sfab/arm-bench@1.0.0.json",
  },
  {
    dir: "examples/arm",
    world: "arm-stall.world.json",
    part: "parts/sfab/arm-stall@1.0.0.json",
  },
  {
    dir: "examples/gauge",
    world: "gauge-usb.world.json",
    part: "parts/sfab/gauge-usb@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-divider.world.json",
    part: "parts/sfab/nano-divider@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-led.world.json",
    part: "parts/sfab/nano-led@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-led-module.world.json",
    part: "parts/sfab/nano-led-module@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-servo-collapsed.world.json",
    part: "parts/sfab/nano-servo-collapsed@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-servo-usb.world.json",
    part: "parts/sfab/nano-servo-usb@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-vcc-class1.world.json",
    part: "parts/sfab/nano-vcc-class1@1.0.0.json",
  },
  {
    dir: "examples/nano",
    world: "nano-vcc-usb.world.json",
    part: "parts/sfab/nano-vcc-usb@1.0.0.json",
  },
];

function worldFixture(name: string): Buffer {
  return readFileSync(join(repo, "apps/server/fixtures/v2-worlds", name));
}

function takeLines(chunks: SerialChunk[]): string[] {
  const pending = new Map<string, string>();
  const lines: string[] = [];
  for (const chunk of chunks) {
    const buf = (pending.get(chunk.board) ?? "") + chunk.text;
    const parts = buf.split("\n");
    pending.set(chunk.board, parts.pop() ?? "");
    for (const part of parts) {
      const line = part.replace(/\r$/, "").trim();
      if (line.length > 0) lines.push(`${chunk.board}: ${line}`);
    }
  }
  for (const [board, rest] of pending) {
    const line = rest.replace(/\r$/, "").trim();
    if (line.length > 0) lines.push(`${board}: ${line}`);
  }
  return lines;
}

async function recorded(
  project: string,
  world: string
): Promise<{
  frames: string;
  serial: string[];
  count: number;
}> {
  const sim = new Sim({
    post() {
      /* serial is drained after the step */
    },
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    clear(handle) {
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
    keepSerial: true,
  });
  try {
    const loaded = await sim.load({ project, world, generation: 1 });
    if (!loaded.ok) {
      const text = loaded.errors.map((error) => error.message).join("; ");
      throw new Error(text || loaded.message || `${world} did not load`);
    }
    await sim.step(SPAN_MS);
    const settled = sim.state();
    if (!settled) throw new Error(`${world} produced no state`);
    const body = sim.record({ op: "read", from: 0, to: settled.simTime });
    if (body.op !== "read") throw new Error(`${world} produced no recording`);
    return {
      frames: JSON.stringify(body.read.frames),
      serial: takeLines(sim.drainSerial()),
      count: body.read.frames.length,
    };
  } finally {
    sim.dispose();
  }
}

function reportOf(project: string, world: string): RunReport {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  if (!planned.plan.report) throw new Error(`${world} has no report`);
  return planned.plan.report;
}

function differing(left: RunReport, right: RunReport): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<
    keyof RunReport
  >;
  const fields: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      fields.push(key);
    }
  }
  return fields.sort();
}

function libraryOpts(project: string) {
  return {
    store: nodeStore,
    catalogDir: catalogRoot(),
    assetRoot: project,
  };
}

for (const example of examples) {
  const stem = example.world.replace(/\.world\.json$/, "");
  const dir = mkdtempSync(join(tmpdir(), "sfab-part-doc-"));
  try {
    cpSync(join(repo, example.dir), dir, { recursive: true });
    const worldFile = join(dir, example.world);
    writeFileSync(worldFile, worldFixture(example.world));
    rmSync(join(dir, example.part), { force: true });
    rmSync(join(dir, example.part.replace(/\.json$/, ".lock.json")), {
      force: true,
    });
    const wrote = convertWorldFile(worldFile, libraryOpts(dir));
    expect(
      wrote.partFile === join(dir, example.part),
      `${stem} converted to ${wrote.partFile}`
    );
    const fromWorld = reportOf(dir, example.world);
    const fromPart = reportOf(dir, example.part);
    expect(
      JSON.stringify(fromWorld.levels) === JSON.stringify(fromPart.levels),
      `${stem} levels diverged`
    );
    console.log(`round trip ${stem}: levels equal`);
    const fields = differing(fromWorld, fromPart);
    expect(
      fields.length === 2 && fields[0] === "lock" && fields[1] === "world",
      `${stem} report fields ${fields.join(", ")}`
    );
    const legacy = await recorded(dir, example.world);
    const part = await recorded(dir, example.part);
    expect(legacy.frames === part.frames, `${stem} frames differ`);
    expect(
      legacy.serial.join("\n") === part.serial.join("\n"),
      `${stem} serial differs`
    );
    console.log(
      `converted ${stem}: ${SPAN_MS} ms, ${part.count} frames byte-identical, serial ${part.serial.length} lines identical, report differs only in world, lock`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-nested-play-"));
  try {
    writeJson(join(dir, "types/played-scene.json"), {
      format: "sfab.part-type@1",
      id: "played-scene",
      ports: {},
    });
    writeJson(join(dir, "parts/sfab/played-scene@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/played-scene@1.0.0",
      type: "played-scene",
      foreign: false,
      play: {
        gravity: [0, 0, -1],
        seed: 9,
        timestep: 0.004,
        levels: { default: 1 },
      },
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["nested play is not the run"],
                netlist: { instances: {}, wires: [], expose: {} },
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["no body"] } },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["no visual"] } },
          },
        },
      },
    });
    writeJson(join(dir, "parts/sfab/played-root@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/played-root@1.0.0",
      type: "assembly",
      foreign: false,
      play: {
        gravity: [0, 0, -9.81],
        seed: 1,
        timestep: 0.001,
        levels: { default: 1 },
      },
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["play settings are not a behaviour"],
                netlist: {
                  instances: {
                    scene: { part: "sfab/played-scene@1.0.0" },
                  },
                  wires: [],
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
    });
    const loaded = loadWorldV2(
      join(dir, "parts/sfab/played-root@1.0.0.json"),
      libraryOpts(dir)
    );
    expect(loaded.run, loaded.diagnostics.map((d) => d.message).join("; "));
    expect(
      JSON.stringify(loaded.run?.play.gravity) ===
        JSON.stringify([0, 0, -9.81]),
      `nested gravity ${JSON.stringify(loaded.run?.play.gravity)}`
    );
    expect(loaded.run?.play.seed === 1, `nested seed ${loaded.run?.play.seed}`);
    expect(
      loaded.run?.play.timestep === 0.001,
      `nested timestep ${loaded.run?.play.timestep}`
    );
    const planned = planWorld(dir, "parts/sfab/played-root@1.0.0.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((error) => error.message).join("; "));
    }
    expect(
      planned.plan.timestep === 0.001 && planned.plan.report?.seed === 1,
      "the run did not take the root play block"
    );
    console.log(
      "nested play ignored: gravity [0, 0, -9.81], seed 1, timestep 0.001"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-timestep-"));
  try {
    writeJson(join(dir, "types/step-scene.json"), {
      format: "sfab.part-type@1",
      id: "step-scene",
      ports: {},
    });
    writeJson(join(dir, "parts/sfab/step-root@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/step-root@1.0.0",
      type: "step-scene",
      foreign: false,
      play: {
        gravity: [0, 0, -9.81],
        seed: 1,
        timestep: 0.002,
        levels: { default: 1 },
      },
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["play timestep is not a behaviour"],
                netlist: { instances: {}, wires: [], expose: {} },
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["no body"] } },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["no visual"] } },
          },
        },
      },
    });
    const planned = planWorld(dir, "parts/sfab/step-root@1.0.0.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((error) => error.message).join("; "));
    }
    const warning = planned.plan.report?.warnings.find(
      (row) => row.code === "timestep-unsupported"
    );
    expect(
      warning?.path === "$root" &&
        warning.message ===
          "play.timestep 0.002 s is not supported yet; the run steps 1 ms",
      `timestep warning ${JSON.stringify(warning)}`
    );
    if (!warning) throw new Error("timestep warning missing");
    expect(
      planned.plan.timestep === undefined,
      `plan timestep ${planned.plan.timestep}`
    );
    const compiled = await compileWorld(
      planned.plan,
      readerFor(dir, "parts/sfab/step-root@1.0.0.json")
    );
    if (!compiled.ok) {
      throw new Error(compiled.errors.map((error) => error.message).join("; "));
    }
    expect(
      compiled.model.opt.timestep === 0.001,
      `body timestep ${compiled.model.opt.timestep}`
    );
    console.log(
      `${warning.message}; body steps ${compiled.model.opt.timestep}`
    );
    compiled.model.delete();
    compiled.vfs.delete();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-no-ground-"));
  try {
    writeFileSync(
      join(dir, "drop.urdf"),
      `<?xml version="1.0"?>
<robot name="drop">
  <link name="base"/>
  <link name="ball">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <mass value="0.1"/>
      <inertia ixx="0.0001" ixy="0" ixz="0" iyy="0.0001" iyz="0" izz="0.0001"/>
    </inertial>
    <collision>
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><box size="0.02 0.02 0.02"/></geometry>
    </collision>
  </link>
  <joint name="fall" type="prismatic">
    <origin xyz="0 0 0.2" rpy="0 0 0"/>
    <parent link="base"/>
    <child link="ball"/>
    <axis xyz="0 0 1"/>
    <limit lower="-2" upper="1" effort="0" velocity="100"/>
  </joint>
</robot>
`
    );
    writeJson(join(dir, "types/drop-robot.json"), {
      format: "sfab.part-type@1",
      id: "drop-robot",
      ports: {},
    });
    writeJson(join(dir, "parts/sfab/drop@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/drop@1.0.0",
      type: "drop-robot",
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
                file: "drop.urdf",
                omits: ["link flex"],
              },
            },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["link meshes"] } },
          },
        },
      },
    });
    writeJson(join(dir, "parts/sfab/drop-bench@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/drop-bench@1.0.0",
      type: "assembly",
      foreign: false,
      play: {
        gravity: [0, 0, -9.81],
        seed: 1,
        timestep: 0.001,
        levels: { default: 1 },
      },
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["play settings are not a behaviour"],
                netlist: {
                  instances: {
                    scene: { part: "sfab/drop-scene@1.0.0" },
                  },
                  wires: [],
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
    });
    writeJson(join(dir, "parts/sfab/drop-scene@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/drop-scene@1.0.0",
      type: "assembly",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["the scene is the robot"],
                netlist: {
                  instances: { mass: { part: "sfab/drop@1.0.0" } },
                  wires: [],
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
    });
    const loaded = loadWorldV2(
      join(dir, "parts/sfab/drop-bench@1.0.0.json"),
      libraryOpts(dir)
    );
    expect(
      loaded.run?.ground === false,
      "a root with no ground part still has a ground"
    );
    const run = await recorded(dir, "parts/sfab/drop-bench@1.0.0.json");
    const frames = JSON.parse(run.frames) as {
      poses: Record<string, Record<string, { p: number[] }>>;
      joints: Record<string, Record<string, number>>;
    }[];
    const last = frames.at(-1);
    const z = last?.poses.mass?.ball?.p[2];
    const q = last?.joints.mass?.fall;
    const height =
      typeof z === "number" ? z : typeof q === "number" ? 0.2 + q : null;
    expect(
      height !== null && height < 0,
      `body did not fall past z = 0 (${JSON.stringify(last?.poses)} ${JSON.stringify(last?.joints)})`
    );
    console.log("no ground: body falls past z = 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ROLE_ORDER = [
  "robot",
  "board",
  "supply",
  "part",
  "leaf",
  "ground",
  "target",
  "assembly",
] as const;

function findNode(
  nodes: readonly WorldViewNode[],
  id: string
): WorldViewNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
}

function nodeIds(nodes: readonly WorldViewNode[], into = new Set<string>()) {
  for (const node of nodes) {
    into.add(node.id);
    nodeIds(node.children, into);
  }
  return into;
}

function fileSummary(view: WorldView): string {
  const project: string[] = [];
  let library = 0;
  let catalog = 0;
  let bare = 0;
  const walk = (nodes: readonly WorldViewNode[]) => {
    for (const node of nodes) {
      if (node.source === "project") {
        project.push(`${node.name}=${node.file ?? ""}`);
      } else if (node.source === "library") library += 1;
      else if (node.source === "catalog") catalog += 1;
      else bare += 1;
      walk(node.children);
    }
  };
  walk(view.tree.nodes);
  const tail = bare > 0 ? `; bare ${bare}` : "";
  return (
    `project ${project.join(" ")}; library ${library}; catalog ${catalog}` +
    tail
  );
}

function editorSummary(view: WorldView): string {
  let wires = 0;
  let options = 0;
  const walk = (nodes: readonly WorldViewNode[]) => {
    for (const node of nodes) {
      wires += node.wires?.length ?? 0;
      for (const axis of node.levels) options += axis.options.length;
      walk(node.children);
    }
  };
  walk(view.tree.nodes);
  return `wires ${wires}, level options ${options}`;
}

function treeSummary(view: WorldView): string {
  const counts = new Map<string, number>();
  let total = 0;
  let depth = 0;
  const walk = (nodes: readonly WorldViewNode[], level: number) => {
    for (const node of nodes) {
      total += 1;
      depth = Math.max(depth, level);
      counts.set(node.role, (counts.get(node.role) ?? 0) + 1);
      walk(node.children, level + 1);
    }
  };
  walk(view.tree.nodes, 1);
  const roles = ROLE_ORDER.filter((role) => counts.has(role))
    .map((role) => `${role} ${counts.get(role)}`)
    .join(" ");
  return `${total} nodes, depth ${depth}, roles ${roles}`;
}

function openPart(dir: string, part: string) {
  const planned = planWorld(join(repo, dir), part);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  return planned.plan;
}

for (const example of examples) {
  const stem = (example.part.split("/").pop() ?? example.part).replace(
    /@[^@]+\.json$/,
    ""
  );
  const plan = openPart(example.dir, example.part);
  const view = viewOf(plan);
  const again = viewOf(openPart(example.dir, example.part));
  expect(viewIdsAreNodes(view), `${stem} view id is not a node`);
  expect(
    JSON.stringify(view.tree) === JSON.stringify(again.tree),
    `${stem} tree is not stable`
  );
  const ids = nodeIds(view.tree.nodes);
  for (const row of plan.report?.levels ?? []) {
    expect(ids.has(row.path), `${stem} report path ${row.path} is not a node`);
  }
  if (stem === "nano-servo-usb") {
    const board = view.boards.find((row) => row.id === "nano");
    const node = findNode(view.tree.nodes, "nano");
    expect(
      board && node && JSON.stringify(board.pose) === JSON.stringify(node.pose),
      "nano pose is not the flat instance pose"
    );
  }
  console.log(`tree ${stem}: ${treeSummary(view)}, every view id is a node`);
  console.log(`tree ${stem} editor: ${editorSummary(view)}`);
  console.log(`tree ${stem} files: ${fileSummary(view)}`);
}

{
  const plan = openPart(".", "apps/server/fixtures/layered/fleet/world.json");
  const view = viewOf(plan);
  const rig = findNode(view.tree.nodes, "fleet.rig2");
  const servo = rig?.children.find((node) => node.id === "fleet.rig2.servo");
  expect(servo, "fleet.rig2.servo is not nested under fleet.rig2");
  const ids = nodeIds(view.tree.nodes);
  const paths = new Set((plan.report?.levels ?? []).map((row) => row.path));
  for (const path of paths) {
    expect(ids.has(path), `fleet report path ${path} is not a node`);
  }
  expect(servo?.id === "fleet.rig2.servo", "fleet servo id moved");
  console.log(
    `tree fleet: fleet.rig2.servo nested, ${paths.size} report paths are nodes`
  );
  console.log(`tree fleet editor: ${editorSummary(view)}`);
  console.log(`tree fleet files: ${fileSummary(view)}`);
}

{
  const roots = ["packages/parts/src", "packages/sim/src", "apps/server/src"];
  const allow = new Set([
    "packages/parts/src/document.ts",
    "packages/parts/src/convert.ts",
    "packages/parts/src/level-edit.ts",
    "packages/sim/src/capture.ts",
  ]);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(join(repo, dir))) {
      if (name === "node_modules" || name === "dist") continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(repo, rel)).isDirectory()) visit(rel);
      else if (name.endsWith(".ts")) files.push(rel);
    }
  };
  for (const root of roots) visit(root);
  const runtime = files.filter(
    (rel) => !allow.has(rel) && !rel.includes("selfcheck")
  );
  const hits = runtime.filter((rel) => {
    const text = readFileSync(join(repo, rel), "utf8");
    return (
      text.includes("WorldFileV2") ||
      /version:\s*2\b/.test(text) ||
      text.includes('"version": 2') ||
      text.includes('"version":2')
    );
  });
  expect(hits.length === 0, `WorldFileV2 at runtime: ${hits.join(", ")}`);
  console.log(
    `runtime WorldFileV2: ${hits.length} files, scanned ${runtime.length}`
  );
}
