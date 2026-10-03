import type { MainModule, MjModel, MjSpec, MjVFS } from "@mujoco/mujoco";
import {
  extractUrdfJointsAndMeshes,
  resolveUrdfMesh,
  targetPosition,
  WORLD_TARGET_ROBOT,
  type WorldError,
  type WorldPose,
  type WorldPrimitive,
  type WorldTarget,
} from "@sfab-bench/contract";

/** Bytes relative to the world file. Mesh paths are joined before the read. */
export type BodyBytes = {
  read(relativeToWorld: string): Uint8Array | null;
};

type BodyMotor = {
  armature: number;
  frictionloss: number;
  damping: number;
};

/**
 * The slice of a run plan the compiler reads. The server's plan is
 * assignable: the extra fields stay with the host.
 */
export type BodyScene = {
  /** Seconds. Absent means `TIMESTEP_S`. */
  timestep?: number;
  environment: {
    ground: { plane: boolean };
    gravity: [number, number, number];
    primitives?: WorldPrimitive[];
    targets: WorldTarget[];
  };
  robots: { id: string; urdf: string; pose: WorldPose }[];
  parts: {
    id: string;
    drives?: { robot: string; joint: string };
    motor?: BodyMotor;
    torqueNm?: number;
  }[];
  rangers?: { length: number };
};

const TIMESTEP_S = 0.001;

/**
 * MuJoCo's default limit solref is `[0.02, 1]`. At the 1 ms step that
 * rests about 1.4° past a stop and peaks about 5° when the servo hits it
 * at full torque. `[0.002, 1]` is the stiffest pair the solver allows
 * (timeconst ≥ 2 × timestep) and measured 0.025° at rest, 0.70° at the
 * peak. MuJoCo 3.14's URDF reader ignores a joint `<mujoco>`
 * `solreflimit`, so this pass applies that attribute when the URDF
 * has one and otherwise writes this pair. The time constant is never
 * set below 2 × timestep.
 */
export const JOINT_LIMIT_SOLREF: readonly [number, number] = [0.002, 1];
const MUJOCO_LIMIT_SOLREF: readonly [number, number] = [0.02, 1];

export type WorldModelCounts = {
  nbody: number;
  njnt: number;
  nu: number;
  nmesh: number;
  bodyNames: string[];
  jointNames: string[];
  actuatorNames: string[];
  meshNames: string[];
  geomNames: string[];
};

export type WorldModelIndex = WorldModelCounts & {
  /** robot id → link name → body id. */
  links: Record<string, Record<string, number>>;
  /** robot id → joint name → qpos address. */
  joints: Record<string, Record<string, number>>;
  /** part id → actuator id. The actuator's MuJoCo name is the part id. */
  parts: Record<string, number>;
  /** MuJoCo body name for each link, so the stepper does not rebuild it. */
  linkNames: Record<string, Record<string, string>>;
  jointNamesByRobot: Record<string, Record<string, string>>;
  /** Mocap body for each environment target. Empty when the world has none. */
  targets: { id: string; body: number; mocap: number }[];
};

export type CompiledWorld = {
  ok: true;
  mj: MainModule;
  model: MjModel;
  /** Mesh bytes live here until the model is finished with them. */
  vfs: MjVFS;
  index: WorldModelIndex;
};

export type CompileFailure = { ok: false; errors: WorldError[] };

let mujocoModule: Promise<MainModule> | null = null;

