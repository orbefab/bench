import type { UrdfInfo, WorldViewFeeds } from "@sfab-bench/contract";

export type WorldOutlineJoint = {
  name: string;
  type: string;
  axis: [number, number, number] | null;
  /** Degrees. Set for a revolute joint that published a limit. */
  lowerDeg: number | null;
  upperDeg: number | null;
  /** Millimetres. Set for a prismatic joint that published a limit. */
  lowerMm: number | null;
  upperMm: number | null;
};

export type WorldOutlineLink = {
  name: string;
  meshes: string[];
  /** The joint whose child is this link. The root link has none. */
  joint: WorldOutlineJoint | null;
};

export type WorldOutlineBoard = {
  id: string;
  chip: string;
  firmware: string;
  source?: string;
  brownoutVoltage?: number;
};

export type WorldOutlineWire = {
  /** Pin on the part, for example `signal`. */
  pin: string;
  /** The other end, for example `uno.D9`. */
  other: string;
};

export type WorldOutlinePart = {
  id: string;
  model: string;
  drives: { robot: string; joint: string } | null;
  /** Servo signal pin. Absent or null when the part is not a servo. */
  signalPin?: string | null;
  wires: WorldOutlineWire[];
};

export type WorldOutlineSupply = {
  id: string;
  /** Nominal volts, before series drop. */
  voltage: number;
  currentLimit: number;
  rSeries: number;
  /** Boards whose power input this supply reaches. */
  boards: string[];
  /** Parts whose supply pin this supply reaches. */
  parts: string[];
};

export type WorldOutline = {
  robots: { id: string; links: WorldOutlineLink[] }[];
  parts: WorldOutlinePart[];
  boards: WorldOutlineBoard[];
  supplies: WorldOutlineSupply[];
};

export type WorldOutlineInput = {
  robots: readonly { id: string }[];
  boards: readonly {
    id: string;
    chip: string;
    firmware: string;
    source?: string;
    brownoutVoltage?: number;
  }[];
  parts?: readonly {
    id: string;
    model: string;
    drives?: { robot: string; joint: string };
    signalPin?: string | null;
  }[];
  wires?: readonly [string, string][];
  supplies?: readonly {
    id: string;
    voltage: number;
    currentLimit: number;
    rSeries: number;
  }[];
  /** Which supply reaches each board and part. The server computed this. */
  feeds?: WorldViewFeeds;
};

const WIRE_PIN_ORDER = ["signal", "V+", "GND"];

function endpoint(value: string): { id: string; pin: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot >= value.length - 1) return null;
  return { id: value.slice(0, dot), pin: value.slice(dot + 1) };
}

function wiresFor(
  partId: string,
  wires: readonly [string, string][]
): WorldOutlineWire[] {
  const found: WorldOutlineWire[] = [];
  for (const wire of wires) {
    const left = endpoint(wire[0]);
    const right = endpoint(wire[1]);
    if (!left || !right) continue;
    if (left.id === partId) found.push({ pin: left.pin, other: wire[1] });
    else if (right.id === partId) {
      found.push({ pin: right.pin, other: wire[0] });
    }
  }
  return found.sort((a, b) => {
    const ai = WIRE_PIN_ORDER.indexOf(a.pin);
    const bi = WIRE_PIN_ORDER.indexOf(b.pin);
    const ao = ai < 0 ? WIRE_PIN_ORDER.length : ai;
    const bo = bi < 0 ? WIRE_PIN_ORDER.length : bi;
    if (ao !== bo) return ao - bo;
    return a.pin.localeCompare(b.pin);
  });
}

/** `servo · sg90` */
export function outlinePartLabel(part: { id: string; model: string }): string {
  return `${part.id} · ${part.model}`;
}

/** `signal ← uno.D9` */
export function formatPartWire(wire: WorldOutlineWire): string {
  return `${wire.pin} ← ${wire.other}`;
}

function revoluteDegrees(type: string, radians: number | null): number | null {
  if (type !== "revolute" || radians === null || !Number.isFinite(radians)) {
    return null;
  }
  return (radians * 180) / Math.PI;
}

function prismaticMillimetres(
  type: string,
  metres: number | null
): number | null {
  if (type !== "prismatic" || metres === null || !Number.isFinite(metres)) {
    return null;
  }
  return metres * 1000;
}

