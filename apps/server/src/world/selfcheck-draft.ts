/**
 * Test-only helper. Self-checks use it to edit a scene as flat lists.
 * Not a runtime module and not a file format. No runtime module may
 * import it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Pose } from "@sfab-bench/contract";
import { lockPathFor } from "@sfab-bench/parts";
import { planWorld } from "./plan";

export type DraftPose = {
  position: [number, number, number];
  rotation: [number, number, number, number];
};

export type WorldDraft = {
  environment: {
    ground: { plane: boolean };
    /** Metres per second squared. Omitted drafts keep the arm's −9.81. */
    gravity?: [number, number, number];
    primitives?: unknown[];
    stepProps?: unknown[];
    targets?: unknown[];
  };
  robots: { id: string; urdf: string; pose: DraftPose }[];
  boards: {
    id: string;
    chip: string;
    firmware: string;
    source?: string;
    pose: DraftPose;
    size: [number, number, number];
  }[];
  supplies: {
    id: string;
    kind: "usb" | "bench" | "weak";
    voltage: number;
    currentLimit: number;
    rSeries: number;
  }[];
  parts: {
    id: string;
    model: string;
    drives?: { robot: string; joint: string };
  }[];
  wires: [string, string][];
};

const IDENTITY: DraftPose = {
  position: [0, 0, 0],
  rotation: [1, 0, 0, 0],
};

type SceneFile = {
  format: string;
  id: string;
  type: string;
  foreign: boolean;
  axes: {
    behaviour: {
      "2": {
        variants: {
          netlist: {
            netlist: {
              instances: Record<
                string,
                {
                  part: string;
                  pose?: Pose;
                  params?: Record<string, number | string | boolean>;
                }
              >;
              wires: [string, string][];
            };
          };
        };
      };
    };
  };
};

function sceneNetlist(worldFile: string): {
  partFile: string;
  scene: SceneFile;
  instances: SceneFile["axes"]["behaviour"]["2"]["variants"]["netlist"]["netlist"]["instances"];
  wires: [string, string][];
} {
  const world = JSON.parse(readFileSync(worldFile, "utf8")) as {
    root?: { part?: string };
  };
  const partId = world.root?.part;
  if (typeof partId !== "string") throw new Error("world has no root part");
  const parsed = partId.match(/^([^/]+)\/([^@]+)@(.+)$/);
  if (!parsed) throw new Error(partId);
  const partFile = path.join(
    path.dirname(worldFile),
    "parts",
    parsed[1] ?? "",
    `${parsed[2]}@${parsed[3]}.json`
  );
  const scene = JSON.parse(readFileSync(partFile, "utf8")) as SceneFile;
  const netlist = scene.axes.behaviour["2"].variants.netlist.netlist;
  return {
    partFile,
    scene,
    instances: netlist.instances,
    wires: netlist.wires,
  };
}

function poseOf(pose: Pose | undefined): DraftPose {
  if (!pose) return IDENTITY;
  return {
    position: [...pose.position] as DraftPose["position"],
    rotation: [...pose.rotation] as DraftPose["rotation"],
  };
}

function jointParent(urdfXml: string, joint: string): string | null {
  const re = new RegExp(
    `<joint\\s+name="${joint}"[\\s\\S]*?<parent\\s+link="([^"]+)"`
  );
  const match = urdfXml.match(re);
  return match?.[1] ?? null;
}

/** The scene behind `worldRel`, as the flat lists the tests edit. */
export function readDraft(project: string, worldRel: string): WorldDraft {
  const planned = planWorld(project, worldRel);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  const plan = planned.plan;
  const worldFile = path.join(project, worldRel);
  const { wires } = sceneNetlist(worldFile);
  const pinName = (endpoint: string) =>
    endpoint.slice(endpoint.lastIndexOf(".") + 1);
  const shown = wires.filter((wire) => {
    const left = pinName(wire[0]);
    const right = pinName(wire[1]);
    return (
      left !== "shaft" &&
      right !== "shaft" &&
      left !== "mount" &&
      right !== "mount"
    );
  });
  return {
    environment: {
      ground: { plane: plan.environment.ground.plane },
      gravity: [...plan.environment.gravity],
      ...(plan.environment.primitives
        ? { primitives: plan.environment.primitives }
        : {}),
      ...(plan.environment.stepProps
        ? { stepProps: plan.environment.stepProps }
        : {}),
      ...(plan.environment.targets.length > 0
        ? { targets: plan.environment.targets }
        : {}),
    },
    robots: plan.robots.map((robot) => ({
      id: robot.id,
      urdf: robot.urdf,
      pose: poseOf(robot.pose),
    })),
    boards: plan.boards.map((board) => ({
      id: board.id,
      chip: board.chip,
      firmware: board.firmware,
      ...(board.source ? { source: board.source } : {}),
      pose: poseOf(board.pose),
      size: [...board.size] as [number, number, number],
    })),
    supplies: plan.supplies.map((supply) => ({
      id: supply.id,
      kind:
        supply.type === "bench-supply-cv-cc"
          ? "bench"
          : supply.type === "weak-source"
            ? "weak"
            : "usb",
      voltage: supply.voltage,
      currentLimit: supply.currentLimit,
      rSeries: supply.rSeries,
    })),
    parts: plan.parts.map((part) => ({
      id: part.id,
      model: part.model,
      ...(part.drives ? { drives: { ...part.drives } } : {}),
    })),
    wires: shown.length > 0 ? shown : plan.wires,
  };
}