function mujoco(): Promise<MainModule> {
  if (!mujocoModule) {
    mujocoModule = import("@mujoco/mujoco")
      .then((mod) => mod.default())
      .catch((err: unknown) => {
        mujocoModule = null;
        throw err;
      });
  }
  return mujocoModule;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function schemaError(message: string): WorldError {
  const text = message.includes("Hint:")
    ? message
    : `${message} Hint: check the world file and the URDF.`;
  return { code: "schema", path: "", message: text };
}

const COMPILER_FORCED: ReadonlyArray<readonly [string, string]> = [
  ["fusestatic", "false"],
  ["discardvisual", "false"],
  // Empty so a URDF meshdir does not prefix the VFS paths we write.
  ["meshdir", ""],
];

/** Keep every other attribute. Force the three MuJoCo flags this runtime needs. */
function forceCompilerAttrs(attrs: string): string {
  let next = attrs.replace(/\/\s*$/, "");
  for (const [name, value] of COMPILER_FORCED) {
    const re = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*')`, "i");
    if (re.test(next)) next = next.replace(re, `${name}="${value}"`);
    else next += ` ${name}="${value}"`;
  }
  return `<compiler${next}/>`;
}

/**
 * MuJoCo's URDF compiler fuses a static base into the world unless
 * `fusestatic` is false, and it drops visual meshes when `discardvisual`
 * is true. Inject the element when the URDF has none, and force those
 * flags (and `meshdir`) without dropping the rest of the compiler tag.
 */
export function ensureMujocoCompiler(xml: string): string {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const compiler = forceCompilerAttrs("");
  if (!/<mujoco\b/i.test(stripped)) {
    return stripped.replace(
      /<robot\b[^>]*>/i,
      (open) => `${open}<mujoco>${compiler}</mujoco>`
    );
  }
  if (!/<compiler\b/i.test(stripped)) {
    return stripped.replace(/<mujoco\b[^>]*>/i, (open) => `${open}${compiler}`);
  }
  return stripped.replace(/<compiler\b([^>]*)>/i, (_full, attrs: string) =>
    forceCompilerAttrs(attrs)
  );
}

const MESH_HINT = "export STL with $cad (`cadgen stl build`)";

/** Same mesh rules the v1 validator reported as `mesh-format`. */
function meshFormatProblem(filename: string): string | null {
  const trimmed = filename.trim();
  if (trimmed.toLowerCase().startsWith("package://")) {
    return `Mesh "${filename}" uses a package:// path. Hint: ${MESH_HINT}.`;
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return `Mesh "${filename}" is an absolute path. Hint: ${MESH_HINT}.`;
  }
  if (trimmed.includes("\\") || trimmed.split("/").includes("..")) {
    return `Mesh "${filename}" leaves the URDF directory. Hint: ${MESH_HINT}.`;
  }
  const base = (trimmed.split(/[\\/]/).pop() ?? trimmed).toLowerCase();
  if (base.endsWith(".stl") || base.endsWith(".obj")) return null;
  return `Mesh "${filename}" is not .stl or .obj. Hint: ${MESH_HINT}.`;
}

function retargetMeshes(
  xml: string,
  robotId: string
): { xml: string; meshes: { written: string; vfs: string }[] } {
  const meshes: { written: string; vfs: string }[] = [];
  const next = xml.replace(/<mesh\b([^>]*?)(\/?)>/gi, (full, attrs: string) => {
    const match = /filename\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!match) return full;
    const written = match[1] ?? match[2] ?? "";
    const vfs = `${robotId}/${written}`.replace(/\/{2,}/g, "/");
    meshes.push({ written, vfs });
    const replaced = attrs.replace(
      /filename\s*=\s*(?:"[^"]*"|'[^']*')/i,
      `filename="${vfs}"`
    );
    const close = full.trimEnd().endsWith("/>") ? "/>" : ">";
    return `<mesh${replaced}${close}`;
  });
  return { xml: next, meshes };
}

function nums(values: readonly number[]): string {
  return values.map((n) => String(n)).join(" ");
}

function poseAttrs(pose: WorldPose): string {
  return `pos="${nums(pose.position)}" quat="${nums(pose.rotation)}"`;
}

function primitiveGeom(primitive: WorldPrimitive): string {
  const pose = poseAttrs(primitive.pose);
  const name = `name="${primitive.id}"`;
  if (primitive.shape === "box") {
    const half = primitive.size.map((n) => n / 2);
    return `<geom ${name} type="box" size="${nums(half)}" ${pose}/>`;
  }
  if (primitive.shape === "sphere") {
    return `<geom ${name} type="sphere" size="${primitive.size}" ${pose}/>`;
  }
  const halfLength = primitive.size.length / 2;
  return `<geom ${name} type="cylinder" size="${primitive.size.radius} ${halfLength}" ${pose}/>`;
}