/** Feeds the server already resolved. An absent map feeds nothing. */
function supplyFeeds(world: WorldOutlineInput): WorldOutlineSupply[] {
  const feeds = world.feeds ?? { boards: {}, parts: {} };
  return (world.supplies ?? []).map((supply) => ({
    id: supply.id,
    voltage: supply.voltage,
    currentLimit: supply.currentLimit,
    rSeries: supply.rSeries,
    boards: world.boards
      .filter((board) => feeds.boards[board.id] === supply.id)
      .map((board) => board.id),
    parts: (world.parts ?? [])
      .filter((part) => feeds.parts[part.id] === supply.id)
      .map((part) => part.id),
  }));
}

/** Robots, the joint that moves each link, parts, boards, and supplies. Pure. */
export function buildWorldOutline(
  world: WorldOutlineInput,
  urdfByRobot: Readonly<Record<string, UrdfInfo>>
): WorldOutline {
  const wires = world.wires ?? [];
  return {
    robots: world.robots.map((robot) => {
      const info = urdfByRobot[robot.id];
      const links = info?.links ?? [];
      return {
        id: robot.id,
        links: links.map((name) => {
          const joint = info?.jointInfo.find((item) => item.child === name);
          return {
            name,
            meshes: info?.linkMeshes[name] ?? [],
            joint: joint
              ? {
                  name: joint.name,
                  type: joint.type,
                  axis: joint.axis,
                  lowerDeg: revoluteDegrees(joint.type, joint.lower),
                  upperDeg: revoluteDegrees(joint.type, joint.upper),
                  lowerMm: prismaticMillimetres(joint.type, joint.lower),
                  upperMm: prismaticMillimetres(joint.type, joint.upper),
                }
              : null,
          };
        }),
      };
    }),
    parts: (world.parts ?? []).map((part) => ({
      id: part.id,
      model: part.model,
      drives: part.drives ?? null,
      signalPin: part.signalPin ?? null,
      wires: wiresFor(part.id, wires),
    })),
    boards: world.boards.map((board) => ({
      id: board.id,
      chip: board.chip,
      firmware: board.firmware,
      ...(board.source ? { source: board.source } : {}),
      brownoutVoltage: board.brownoutVoltage ?? 2.7,
    })),
    supplies: supplyFeeds(world),
  };
}

export function outlineItems(outline: WorldOutline): {
  links: { robot: string; link: string }[];
  boards: string[];
  parts: string[];
  supplies: string[];
} {
  const links: { robot: string; link: string }[] = [];
  for (const robot of outline.robots) {
    for (const link of robot.links) {
      links.push({ robot: robot.id, link: link.name });
    }
  }
  return {
    links,
    boards: outline.boards.map((board) => board.id),
    parts: outline.parts.map((part) => part.id),
    supplies: outline.supplies.map((supply) => supply.id),
  };
}

/** Trimmed degrees for a joint limit. */
export function formatDegrees(degrees: number): string {
  const rounded = Math.round(degrees * 1000) / 1000;
  return String(rounded);
}

/** One decimal, so a live joint angle can move without jumping format. */
export function formatLiveDegrees(radians: number): string {
  const degrees = (radians * 180) / Math.PI;
  return (Math.round(degrees * 10) / 10).toFixed(1);
}

/** One decimal. `metres` is a prismatic joint position. */
export function formatLiveMillimetres(metres: number): string {
  const mm = metres * 1000;
  return (Math.round(mm * 10) / 10).toFixed(1);
}

export type JointReadout = {
  label: "Angle" | "Position";
  value: string;
  limits: string | null;
};

/** Revolute and continuous joints are degrees. A prismatic joint is millimetres. */
export function formatJointReadout(
  joint: WorldOutlineJoint,
  qpos: number | undefined
): JointReadout {
  if (joint.type === "prismatic") {
    const limits =
      joint.lowerMm !== null && joint.upperMm !== null
        ? `${formatDegrees(joint.lowerMm)} mm to ${formatDegrees(joint.upperMm)} mm`
        : null;
    return {
      label: "Position",
      value: qpos === undefined ? "—" : `${formatLiveMillimetres(qpos)} mm`,
      limits,
    };
  }
  const angular = joint.type === "revolute" || joint.type === "continuous";
  const limits =
    angular && joint.lowerDeg !== null && joint.upperDeg !== null
      ? `${formatDegrees(joint.lowerDeg)}° to ${formatDegrees(joint.upperDeg)}°`
      : null;
  return {
    label: "Angle",
    value: qpos === undefined ? "—" : `${formatLiveDegrees(qpos)}°`,
    limits,
  };
}
