/**
 * Circuit engine, pin element, and ADC (ADR 0010).
 * Traces are ngspice, stored under fixtures/circuit. Nothing here is timed
 * except the INFO lines.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AVERAGED_DUTY,
  adcReading,
  capacitor,
  classifyNet,
  DEFAULT_PIN_LEVEL,
  EDGE_EXACT,
  Engine,
  inductor,
  iSource,
  LED_RED,
  ladder,
  PIN_ROH,
  PIN_ROL,
  PIN_RPU,
  PIN_RPU_MAX,
  PIN_RPU_MIN,
  Pin,
  POT_ALPHAS,
  POT_RAILS,
  type PwmSample,
  potDivider,
  resistor,
  type Sample,
  SS14,
  simulatePinPwm,
  sw,
  TRACE_CASES,
  vSource,
} from "./world/circuit";
import { nanoTraceStimulus } from "./world/circuit-stamp";
import { nanoD13Deck, nanoUsbDeck } from "./world/nano-reference";

const LINE = 0.005;
const POWER_W = 1e-9;
const fixtureDir = fileURLToPath(
  new URL("../fixtures/circuit/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function pct(frac: number): string {
  return `${(frac * 100).toFixed(4)}%`;
}

function interp(
  time: readonly number[],
  values: readonly number[],
  t: number
): number {
  const n = time.length;
  const t0 = time[0]!;
  const tN = time[n - 1]!;
  if (t <= t0) return values[0]!;
  if (t >= tN) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = time[lo]!;
  const b = time[hi]!;
  const u = b === a ? 0 : (t - a) / (b - a);
  return values[lo]! * (1 - u) + values[hi]! * u;
}

/** Max |ours − ref| / span(ref). */
function rangeError(ours: readonly number[], ref: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  let worst = 0;
  for (let i = 0; i < ref.length; i++) {
    const y = ref[i]!;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    worst = Math.max(worst, Math.abs(ours[i]! - y));
  }
  return worst / Math.max(hi - lo, 1e-12);
}

function loadCsv(name: string): { t: number[]; v: number[] } {
  const text = readFileSync(join(fixtureDir, name), "utf8");
  const t: number[] = [];
  const v: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("t,")) {
      continue;
    }
    const [ts, vs] = trimmed.split(",");
    t.push(Number(ts));
    v.push(Number(vs));
  }
  expect(t.length > 1 && t.length <= 2100, `${name} has ${t.length} points`);
  return { t, v };
}

type PotRow = {
  alpha: number;
  rSrc: number;
  vWiper: number;
  vRail: number;
};

function loadPot(name: string): PotRow[] {
  const raw = JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as {
    rows: PotRow[];
  };
  return raw.rows;
}

function windowMean(
  samples: readonly PwmSample[],
  t0: number,
  t1: number
): number {
  const at = (t: number): number => {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    if (t <= first.t) return first.v;
    if (t >= last.t) return last.v;
    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = samples[lo]!;
    const b = samples[hi]!;
    const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    return a.v + u * (b.v - a.v);
  };
  const mid = samples.filter((s) => s.t > t0 && s.t < t1);
  const pts = [{ t: t0, v: at(t0) }, ...mid, { t: t1, v: at(t1) }];
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.t - pts[i - 1]!.t;
    area += 0.5 * (pts[i]!.v + pts[i - 1]!.v) * dt;
  }
  return area / (t1 - t0);
}

let powerWorst = 0;
function notePower(samples: readonly Sample[]): void {
  for (const s of samples) {
    powerWorst = Math.max(powerWorst, Math.abs(s.power.residual));
  }
}

for (const spec of TRACE_CASES) {
  const trace = loadCsv(`${spec.id}.csv`);
  const eng = new Engine(spec.elements(), { method: "be", h: spec.h });
  const samples = eng.run(spec.steps, [spec.probe]);
  notePower(samples);
  const ours = trace.t.map((t) =>
    interp(
      samples.map((s) => s.t),
      samples.map((s) => s.v[spec.probe] ?? 0),
      t
    )
  );
  const err = rangeError(ours, trace.v);
  expect(err <= LINE, `${spec.id} ${pct(err)} of span exceeds 0.5%`);
  console.log(`circuit ${spec.id}: ${pct(err)} of span`);
}