/**
 * Mocap, and contact off. A mocap body would not move from a contact
 * anyway; contype and conaffinity 0 means it also does not push a robot.
 * The geom stays in the default group so a ray can hit it.
 */
function targetBody(target: WorldTarget): string {
  const at = targetPosition(target, 0, null);
  const pose = poseAttrs({ position: at, rotation: target.pose.rotation });
  const name = `name="${WORLD_TARGET_ROBOT}/${target.id}"`;
  const contact = `contype="0" conaffinity="0"`;
  let geom: string;
  if (target.shape === "box") {
    const half = target.size.map((n) => n / 2);
    geom = `<geom ${name} type="box" size="${nums(half)}" ${contact}/>`;
  } else if (target.shape === "sphere") {
    geom = `<geom ${name} type="sphere" size="${target.size}" ${contact}/>`;
  } else {
    const halfLength = target.size.length / 2;
    geom = `<geom ${name} type="cylinder" size="${target.size.radius} ${halfLength}" ${contact}/>`;
  }
  return `<body name="${WORLD_TARGET_ROBOT}/${target.id}" mocap="true" ${pose}>${geom}</body>`;
}

function worldXml(plan: BodyScene): string {
  const geoms: string[] = [];
  if (plan.environment.ground.plane) {
    geoms.push('<geom name="ground" type="plane" size="2 2 0.1"/>');
  }
  for (const primitive of plan.environment.primitives ?? []) {
    geoms.push(primitiveGeom(primitive));
  }
  for (const target of plan.environment.targets) {
    geoms.push(targetBody(target));
  }
  const mounts = plan.robots
    .map((robot) => {
      return `<body name="pose_${robot.id}" ${poseAttrs(robot.pose)}/>`;
    })
    .join("");
  const gravity = plan.environment.gravity.map((n) => String(n)).join(" ");
  const timestep = plan.timestep ?? TIMESTEP_S;
  return `<mujoco model="world">
    <option timestep="${timestep}" gravity="${gravity}" integrator="implicitfast"/>
    <worldbody>
      ${geoms.join("\n")}
      ${mounts}
    </worldbody>
  </mujoco>`;
}

function namesOf(
  mj: MainModule,
  model: MjModel,
  count: number,
  obj: number
): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(mj.mj_id2name(model, obj, i) ?? "");
  return out;
}

function readNum(value: Int32Array, index: number): number {
  return value[index] ?? Number.NaN;
}

/**
 * The catalog `torqueNm` is the joint's actuator-force clamp. MuJoCo
 * clips `qfrc_actuator` to `jnt_actfrcrange` after the actuator range,
 * and the URDF `effort` placeholder is wider than the SG90's clamp.
 * Armature, frictionloss, and viscous damping come from the part
 * catalog and replace the URDF values on the driven joint.
 */
function applyServoDynamics(mj: MainModule, model: MjModel, plan: BodyScene) {
  const armature = model.dof_armature as Float64Array;
  const friction = model.dof_frictionloss as Float64Array;
  const damping = model.dof_damping as Float64Array;
  const dofadr = model.jnt_dofadr as Int32Array;
  const trnid = model.actuator_trnid as Int32Array;
  const actuatorType = mj.mjtObj.mjOBJ_ACTUATOR.value;
  for (const part of plan.parts) {
    if (!part.drives) continue;
    const motor = part.motor;
    if (!motor) continue;
    const actId = mj.mj_name2id(model, actuatorType, part.id);
    if (actId < 0) continue;
    const jointId = trnid[actId * 2] ?? -1;
    if (jointId < 0) continue;
    const dof = dofadr[jointId] ?? -1;
    if (dof < 0) continue;
    armature[dof] = motor.armature;
    friction[dof] = motor.frictionloss;
    damping[dof] = motor.damping;
  }
}

