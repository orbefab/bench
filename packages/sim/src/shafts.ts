/**
 * Circuit parts that turn or read a body joint. A `dc-motor@1` winding
 * and a `potentiometer@1` wiper each have one rotational port. Their
 * rotational nets lead to a URDF joint, straight or through one part
 * whose body is a `gear-train`. The train is not instanced: its rigid
 * collapse sets the joint's armature, damping and friction, and its
 * ratio scales the motor's speed and torque. A `servo-control@1` reads a
 * pulse on its logic input from the board pin on that net.
 */

import type { BodyImpl, PortDecl } from "@sfab-bench/contract";
import { collapse } from "@sfab-bench/engine-body";
import {
  gearTrainErrors,
  type LiveInstance,
  type LiveNet,
  siValue,
} from "@sfab-bench/parts";

import type { CircuitInst } from "./circuit-stamp";

/**
 * A URDF joint that circuit parts turn or read. The body engine names
 * its actuator `id`. Absent `joint` keeps the URDF's own terms.
 */
export type RunShaft = {
  id: string;
  drives: { robot: string; joint: string };
  joint?: { armature: number; damping: number; frictionloss: number };
  /** N·m, from a torque rating on the joint's net. 0 is no clamp. */
  torqueNm: number;
  /**
   * `dc-motor@1` windings: `ω_motor = ratio·ω_joint` and
   * `τ_joint = ratio·efficiency·K·I`.
   */
  motors: { path: string; k: number; efficiency: number; ratio: number }[];
  /** `potentiometer@1` wipers: `fraction = ratio·angle / travel`. */
  sensors: { path: string; ratio: number; travel: number }[];
  /**
   * The instance `id` names, read at its own ports: a stamped part's
   * `path.port` on the net of its power input, and one on its ground's
   * net. Null when that port is absent or no stamped part is on its net.
   */
  ports: { power: string | null; ground: string | null };
};

/**
 * `servo-control@1`. A pulse on its logic input is the command. Its
 * bridge ratio is the angle error over `eSat`, the angle read as the
 * latched sense ratio times `travel`.
 */
export type RunControl = {
  path: string;
  /** Board pin on its logic input's net. Null: `setTarget` commands it. */
  signal: { boardId: string; pin: string } | null;
  eSat: number;
  travel: number;
};

/** Forms whose one rotational port couples them to a joint. */
const SHAFT_FORMS = new Set(["dc-motor@1", "potentiometer@1"]);

type Reach =
  | {
      ok: true;
      robot: string;
      joint: string;
      ratio: number;
      train: LiveInstance | null;
      net: LiveNet;
    }
  | { ok: false; detail: string };

function rotationalPorts(
  ports: Record<string, PortDecl>,
  direction?: string
): string[] {
  return Object.entries(ports)
    .filter(
      ([, decl]) =>
        decl.domain === "rotational" &&
        (direction === undefined || decl.direction === direction)
    )
    .map(([name]) => name)
    .sort();
}

function bodyOf(inst: LiveInstance | undefined): BodyImpl | null {
  return (inst?.axes.body.impl as BodyImpl | null | undefined) ?? null;
}

/**
 * From one rotational port to a URDF joint. A part whose body is a
 * `gear-train` is crossed from its one rotational input to its one
 * rotational output, and the ratio multiplies. One train at most.
 */
function reachJoint(
  start: string,
  nets: readonly LiveNet[],
  byPath: ReadonlyMap<string, LiveInstance>
): Reach {
  let full = start;
  let ratio = 1;
  let train: LiveInstance | null = null;
  for (;;) {
    const net = nets.find(
      (item) =>
        item.domain === "rotational" &&
        item.ports.some((port) => port.full === full)
    );
    if (!net) return { ok: false, detail: "its shaft is on no net" };
    const urdf = net.ports.find(
      (port) => bodyOf(byPath.get(port.path))?.kind === "urdf"
    );
    if (urdf) {
      return {
        ok: true,
        robot: urdf.path,
        joint: urdf.port,
        ratio,
        train,
        net,
      };
    }
    const next = net.ports.find((port) => {
      if (port.full === full) return false;
      const inst = byPath.get(port.path);
      if (bodyOf(inst)?.kind !== "gear-train" || !inst) return false;
      return rotationalPorts(inst.type.ports, "in").includes(port.port);
    });
    if (!next) return { ok: false, detail: "its shaft reaches no joint" };
    if (train) {
      return {
        ok: false,
        detail: "its shaft crosses more than one gear train",
      };
    }
    const inst = byPath.get(next.path);
    const body = bodyOf(inst);
    if (!inst || body?.kind !== "gear-train") {
      return { ok: false, detail: "its shaft reaches no joint" };
    }
    if (gearTrainErrors(inst.part.id, body).length > 0) {
      return { ok: false, detail: `gear train ${inst.path} does not walk` };
    }
    if (rotationalPorts(inst.type.ports, "in").length !== 1) {
      return {
        ok: false,
        detail: `gear train ${inst.path} needs one rotational input`,
      };
    }
    const outs = rotationalPorts(inst.type.ports, "out");
    if (outs.length !== 1 || !outs[0]) {
      return {
        ok: false,
        detail: `gear train ${inst.path} needs one rotational output`,
      };
    }
    ratio *= Math.abs(collapse(body).ratio);
    train = inst;
    full = `${inst.path}.${outs[0]}`;
  }
}

