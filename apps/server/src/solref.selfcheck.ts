import {
  clampSolrefTimeconst,
  urdfSolrefLimits,
} from "@sfab-bench/engine-body";

/**
 * A negative solreflimit time constant stays negative. Zero and a
 * positive value under 2× timestep become 0.002. The attribute counts
 * only inside that joint's `<mujoco>` element.
 */

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const minTimeconst = 0.002;
expect(clampSolrefTimeconst(-1, minTimeconst) === -1, "negative was clamped");
expect(clampSolrefTimeconst(0, minTimeconst) === 0.002, "zero stayed zero");
expect(
  clampSolrefTimeconst(0.001, minTimeconst) === 0.002,
  "sub-timestep positive was kept"
);
expect(
  clampSolrefTimeconst(0.01, minTimeconst) === 0.01,
  "authored 0.01 was clamped"
);
expect(
  clampSolrefTimeconst(0.002, minTimeconst) === 0.002,
  "exactly 2× timestep moved"
);

function pair(xml: string, name: string): [number, number] | undefined {
  return urdfSolrefLimits(xml).get(name);
}

const negative = pair(
  `<joint name="elbow"><mujoco><joint solreflimit="-1 0.5"/></mujoco></joint>`,
  "elbow"
);
expect(
  negative?.[0] === -1 && negative[1] === 0.5,
  `negative parse ${negative}`
);

const zero = pair(
  `<joint name="elbow"><mujoco solreflimit="0 1"></mujoco></joint>`,
  "elbow"
);
expect(zero?.[0] === 0 && zero[1] === 1, `zero parse ${zero}`);

const outside = pair(
  `<joint name="elbow"><dynamics solreflimit="0.05 1"/><mujoco></mujoco></joint>`,
  "elbow"
);
expect(outside === undefined, `outside mujoco was read ${outside}`);

const inner = pair(
  `<joint name="elbow" solreflimit="0.05 1"><origin solreflimit="9 1"/><mujoco><joint solreflimit="0.01 1"/></mujoco></joint>`,
  "elbow"
);
expect(inner?.[0] === 0.01 && inner[1] === 1, `inner solreflimit was ${inner}`);

const absent = pair(
  `<joint name="elbow"><dynamics solreflimit="0.05 1"/></joint>`,
  "elbow"
);
expect(absent === undefined, "a joint without mujoco contributed a solref");

console.log("solref.selfcheck ok");