/**
 * The catalog `torqueNm` is the joint's actuator-force clamp. MuJoCo
 * clips `qfrc_actuator` to `jnt_actfrcrange` after the actuator range,
 * and the URDF `effort` placeholder is wider than the SG90's clamp.
 */
function applyServoTorqueClamp(
  mj: MainModule,
  model: MjModel,
  plan: BodyScene
) {
  const range = model.jnt_actfrcrange as Float64Array;
  const trnid = model.actuator_trnid as Int32Array;
  const actuatorType = mj.mjtObj.mjOBJ_ACTUATOR.value;
  for (const part of plan.parts) {
    if (!part.drives) continue;
    const torque = part.torqueNm;
    if (torque === undefined || !(torque > 0)) continue;
    const actId = mj.mj_name2id(model, actuatorType, part.id);
    if (actId < 0) continue;
    const jointId = trnid[actId * 2] ?? -1;
    if (jointId < 0) continue;
    range[jointId * 2] = -torque;
    range[jointId * 2 + 1] = torque;
  }
}

/**
 * A negative time constant is MuJoCo's direct stiffness form and is
 * kept. Zero and any smaller positive value are not a stable time
 * constant at this timestep, so they become `minTimeconst` (2× timestep).
 */
export function clampSolrefTimeconst(
  timeconst: number,
  minTimeconst: number
): number {
  if (timeconst < 0) return timeconst;
  if (!(timeconst >= minTimeconst)) return minTimeconst;
  return timeconst;
}

/** The joint's own `<mujoco>` element, attributes and children. */
function mujocoRegion(body: string): string | null {
  const paired = /<mujoco\b([^>]*)>([\s\S]*?)<\/mujoco>/i.exec(body);
  if (paired) return `${paired[1] ?? ""} ${paired[2] ?? ""}`;
  const empty = /<mujoco\b([^>]*)\/>/i.exec(body);
  return empty?.[1] ?? null;
}

/**
 * `solreflimit` inside a joint's own `<mujoco>` element. An attribute
 * elsewhere in the joint is ignored. MuJoCo's URDF compiler does not
 * read this. Keys are URDF joint names.
 */
export function urdfSolrefLimits(xml: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const jointRe = /<joint\b([^>]*)>([\s\S]*?)<\/joint>/gi;
  for (const match of stripped.matchAll(jointRe)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const name = /(?:^|\s)name\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const region = mujocoRegion(body);
    const sol = region
      ? /solreflimit\s*=\s*"([^"]+)"/i.exec(region)?.[1]
      : undefined;
    if (!name || !sol) continue;
    const nums = sol.trim().split(/\s+/).map(Number);
    const timeconst = nums[0];
    const dampratio = nums[1];
    if (
      timeconst === undefined ||
      dampratio === undefined ||
      !Number.isFinite(timeconst) ||
      !Number.isFinite(dampratio)
    ) {
      continue;
    }
    out.set(name, [timeconst, dampratio]);
  }
  return out;
}

function urdfLimitSolref(
  plan: BodyScene,
  files: BodyBytes
): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const robot of plan.robots) {
    const raw = files.read(robot.urdf);
    if (!raw) continue;
    for (const [name, pair] of urdfSolrefLimits(decode(raw))) {
      out.set(`${robot.id}/${name}`, pair);
    }
  }
  return out;
}