/**
 * A stamped part's `path.port` on the net of the instance's one port with
 * `role`, inside the instance first. A power port must be an input.
 */
function stampedPeer(
  inst: LiveInstance,
  role: "power" | "ground",
  nets: readonly LiveNet[],
  stamped: ReadonlySet<string>
): string | null {
  const names = Object.entries(inst.type.ports)
    .filter(
      ([, decl]) =>
        decl.role === role && (role === "ground" || decl.direction === "in")
    )
    .map(([name]) => name);
  if (names.length !== 1) return null;
  const full = `${inst.path}.${names[0]}`;
  const net = nets.find((item) => item.ports.some((end) => end.full === full));
  if (!net) return null;
  const peers = net.ports
    .filter((end) => stamped.has(end.path))
    .map((end) => end.full)
    .sort();
  const inside = peers.find((end) => end.startsWith(`${inst.path}.`));
  return inside ?? (stamped.has(inst.path) ? full : (peers[0] ?? null));
}

/** The clamp: the torque rating on the joint's net nearest the scene root. */
function torqueOn(net: LiveNet, robot: string): number {
  const rated = net.ports
    .filter((port) => port.path !== robot)
    .map((port) => {
      const high = port.ratings.torque?.[1];
      return {
        path: port.path,
        value: high === undefined ? null : siValue(high),
      };
    })
    .filter(
      (row): row is { path: string; value: number } =>
        typeof row.value === "number" && row.value > 0
    )
    .sort(
      (a, b) =>
        a.path.split(".").length - b.path.split(".").length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    );
  return rated[0]?.value ?? 0;
}

/** Actuator name: the instance on the joint's net nearest the scene root. */
function shaftId(net: LiveNet, robot: string): string {
  const paths = [
    ...new Set(
      net.ports.filter((port) => port.path !== robot).map((port) => port.path)
    ),
  ].sort(
    (a, b) =>
      a.split(".").length - b.split(".").length || (a < b ? -1 : a > b ? 1 : 0)
  );
  return paths[0] ?? robot;
}

export type Coupled = {
  shafts: RunShaft[];
  controls: RunControl[];
  /** Gear-train parts a shaft crosses. They run as that collapse. */
  trains: Set<string>;
  /** Circuit parts that cannot run, with the reason. */
  idle: { path: string; detail: string }[];
};

/**
 * Shafts and controls for the circuit parts that have them. `drivenJoints`
 * are joints a `position-servo@1` part already turns.
 */