for (const kind of ["usb", "d13"] as const) {
  const id = kind === "usb" ? "nano-usb" : "nano-d13";
  const h = 2e-8;
  const steps = 150000;
  const trace = loadCsv(`${id}.csv`);
  const reference =
    kind === "usb" ? nanoUsbDeck(SS14, LED_RED) : nanoD13Deck(SS14, LED_RED);
  const refProbe = kind === "usb" ? "v5" : "d13";
  const net = nanoTraceStimulus(kind);
  for (const [label, elements, probe] of [
    ["reference", reference, refProbe],
    ["netlist", net.elements, net.probe],
  ] as const) {
    const eng = new Engine(elements, { method: "be", h });
    const samples = eng.run(steps, [probe]);
    notePower(samples);
    const ours = trace.t.map((t) =>
      interp(
        samples.map((s) => s.t),
        samples.map((s) => s.v[probe] ?? 0),
        t
      )
    );
    const err = rangeError(ours, trace.v);
    expect(
      err <= LINE,
      `circuit ${id} ${label} ${pct(err)} of span exceeds 0.5%`
    );
    console.log(`circuit ${id} ${label}: ${pct(err)} of span`);
  }
}

{
  const eng = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 5 }),
      resistor("r1", "in", "mid", 1e3),
      resistor("r2", "mid", "0", 1e3),
    ],
    { method: "be", h: 1e-5 }
  );
  const tr = eng.run(5, ["mid"]);
  notePower(tr);
  const mid = tr[tr.length - 1]!.v.mid!;
  expect(Math.abs(mid - 2.5) <= 1e-9, `divider ${mid}`);
  console.log("circuit divider analytic: 2.5 V");
}

{
  const R = 1e3;
  const C = 1e-6;
  const h = 1e-4;
  const steps = 50;
  const eng = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", R),
      capacitor("c", "out", "0", C),
    ],
    { method: "be", h }
  );
  const tr = eng.run(steps, ["out"]);
  notePower(tr);
  const a = 1 / (1 + h / (R * C));
  let worst = 0;
  for (let n = 0; n <= steps; n++) {
    const exact = n === 0 ? 0 : 1 - a ** n;
    worst = Math.max(worst, Math.abs(tr[n]!.v.out! - exact));
  }
  expect(worst <= 1e-9, `rc closed form ${worst}`);
  console.log(`circuit rc closed form: ${worst.toExponential(2)} V`);
}

{
  const R = 10;
  const L = 1e-3;
  const h = 1e-6;
  const steps = 500;
  const eng = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", R),
      inductor("l", "out", "0", L),
    ],
    { method: "be", h }
  );
  const tr = eng.run(steps, ["out"]);
  notePower(tr);
  let prev = 0;
  let discrete = 0;
  const g = L / h;
  for (let n = 1; n <= steps; n++) {
    prev = (1 + g * prev) / (R + g);
    discrete = Math.max(discrete, Math.abs(tr[n]!.i.l! - prev));
  }
  const t = steps * h;
  const continuous = (1 / R) * (1 - Math.exp((-t * R) / L));
  const contErr = Math.abs(tr[steps]!.i.l! - continuous);
  expect(discrete <= 1e-9, `rl discrete ${discrete}`);
  expect(contErr <= 2e-4, `rl continuous ${contErr}`);
  console.log(
    `circuit rl: discrete ${discrete.toExponential(2)} A, continuous ${contErr.toExponential(2)} A`
  );
}

{
  const eng = new Engine(
    [
      iSource("i", "out", "0", { kind: "dc", value: 0.01 }),
      resistor("r", "out", "0", 1e3),
    ],
    { method: "be", h: 1e-4 }
  );
  const tr = eng.run(1, ["out"]);
  notePower(tr);
  expect(
    Math.abs(tr[0]!.v.out! + 10) <= 1e-8,
    `current source ${tr[0]!.v.out}`
  );
  console.log("circuit current-source sign: -10 V");
}

{
  const R = 1e3;
  const C = 1e-6;
  const h = 1e-4;
  const eng = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", R),
      capacitor("c", "out", "0", C),
    ],
    { method: "trap", h, uic: true }
  );
  eng.stepTo(h);
  const expectV = 1 / (1 + (2 * R * C) / h);
  const err = Math.abs(eng.voltage("out") - expectV);
  expect(err <= 1e-9, `trapezoidal ${err}`);
  console.log(`circuit trapezoidal rc: ${err.toExponential(2)} V`);
}

expect(powerWorst <= POWER_W, `power balance ${powerWorst} W`);
console.log(`circuit power balance: ${powerWorst.toExponential(2)} W`);