/** Stiffen limited joints. An authored URDF `solreflimit` wins. */
function applyLimitSolref(
  mj: MainModule,
  model: MjModel,
  authored: Map<string, [number, number]>
) {
  const solref = model.jnt_solref as Float64Array;
  const limits = model.jnt_range as Float64Array;
  const stride = model.njnt > 0 ? solref.length / model.njnt : 0;
  if (stride < 2) return;
  const jointType = mj.mjtObj.mjOBJ_JOINT.value;
  // Fixed at the 1 ms step, not the run's: a finer step must not stiffen an
  // authored limit, or the law would change with the step. Every allowed
  // step is at most 1 ms, so this stays at least twice it.
  const minTimeconst = 2 * TIMESTEP_S;
  for (let joint = 0; joint < model.njnt; joint++) {
    const lower = limits[joint * 2] ?? 0;
    const upper = limits[joint * 2 + 1] ?? 0;
    if (!(upper > lower)) continue;
    const base = joint * stride;
    const name = mj.mj_id2name(model, jointType, joint) ?? "";
    const fromUrdf = authored.get(name);
    if (fromUrdf) {
      solref[base] = clampSolrefTimeconst(fromUrdf[0], minTimeconst);
      solref[base + 1] = fromUrdf[1];
      continue;
    }
    const timeconst = solref[base] ?? 0;
    const dampratio = solref[base + 1] ?? 0;
    if (
      Math.abs(timeconst - MUJOCO_LIMIT_SOLREF[0]) > 1e-9 ||
      Math.abs(dampratio - MUJOCO_LIMIT_SOLREF[1]) > 1e-9
    ) {
      continue;
    }
    solref[base] = JOINT_LIMIT_SOLREF[0];
    solref[base + 1] = JOINT_LIMIT_SOLREF[1];
  }
}

function addBuffer(vfs: MjVFS, name: string, bytes: Uint8Array) {
  vfs.addBuffer(name, Array.from(bytes));
}

function forceCompiler(spec: MjSpec) {
  spec.compiler.fusestatic = false;
  spec.compiler.discardvisual = false;
}

/**
 * Validate `doc`, then compile one MuJoCo model: ground, primitives, and
 * each robot attached at its pose. A part that drives a joint gets a
 * motor actuator named with the part id. The step loop writes the torque.
 */
