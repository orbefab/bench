// L2 face over one MuJoCo hinge or gear train. The compiler stays in model.ts.

import type { MainModule, MjData, MjModel, MjSpec } from "@mujoco/mujoco";
import type { Engine, GearTrain } from "@sfab-bench/contract";
import { type CollapsedHinge, collapse } from "./gear-train";
import { gearTrainXml, hingeXml } from "./mjcf";

const STEP_S = 0.001;

export type BodyEngineSpec =
  | {
      kind: "hinge";
      armature: number;
      damping: number;
      frictionloss: number;
      loadInertia: number;
      /** Joint name. Default `output`. */
      joint?: string;
    }
  | {
      kind: "gear-train";
      train: GearTrain;
      loadInertia: number;
    };

type Live = {
  mj: MainModule;
  model: MjModel;
  data: MjData;
  spec: MjSpec;
  joint: string;
  qadr: number;
  vadr: number;
};

/**
 * One hinge on the master clock. `write(joint, "torque", N·m)` then
 * `advance`. `read` returns `position` in radians and `velocity` in rad/s.
 */
export class BodyEngine implements Engine {
  readonly id: string;
  private live: Live | null = null;
  private step = 0;
  private torque = 0;

  constructor(id = "body") {
    this.id = id;
  }

  async init(spec: unknown): Promise<void> {
    const parsed = bodySpec(spec);
    const hinge: CollapsedHinge =
      parsed.kind === "hinge"
        ? {
            armature: parsed.armature,
            damping: parsed.damping,
            frictionloss: parsed.frictionloss,
            ratio: 1,
          }
        : collapse(parsed.train);
    const joint =
      parsed.kind === "hinge"
        ? (parsed.joint ?? "output")
        : parsed.train.output;
    const xml =
      parsed.kind === "hinge"
        ? hingeXml(hinge, parsed.loadInertia, STEP_S)
        : gearTrainXml(parsed.train, parsed.loadInertia, STEP_S);
    const mj = await mujoco();
    const compiled = mj.parseXMLString(xml);
    const parseError = mj.mjs_getError(compiled);
    if (parseError) {
      compiled.delete?.();
      throw new Error(parseError);
    }
    const model = mj.mj_compile(compiled);
    const data = new mj.MjData(model);
    const jid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, joint);
    const qadr = jid >= 0 ? ((model.jnt_qposadr as Int32Array)[jid] ?? -1) : -1;
    const vadr = jid >= 0 ? ((model.jnt_dofadr as Int32Array)[jid] ?? -1) : -1;
    if (jid < 0 || qadr < 0 || vadr < 0) {
      data.delete?.();
      model.delete?.();
      compiled.delete?.();
      throw new Error(`joint ${joint} is missing`);
    }
    this.live = { mj, model, data, spec: compiled, joint, qadr, vadr };
    this.step = 0;
    this.torque = 0;
  }

  advance(toSeconds: number): void {
    const live = this.need();
    const target = Math.round(toSeconds / STEP_S);
    const applied = live.data.qfrc_applied as Float64Array;
    while (this.step < target) {
      applied[live.vadr] = this.torque;
      live.mj.mj_step(live.model, live.data);
      this.step += 1;
    }
  }

  read(port: string, quantity: string): number {
    const live = this.need();
    if (port !== live.joint) throw new Error(`body engine has no port ${port}`);
    if (quantity === "position") {
      return (live.data.qpos as Float64Array)[live.qadr] ?? 0;
    }
    if (quantity === "velocity") {
      return (live.data.qvel as Float64Array)[live.vadr] ?? 0;
    }
    throw new Error(`body engine has no quantity ${quantity}`);
  }

  write(port: string, quantity: string, value: number): void {
    const live = this.need();
    if (port !== live.joint || quantity !== "torque") {
      throw new Error(`body engine cannot write ${port}.${quantity}`);
    }
    this.torque = value;
  }

  dispose(): void {
    const live = this.live;
    this.live = null;
    live?.data.delete?.();
    live?.model.delete?.();
    live?.spec.delete?.();
  }

  private need(): Live {
    if (!this.live) throw new Error("body engine is not initialised");
    return this.live;
  }
}

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

function bodySpec(spec: unknown): BodyEngineSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error("body engine spec is missing");
  }
  const row = spec as BodyEngineSpec;
  if (row.kind !== "hinge" && row.kind !== "gear-train") {
    throw new Error("body engine spec kind is missing");
  }
  return row;
}