export function coupleShafts(input: {
  circuits: readonly CircuitInst[];
  resolved: readonly LiveInstance[];
  nets: readonly LiveNet[];
  boards: readonly {
    id: string;
    pins: Record<string, { digital: boolean }>;
  }[];
  drivenJoints: ReadonlySet<string>;
}): Coupled {
  const byPath = new Map(input.resolved.map((inst) => [inst.path, inst]));
  const shafts = new Map<string, RunShaft>();
  const trains = new Set<string>();
  const idle: { path: string; detail: string }[] = [];
  const controls: RunControl[] = [];
  for (const part of input.circuits) {
    const inst = byPath.get(part.path);
    if (!inst) continue;
    if (part.form === "servo-control@1") {
      controls.push({
        path: part.path,
        signal: pulsePin(inst, input.nets, input.boards),
        eSat: part.params.eSat ?? 0,
        travel: part.params.travel ?? 0,
      });
      continue;
    }
    if (!SHAFT_FORMS.has(part.form)) continue;
    const [port, ...extra] = rotationalPorts(inst.type.ports);
    if (!port || extra.length > 0) {
      idle.push({
        path: part.path,
        detail: `${part.form} needs one rotational port on ${inst.type.id}`,
      });
      continue;
    }
    const reach = reachJoint(`${part.path}.${port}`, input.nets, byPath);
    if (!reach.ok) {
      idle.push({ path: part.path, detail: `${part.form}: ${reach.detail}` });
      continue;
    }
    const key = `${reach.robot}/${reach.joint}`;
    if (input.drivenJoints.has(key)) {
      idle.push({
        path: part.path,
        detail: `${part.form}: joint ${key} is already driven by a position-servo@1 part`,
      });
      continue;
    }
    let shaft = shafts.get(key);
    if (!shaft) {
      shaft = {
        id: shaftId(reach.net, reach.robot),
        drives: { robot: reach.robot, joint: reach.joint },
        torqueNm: torqueOn(reach.net, reach.robot),
        motors: [],
        sensors: [],
        ports: { power: null, ground: null },
      };
      shafts.set(key, shaft);
    }
    const body = bodyOf(reach.train ?? undefined);
    if (body?.kind === "gear-train" && reach.train) {
      const lumped = collapse(body);
      const joint = {
        armature: lumped.armature,
        damping: lumped.damping,
        frictionloss: lumped.frictionloss,
      };
      if (
        shaft.joint &&
        (shaft.joint.armature !== joint.armature ||
          shaft.joint.damping !== joint.damping ||
          shaft.joint.frictionloss !== joint.frictionloss)
      ) {
        idle.push({
          path: part.path,
          detail: `${part.form}: joint ${key} already has another gear train`,
        });
        continue;
      }
      shaft.joint = joint;
      trains.add(reach.train.path);
    }
    if (part.form === "dc-motor@1") {
      if (shaft.motors.length > 0) {
        idle.push({
          path: part.path,
          detail: `${part.form}: joint ${key} already has a motor`,
        });
        continue;
      }
      shaft.motors.push({
        path: part.path,
        k: part.params.K ?? 0,
        efficiency: part.params.efficiency ?? 0,
        ratio: reach.ratio,
      });
    } else {
      shaft.sensors.push({
        path: part.path,
        ratio: reach.ratio,
        travel: part.params.travel ?? 0,
      });
    }
  }
  const stamped = new Set(input.circuits.map((part) => part.path));
  for (const shaft of shafts.values()) {
    const inst = byPath.get(shaft.id);
    if (!inst) continue;
    shaft.ports = {
      power: stampedPeer(inst, "power", input.nets, stamped),
      ground: stampedPeer(inst, "ground", input.nets, stamped),
    };
  }
  return {
    shafts: [...shafts.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
    controls,
    trains,
    idle,
  };
}

/** The digital board pin on the net of the instance's one logic input. */
function pulsePin(
  inst: LiveInstance,
  nets: readonly LiveNet[],
  boards: readonly {
    id: string;
    pins: Record<string, { digital: boolean }>;
  }[]
): { boardId: string; pin: string } | null {
  const inputs = Object.entries(inst.type.ports)
    .filter(
      ([, decl]) =>
        decl.domain === "electrical" &&
        decl.role === "logic" &&
        decl.direction === "in"
    )
    .map(([name]) => name);
  const [port] = inputs;
  if (!port || inputs.length > 1) return null;
  const full = `${inst.path}.${port}`;
  const net = nets.find((item) => item.ports.some((end) => end.full === full));
  if (!net) return null;
  for (const end of net.ports) {
    const board = boards.find((item) => item.id === end.path);
    if (board?.pins[end.port]?.digital) {
      return { boardId: board.id, pin: end.port };
    }
  }
  return null;
}

/**
 * The plan as the body compiler reads it: each shaft is one more
 * actuated joint, after the `position-servo@1` parts.
 */
export function bodySceneOf<
  T extends {
    parts: readonly {
      id: string;
      drives?: { robot: string; joint: string };
      motor?: { armature: number; frictionloss: number; damping: number };
      torqueNm?: number;
    }[];
    shafts?: readonly RunShaft[];
  },
>(plan: T): T {
  const shafts = plan.shafts ?? [];
  if (shafts.length === 0) return plan;
  return {
    ...plan,
    parts: [
      ...plan.parts,
      ...shafts.map((shaft) => ({
        id: shaft.id,
        drives: shaft.drives,
        ...(shaft.joint ? { motor: shaft.joint } : {}),
        ...(shaft.torqueNm > 0 ? { torqueNm: shaft.torqueNm } : {}),
      })),
    ],
  };
}