function partRef(kind: WorldDraft["supplies"][number]["kind"]): string {
  if (kind === "bench") return "sfab/bench-supply@1.0.0";
  if (kind === "weak") return "sfab/weak-source@1.0.0";
  return "sfab/usb-port-500ma@1.0.0";
}

/**
 * A project-local supply whose series resistance may be 36 Ω. The
 * catalog bench type stays on its tight range; this type exists only
 * so the SOA self-check can load that source.
 */
function writeWeakSource(worldDir: string): void {
  const typePath = path.join(worldDir, "types", "weak-source.json");
  mkdirSync(path.dirname(typePath), { recursive: true });
  writeFileSync(
    typePath,
    `${JSON.stringify(
      {
        format: "sfab.part-type@1",
        id: "weak-source",
        ports: {
          "5V": { domain: "electrical", role: "power", direction: "out" },
          GND: { domain: "electrical", role: "ground", direction: "passive" },
        },
        plausible: { Voltage: [0, 60], Current: [0, 20], Resistance: [0, 100] },
      },
      null,
      2
    )}\n`
  );
  const partPath = path.join(
    worldDir,
    "parts",
    "sfab",
    "weak-source@1.0.0.json"
  );
  mkdirSync(path.dirname(partPath), { recursive: true });
  writeFileSync(
    partPath,
    `${JSON.stringify(
      {
        format: "sfab.part@1",
        id: "sfab/weak-source@1.0.0",
        type: "weak-source",
        foreign: false,
        axes: {
          behaviour: {
            "1": {
              default: "thevenin",
              variants: {
                thevenin: {
                  kind: "form",
                  form: "thevenin-limit@1",
                  params: { V: 5, Rs: 36, Ilimit: 1 },
                  omits: ["sense-lead drop", "heat"],
                },
              },
            },
          },
          body: {
            "0": {
              default: "none",
              variants: { none: { kind: "none", omits: ["chassis"] } },
            },
          },
          visual: {
            "0": {
              default: "none",
              variants: { none: { kind: "none", omits: ["panel"] } },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
}

function writeUrdfPart(
  worldDir: string,
  robot: WorldDraft["robots"][number],
  parts: WorldDraft["parts"]
): void {
  const typeId = `${robot.id}-robot`;
  const ports: Record<string, unknown> = {};
  let urdfXml = "";
  try {
    urdfXml = readFileSync(path.resolve(worldDir, robot.urdf), "utf8");
  } catch {
    urdfXml = "";
  }
  for (const part of parts) {
    if (part.drives?.robot !== robot.id) continue;
    ports[part.drives.joint] = {
      domain: "rotational",
      direction: "passive",
      frame: part.drives.joint,
    };
    const parent = jointParent(urdfXml, part.drives.joint) ?? "base";
    ports[parent] = {
      domain: "mount",
      direction: "passive",
      frame: parent,
    };
  }
  const typePath = path.join(worldDir, "types", `${typeId}.json`);
  mkdirSync(path.dirname(typePath), { recursive: true });
  writeFileSync(
    typePath,
    `${JSON.stringify(
      {
        format: "sfab.part-type@1",
        id: typeId,
        ports,
        plausible: { Torque: [-5, 5], AngularVelocity: [-100, 100] },
      },
      null,
      2
    )}\n`
  );
  const partPath = path.join(
    worldDir,
    "parts",
    "sfab",
    `${robot.id}@1.0.0.json`
  );
  mkdirSync(path.dirname(partPath), { recursive: true });
  writeFileSync(
    partPath,
    `${JSON.stringify(
      {
        format: "sfab.part@1",
        id: `sfab/${robot.id}@1.0.0`,
        type: typeId,
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
                  file: robot.urdf,
                  omits: ["link flex"],
                },
              },
            },
          },
          visual: {
            "0": {
              default: "none",
              variants: {
                none: { kind: "none", omits: ["link meshes"] },
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
}

/** Write `worldRel` and its scene part. Instance ids stay the draft's ids. */
export function writeDraft(
  project: string,
  worldRel: string,
  draft: WorldDraft
): void {
  const worldFile = path.join(project, worldRel);
  const stem = path
    .basename(worldRel)
    .replace(/\.world\.json$/, "")
    .replace(/\.json$/, "");
  const partId = `sfab/${stem}-scene@1.0.0`;
  const instances: SceneFile["axes"]["behaviour"]["2"]["variants"]["netlist"]["netlist"]["instances"] =
    {};
  const wires: [string, string][] = draft.wires.map((wire) => [
    wire[0],
    wire[1],
  ]);
  for (const robot of draft.robots) {
    if (robot.urdf === "robot/arm.urdf") {
      instances[robot.id] = { part: "sfab/arm@1.0.0", pose: robot.pose };
      continue;
    }
    // The arm type only declares the example's joints. Another URDF
    // gets a part whose ports are the joints this draft drives.
    const partId = `sfab/${robot.id}@1.0.0`;
    writeUrdfPart(path.dirname(worldFile), robot, draft.parts);
    instances[robot.id] = { part: partId, pose: robot.pose };
  }
  for (const board of draft.boards) {
    const params: Record<string, string> = { firmware: board.firmware };
    if (board.source) params.source = board.source;
    instances[board.id] = {
      part: "sfab/uno-r3@1.0.0",
      pose: board.pose,
      params,
    };
  }
  if (draft.supplies.some((supply) => supply.kind === "weak")) {
    writeWeakSource(path.dirname(worldFile));
  }
  for (const supply of draft.supplies) {
    instances[supply.id] = {
      part: partRef(supply.kind),
      params: {
        V: supply.voltage,
        Ilimit: supply.currentLimit,
        Rs: supply.rSeries,
      },
    };
  }
  for (const part of draft.parts) {
    instances[part.id] = { part: "sfab/sg90@1.0.0" };
    if (!part.drives) continue;
    const robot = draft.robots.find((item) => item.id === part.drives?.robot);
    const urdfAbs = robot
      ? path.resolve(path.dirname(worldFile), robot.urdf)
      : "";
    let parent = "base";
    if (urdfAbs) {
      try {
        parent =
          jointParent(readFileSync(urdfAbs, "utf8"), part.drives.joint) ??
          parent;
      } catch {
        parent = "base";
      }
    }
    wires.push(
      [`${part.id}.shaft`, `${part.drives.robot}.${part.drives.joint}`],
      [`${part.id}.mount`, `${part.drives.robot}.${parent}`]
    );
  }
  const scene: SceneFile = {
    format: "sfab.part@1",
    id: partId,
    type: "assembly",
    foreign: false,
    axes: {
      behaviour: {
        "2": {
          variants: {
            netlist: {
              netlist: { instances, wires },
            },
          },
        },
      },
    },
  };
  const sceneFull = {
    ...scene,
    axes: {
      ...scene.axes,
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["no snapshot of this assembly"],
              netlist: { instances, wires, expose: {} },
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
  };
  const parsed = partId.match(/^([^/]+)\/([^@]+)@(.+)$/);
  if (!parsed) throw new Error(partId);
  const partFile = path.join(
    path.dirname(worldFile),
    "parts",
    parsed[1] ?? "",
    `${parsed[2]}@${parsed[3]}.json`
  );
  mkdirSync(path.dirname(partFile), { recursive: true });
  writeFileSync(partFile, `${JSON.stringify(sceneFull, null, 2)}\n`);
  const environment: Record<string, unknown> = {
    ground: { plane: draft.environment.ground.plane },
    gravity: draft.environment.gravity ?? [0, 0, -9.81],
  };
  if (draft.environment.primitives) {
    environment.primitives = draft.environment.primitives;
  }
  if (draft.environment.stepProps) {
    environment.stepProps = draft.environment.stepProps;
  }
  if (draft.environment.targets) {
    environment.targets = draft.environment.targets;
  }
  writeFileSync(
    worldFile,
    `${JSON.stringify(
      {
        version: 2,
        environment,
        run: { seed: 1, levels: { default: 1 } },
        root: { id: "scene", part: partId },
      },
      null,
      2
    )}\n`
  );
  // The scene part changed, so the previous lock no longer describes it.
  rmSync(lockPathFor(worldFile), { force: true });
}