{
  expect(PIN_RPU_MIN === 20e3 && PIN_RPU_MAX === 50e3, "RPU range");
  expect(PIN_RPU === 35e3, "RPU midpoint");
  const rail = 3.3;
  const load = 1e3;

  const high = new Pin("h", "pin", "rail");
  high.setMode("high");
  const highEng = new Engine(
    [
      vSource("v", "rail", "0", { kind: "dc", value: rail }),
      ...high.elements(),
      resistor("r", "pin", "0", load),
    ],
    { method: "be", h: 1e-4 }
  );
  const vHigh = highEng.run(1, ["pin"])[0]!.v.pin!;
  expect(
    Math.abs(vHigh - (rail * load) / (PIN_ROH + load)) <= 1e-6,
    `pin high ${vHigh}`
  );

  const low = new Pin("l", "pin", "rail");
  low.setMode("low");
  const lowEng = new Engine(
    [
      vSource("v", "rail", "0", { kind: "dc", value: rail }),
      ...low.elements(),
      resistor("r", "rail", "pin", load),
    ],
    { method: "be", h: 1e-4 }
  );
  const vLow = lowEng.run(1, ["pin"])[0]!.v.pin!;
  expect(
    Math.abs(vLow - (rail * PIN_ROL) / (load + PIN_ROL)) <= 1e-6,
    `pin low ${vLow}`
  );

  const input = new Pin("z", "pin", "rail");
  input.setMode("input");
  const inputEng = new Engine(
    [
      vSource("v", "src", "0", { kind: "dc", value: rail }),
      ...input.elements(),
      resistor("r", "src", "pin", load),
    ],
    { method: "be", h: 1e-4 }
  );
  const vIn = inputEng.run(1, ["pin"])[0]!.v.pin!;
  expect(Math.abs(vIn - rail) <= 1e-6, `pin input ${vIn}`);

  const pu = new Pin("pu", "pin", "rail");
  pu.setMode("pullup");
  const puEng = new Engine(
    [
      vSource("v", "rail", "0", { kind: "dc", value: rail }),
      ...pu.elements(),
      resistor("r", "pin", "0", PIN_RPU),
    ],
    { method: "be", h: 1e-4 }
  );
  const vPu = puEng.run(1, ["pin"])[0]!.v.pin!;
  expect(Math.abs(vPu - rail / 2) <= 1e-6, `pin pullup ${vPu}`);
  console.log("circuit pin modes: high, low, input, pull-up");
}

{
  const pin = new Pin("d9", "pin", "rail");
  pin.setMode("low");
  const eng = new Engine(
    [
      vSource("v", "rail", "0", { kind: "dc", value: 5 }),
      ...pin.elements(),
      resistor("r", "pin", "out", 10e3),
      capacitor("c", "out", "0", 1e-6),
    ],
    { method: "be", h: 10e-6, uic: true }
  );
  const tEdge = 50e-6;
  eng.stepTo(tEdge);
  expect(eng.t === tEdge, `stepTo landed at ${eng.t}`);
  const before = eng.voltage("out");
  pin.setMode("high");
  eng.stepTo(tEdge + 10e-6);
  expect(eng.t === tEdge + 10e-6, `step after edge ${eng.t}`);
  expect(eng.voltage("out") > before, "edge changed the capacitor");

  const h = 1e-4;
  const steps = 10;
  const fixed = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", 1e3),
      capacitor("c", "out", "0", 1e-6),
    ],
    { method: "be", h }
  ).run(steps, ["out"]);
  const sub = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", 1e3),
      capacitor("c", "out", "0", 1e-6),
    ],
    { method: "be", h }
  );
  sub.advanceTo(steps * h);
  expect(sub.t === fixed[steps]!.t, "sub-step time");
  expect(
    Math.abs(sub.voltage("out") - fixed[steps]!.v.out!) <= 1e-12,
    "sub-step voltage"
  );
  console.log("circuit stepTo: edge at 50 µs; sub-steps match the fixed grid");
}

{
  expect(DEFAULT_PIN_LEVEL === EDGE_EXACT, "default level");
  expect(EDGE_EXACT.omits.length === 0, "edge omits");
  expect(
    AVERAGED_DUTY.omits.length === 1 && AVERAGED_DUTY.omits[0] === "ripple",
    "ripple"
  );
  let worst = 0;
  for (const duty of [0.5, 0.2]) {
    const common = {
      duty,
      period: 1 / 490,
      rail: 5,
      rSeries: 10e3,
      c: 1e-6,
      tStop: 0.08,
      h: 10e-6,
    };
    const edge = simulatePinPwm({ ...common, level: "edge" });
    const averaged = simulatePinPwm({ ...common, level: "averaged" });
    const me = windowMean(edge, 0.06, 0.08);
    const ma = windowMean(averaged, 0.06, 0.08);
    worst = Math.max(worst, Math.abs(ma - me) / Math.max(Math.abs(me), 1e-12));
  }
  expect(worst <= 0.002, `averaged duty ${pct(worst)}`);
  console.log(
    `circuit averaged duty: ${pct(worst)} of edge-exact; omits ripple`
  );
}