export async function compileWorld(
  plan: BodyScene,
  files: BodyBytes
): Promise<CompiledWorld | CompileFailure> {
  const worldDoc = plan;
  const mj = await mujoco();
  const vfs = new mj.MjVFS();
  const robotSpecs: MjSpec[] = [];
  let world: MjSpec | null = null;
  let model: MjModel | null = null;
  let returned = false;
  const release = (obj: { delete: () => void } | null) => {
    if (!obj) return;
    try {
      obj.delete();
    } catch {
      /* already freed */
    }
  };
  try {
    for (const robot of worldDoc.robots) {
      const raw = files.read(robot.urdf);
      if (!raw) {
        return {
          ok: false,
          errors: [
            schemaError(
              `URDF "${robot.urdf}" disappeared while the model was building.`
            ),
          ],
        };
      }
      const prepared = ensureMujocoCompiler(decode(raw));
      const retargeted = retargetMeshes(prepared, robot.id);
      for (const mesh of retargeted.meshes) {
        const format = meshFormatProblem(mesh.written);
        if (format) {
          return {
            ok: false,
            errors: [{ code: "mesh-format", path: "", message: format }],
          };
        }
        const rel = resolveUrdfMesh(robot.urdf, mesh.written);
        const bytes = rel ? files.read(rel) : null;
        if (!bytes) {
          return {
            ok: false,
            errors: [
              {
                code: "missing-file",
                path: "",
                message: `Mesh "${mesh.written}" does not exist. Hint: the path is relative to the URDF.`,
              },
            ],
          };
        }
        addBuffer(vfs, mesh.vfs, bytes);
      }
      const spec = mj.parseXMLString(retargeted.xml, vfs);
      // Register before the parse-error return so `finally` frees it.
      robotSpecs.push(spec);
      const parseError = mj.mjs_getError(spec);
      if (parseError) return { ok: false, errors: [schemaError(parseError)] };
      forceCompiler(spec);
    }

    const scene = mj.parseXMLString(worldXml(worldDoc));
    world = scene;
    const worldError = mj.mjs_getError(scene);
    if (worldError) return { ok: false, errors: [schemaError(worldError)] };
    forceCompiler(scene);
    scene.option.timestep = worldDoc.timestep ?? TIMESTEP_S;
    scene.option.integrator = mj.mjtIntegrator.mjINT_IMPLICITFAST
      .value as unknown as typeof scene.option.integrator;

    worldDoc.robots.forEach((robot, i) => {
      const spec = robotSpecs[i];
      if (!spec) return;
      const mount = mj.mjs_findBody(scene, `pose_${robot.id}`);
      if (!mount) {
        throw new Error(`mount for ${robot.id} is missing`);
      }
      const attached = mj.mjs_attach(
        mount.element,
        spec.element,
        `${robot.id}/`,
        ""
      );
      if (!attached) {
        throw new Error(
          mj.mjs_getError(scene) || `could not attach ${robot.id}`
        );
      }
    });

    for (const part of worldDoc.parts) {
      if (!part.drives || !part.motor) continue;
      const defaults = mj.mjs_getSpecDefault(scene);
      if (!defaults) throw new Error("MuJoCo spec has no default");
      const actuator = mj.mjs_addActuator(world, defaults);
      if (!actuator) {
        throw new Error(mj.mjs_getError(scene) || "could not add an actuator");
      }
      mj.mjs_setName(actuator.element, part.id);
      actuator.trntype = mj.mjtTrn.mjTRN_JOINT
        .value as unknown as typeof actuator.trntype;
      actuator.target = `${part.drives.robot}/${part.drives.joint}`;
      // Torque command. The motor law in the step loop is the controller.
      // ctrl is not clipped to the joint range: a 180° command may push
      // into the stop, and the catalog torque is the force clamp.
      const setErr = mj.mjs_setToMotor(actuator);
      if (setErr) throw new Error(setErr);
      const torque = part.torqueNm;
      if (torque !== undefined && torque > 0) {
        actuator.forcelimited = mj.mjtLimited.mjLIMITED_TRUE
          .value as unknown as typeof actuator.forcelimited;
        const range = actuator.forcerange as Float64Array;
        range[0] = -torque;
        range[1] = torque;
      }
    }

    try {
      model = mj.mj_compile(scene, vfs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errors: [schemaError(message)] };
    }
    if (!model) {
      return {
        ok: false,
        errors: [schemaError(mj.mjs_getError(scene) || "mj_compile failed")],
      };
    }
    // URDF `effort` becomes `jnt_actfrcrange` and that clamp is wider than
    // the catalog torque. A servo joint uses the catalog torque, armature,
    // frictionloss, and damping instead.
    applyServoTorqueClamp(mj, model, worldDoc);
    applyServoDynamics(mj, model, worldDoc);
    applyLimitSolref(mj, model, urdfLimitSolref(worldDoc, files));
    // Rays test group 0. With a ranger in the run, only targets and
    // static primitives stay there. Robots and the ground move to
    // group 1. A world with no ranger keeps every geom in the default group.
    if ((worldDoc.rangers?.length ?? 0) > 0) {
      const geomModel = model;
      const groups = geomModel.geom_group as Uint8Array;
      for (let i = 0; i < geomModel.ngeom; i++) groups[i] = 1;
      const geomType = mj.mjtObj.mjOBJ_GEOM.value;
      const show = (name: string) => {
        const id = mj.mj_name2id(geomModel, geomType, name);
        if (id >= 0) groups[id] = 0;
      };
      for (const target of worldDoc.environment.targets) {
        show(`${WORLD_TARGET_ROBOT}/${target.id}`);
      }
      for (const primitive of worldDoc.environment.primitives ?? []) {
        show(primitive.id);
      }
    }

    const bodyType = mj.mjtObj.mjOBJ_BODY.value;
    const jointType = mj.mjtObj.mjOBJ_JOINT.value;
    const actuatorType = mj.mjtObj.mjOBJ_ACTUATOR.value;
    const meshType = mj.mjtObj.mjOBJ_MESH.value;
    const geomType = mj.mjtObj.mjOBJ_GEOM.value;
    const index: WorldModelIndex = {
      nbody: model.nbody,
      njnt: model.njnt,
      nu: model.nu,
      nmesh: model.nmesh,
      bodyNames: namesOf(mj, model, model.nbody, bodyType),
      jointNames: namesOf(mj, model, model.njnt, jointType),
      actuatorNames: namesOf(mj, model, model.nu, actuatorType),
      meshNames: namesOf(mj, model, model.nmesh, meshType),
      geomNames: namesOf(mj, model, model.ngeom, geomType),
      links: {},
      joints: {},
      parts: {},
      linkNames: {},
      jointNamesByRobot: {},
      targets: [],
    };

    for (const robot of worldDoc.robots) {
      const raw = files.read(robot.urdf);
      if (!raw) continue;
      const info = extractUrdfJointsAndMeshes(decode(raw));
      const links: Record<string, number> = {};
      const linkMj: Record<string, string> = {};
      for (const link of info.links) {
        const mjName = `${robot.id}/${link}`;
        const id = mj.mj_name2id(model, bodyType, mjName);
        if (id < 0) {
          return {
            ok: false,
            errors: [
              schemaError(
                `Robot "${robot.id}" has no body for link "${link}" after compile.`
              ),
            ],
          };
        }
        links[link] = id;
        linkMj[link] = mjName;
      }
      index.links[robot.id] = links;
      index.linkNames[robot.id] = linkMj;

      const joints: Record<string, number> = {};
      const jointMj: Record<string, string> = {};
      for (const joint of info.joints) {
        const mjName = `${robot.id}/${joint}`;
        const id = mj.mj_name2id(model, jointType, mjName);
        if (id < 0) {
          return {
            ok: false,
            errors: [
              schemaError(
                `Robot "${robot.id}" has no joint "${joint}" after compile.`
              ),
            ],
          };
        }
        const qpos = readNum(model.jnt_qposadr as Int32Array, id);
        if (!Number.isFinite(qpos)) {
          return {
            ok: false,
            errors: [schemaError(`Joint "${joint}" has no qpos address.`)],
          };
        }
        joints[joint] = qpos;
        jointMj[joint] = mjName;
      }
      index.joints[robot.id] = joints;
      index.jointNamesByRobot[robot.id] = jointMj;
    }

    const mocapOf = model.body_mocapid as Int32Array;
    const targetLinks: Record<string, number> = {};
    const targetNames: Record<string, string> = {};
    for (const target of worldDoc.environment.targets) {
      const mjName = `${WORLD_TARGET_ROBOT}/${target.id}`;
      const id = mj.mj_name2id(model, bodyType, mjName);
      const mocap = id >= 0 ? (mocapOf[id] ?? -1) : -1;
      if (id < 0 || mocap < 0) {
        return {
          ok: false,
          errors: [
            schemaError(
              `Target "${target.id}" did not compile as a mocap body.`
            ),
          ],
        };
      }
      index.targets.push({ id: target.id, body: id, mocap });
      targetLinks[target.id] = id;
      targetNames[target.id] = mjName;
    }
    if (worldDoc.environment.targets.length > 0) {
      index.links[WORLD_TARGET_ROBOT] = targetLinks;
      index.linkNames[WORLD_TARGET_ROBOT] = targetNames;
    }

    for (const part of worldDoc.parts) {
      if (!part.drives) continue;
      const id = mj.mj_name2id(model, actuatorType, part.id);
      if (id < 0) {
        return {
          ok: false,
          errors: [schemaError(`Part "${part.id}" has no actuator.`)],
        };
      }
      index.parts[part.id] = id;
    }

    for (const spec of robotSpecs) release(spec);
    robotSpecs.length = 0;
    release(world);
    world = null;
    returned = true;
    return { ok: true, mj, model, vfs, index };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [schemaError(message)] };
  } finally {
    if (!returned) {
      release(model);
      release(world);
      for (const spec of robotSpecs) release(spec);
      release(vfs);
    }
  }
}