expect(classifyNet(["logic", "logic"]) === "digital", "logic net");
expect(classifyNet(["logic", "ground"]) === "analog", "ground forces analog");
expect(classifyNet(["power"]) === "analog", "power");
expect(classifyNet(["analog"]) === "analog", "analog port");
expect(classifyNet(["ground"], "digital") === "digital", "force digital");
expect(classifyNet(["logic"], "analog") === "analog", "force analog");
console.log("circuit nets: ground forces analog; a force wins");

for (const rail of POT_RAILS) {
  const tag = rail.toFixed(1).replace(".", "");
  const rows = loadPot(`pot-adc-${tag}.json`);
  expect(rows.length === POT_ALPHAS.length, `pot ${rail} rows`);
  let worst = 0;
  for (const row of rows) {
    const built = potDivider(row.alpha, rail);
    const sample = new Engine(built.elements, { method: "be", h: 1e-5 }).run(
      1,
      ["wiper", "rail"]
    )[0]!;
    const ours = adcReading(sample.v.wiper!, sample.v.rail!, built.rSrc, 12e-6);
    const ref = adcReading(row.vWiper, row.vRail, row.rSrc, 12e-6);
    worst = Math.max(worst, Math.abs(ours - ref));
  }
  expect(worst === 0, `adc ${rail} V off by ${worst} LSB`);
  console.log(`circuit adc ${rail.toFixed(1)} V: ${worst} LSB`);
}

{
  const canon = (samples: readonly Sample[]): string => JSON.stringify(samples);
  const a = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", 1e3),
      capacitor("c", "out", "0", 1e-6),
    ],
    { method: "be", h: 1e-6 }
  ).run(500, ["out"]);
  const b = new Engine(
    [
      vSource("vs", "in", "0", { kind: "step", t0: 0, v0: 0, v1: 1 }),
      resistor("r", "in", "out", 1e3),
      capacitor("c", "out", "0", 1e-6),
    ],
    { method: "be", h: 1e-6 }
  ).run(500, ["out"]);
  expect(canon(a) === canon(b), "two runs differ");
  console.log("circuit determinism: byte-identical");
}

{
  // 33 switches: switch 0 opens and switch 32 closes on the same step. A
  // 32-bit mask saw one key for both states and reused the old factor.
  const t1 = 50e-6;
  const els = [
    vSource("vs", "in", "0", { kind: "dc", value: 1 }),
    sw("s0", "in", "a", 1, 1e9, { kind: "step", t0: t1, v0: 1, v1: 0 }),
    resistor("ra", "a", "0", 1e3),
    sw("s32", "in", "b", 1, 1e9, { kind: "step", t0: t1, v0: 0, v1: 1 }),
    resistor("rb", "b", "0", 1e3),
  ];
  for (let i = 1; i < 32; i++) {
    els.splice(
      i + 1,
      0,
      sw(`s${i}`, "in", `d${i}`, 1, 1e9, { kind: "dc", value: 0 })
    );
    els.push(resistor(`rd${i}`, `d${i}`, "0", 1e3));
  }
  const eng = new Engine(els, { method: "be", h: 1e-6 });
  eng.advanceTo(100e-6);
  const a = eng.voltage("a");
  const b = eng.voltage("b");
  expect(a < 1e-3 && b > 0.99, `33 switches: a ${a} V, b ${b} V`);
  console.log("circuit 33 switches: refactors on a change past bit 31");
}

{
  const eng = new Engine(ladder(50, false), { method: "be", h: 1e-6 });
  eng.advanceTo(1e-3);
  expect(eng.factorCount <= 2, `advanceTo factored ${eng.factorCount} times`);
  console.log(
    `circuit advanceTo reuses the factor: ${eng.factorCount} over 1000 steps`
  );
}

{
  const linearUs = new Engine(ladder(50, false), {
    method: "be",
    h: 1e-6,
  }).bench(40, 15);
  console.log(`INFO linear 50 nodes: ${linearUs.toFixed(2)} µs/step`);
  const diodeUs = new Engine(ladder(50, true), { method: "be", h: 1e-6 }).bench(
    40,
    15
  );
  console.log(`INFO diodes 50 nodes (10%): ${diodeUs.toFixed(2)} µs/step`);
}
