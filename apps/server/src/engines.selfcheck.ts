/**
 * Each L2 engine through the Engine face alone. Each line names a
 * number an existing self-check already prints.
 */
import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine, FixtureFile, GearTrain } from "@sfab-bench/contract";
import { BodyEngine, collapse } from "@sfab-bench/engine-body";
import { CircuitEngine } from "@sfab-bench/engine-circuit";
import { McuEngine, parseIntelHex } from "@sfab-bench/engine-mcu";
import { loadTypeById, logicThresholds } from "@sfab-bench/parts";
import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const STEP = 0.001;

{
  const circuit: Engine = new CircuitEngine();
  circuit.init({
    h: 1e-5,
    method: "be",
    supply: { volts: 5, node: "in" },
    loads: [
      { ohms: 1e3, from: "in", to: "mid" },
      { ohms: 1e3, from: "mid", to: "0" },
    ],
  });
  circuit.advance(5e-5);
  const mid = circuit.read("mid", "voltage");
  expect(Math.abs(mid - 2.5) <= 1e-9, `divider ${mid}`);
  circuit.dispose();
  console.log("engine circuit: mid 2.5 V (circuit divider analytic: 2.5 V)");
}

{
  const holdPath = fileURLToPath(
    new URL("../../../examples/nano/firmware/hold/hold.hex", import.meta.url)
  );
  const parsed = parseIntelHex(readFileSync(holdPath, "utf8"));
  expect(parsed.ok, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) throw new Error("unreachable");
  const mcu: Engine = new McuEngine();
  const pins = [
    ...Array.from({ length: 14 }, (_, n) => `D${n}`),
    ...Array.from({ length: 6 }, (_, n) => `A${n}`),
  ];
  const wire = [
    ...Array.from({ length: 8 }, (_, n) => `PD${n}`),
    ...Array.from({ length: 6 }, (_, n) => `PB${n}`),
    ...Array.from({ length: 6 }, (_, n) => `PC${n}`),
  ];
  const catalog = catalogRoot();
  const nano = loadTypeById(
    catalog,
    { store: nodeStore, catalogDir: catalog, assetRoot: catalog },
    "arduino-nano"
  );
  if (!("type" in nano)) throw new Error("arduino-nano type did not load");
  mcu.init({
    chip: "atmega328p",
    firmware: parsed.bytes,
    brownoutVoltage: 2.7,
    pins,
    wire,
    edges: (pin: string, supply: number) =>
      logicThresholds(nano.type.ports[pin]?.ratings?.logic, supply),
  });
  mcu.write("supply", "voltage", 5);
  mcu.advance(0.001);
  let line = "";
  for (let i = 0; i < 64; i++) {
    const byte = mcu.read("serial", "tx");
    if (byte < 0) break;
    line += String.fromCharCode(byte);
    if (line.endsWith("\n")) break;
  }
  expect(line === "10\r\n", `first serial line ${JSON.stringify(line)}`);
  const drive = mcu.read("D13", "voltage");
  expect(drive === 0, `D13 ${drive}`);
  // 0.3·VCC / 0.6·VCC at 5 V: 1.5 V and 3.0 V. Between them the level holds.
  const levels = [2.0, 3.5, 2.5, 1.4, 2.5].map((volts) => {
    mcu.write("D2", "voltage", volts);
    return mcu.read("D2", "level");
  });
  expect(
    JSON.stringify(levels) === "[0,1,1,0,0]",
    `D2 levels ${JSON.stringify(levels)}`
  );
  mcu.dispose();
  console.log(
    'engine mcu: first serial line 10 (nano-led serial "10\\r\\n90\\r\\n" first line at 0.001 s)'
  );
  console.log(
    "engine mcu: D2 at 2.0 / 3.5 / 2.5 / 1.4 / 2.5 V reads 0 1 1 0 0 (vil 0.3·VCC, vih 0.6·VCC at 5 V)"
  );
}

{
  const tickPath = fileURLToPath(
    new URL(
      "../../../examples/pro-micro/firmware/blink-serial1/blink-serial1.hex",
      import.meta.url
    )
  );
  const parsed = parseIntelHex(readFileSync(tickPath, "utf8"));
  expect(parsed.ok, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) throw new Error("unreachable");
  const mcu: Engine = new McuEngine("u4");
  mcu.init({
    chip: "atmega32u4",
    firmware: parsed.bytes,
    brownoutVoltage: 2.7,
  });
  mcu.write("supply", "voltage", 5);
  let text = "";
  for (let ms = 1; ms <= 1500 && !text.includes("tick"); ms++) {
    mcu.advance(ms / 1000);
    for (let byte = mcu.read("serial", "tx"); byte >= 0; ) {
      text += String.fromCharCode(byte);
      byte = mcu.read("serial", "tx");
    }
  }
  expect(text.includes("tick"), `32U4 serial ${JSON.stringify(text)}`);
  mcu.dispose();
  console.log(
    "engine mcu: an atmega32u4 prints tick on Serial1 (pro-micro Serial1 ticks)"
  );
}

function signalAt(
  input: FixtureFile["inputs"][number],
  t: number,
  duration: number
): number {
  const amplitude = input.params.amplitude ?? 0;
  if (input.signal === "step") {
    const t0 = input.params.t0 ?? 0;
    const width = input.params.width;
    if (t < t0) return 0;
    if (width !== undefined && t >= t0 + width) return 0;
    return amplitude;
  }
  const f0 = input.params.f0 ?? 0;
  const f1 = input.params.f1 ?? f0;
  const phase =
    2 *
    Math.PI *
    (f0 * t + ((f1 - f0) * t * t) / (2 * Math.max(duration, STEP)));
  return amplitude * Math.sin(phase);
}

async function angles(
  spec: unknown,
  joint: string,
  torque: (t: number) => number,
  steps: number
): Promise<number[]> {
  const engine: Engine = new BodyEngine();
  await engine.init(spec);
  const out: number[] = [];
  for (let k = 0; k < steps; k++) {
    engine.write(joint, "torque", torque(k * STEP));
    engine.advance((k + 1) * STEP);
    out.push(engine.read(joint, "position"));
  }
  engine.dispose();
  return out;
}

const catalog = catalogRoot();
const sg90 = JSON.parse(
  readFileSync(join(catalog, "parts/sfab/sg90@1.0.0.json"), "utf8")
) as {
  axes: { body: { "2": { variants: { "gear-train": GearTrain } } } };
};
const train = sg90.axes.body["2"].variants["gear-train"];
const lumped = collapse(train);
const fixture = JSON.parse(
  readFileSync(join(catalog, "fixtures/sfab/sg90-body.fixture.json"), "utf8")
) as FixtureFile;
const inertias =
  fixture.sweeps.find((row) => row.quantity === "Inertia")?.values ?? [];
expect(inertias.length > 0, "hinge fixture has no inertia sweep");
const steps = Math.round(fixture.duration / STEP);
let maxAbs = 0;
for (const inertia of inertias) {
  for (const input of fixture.inputs) {
    const torque = (t: number) => signalAt(input, t, fixture.duration);
    const deep = await angles(
      { kind: "gear-train", train, loadInertia: inertia },
      train.output,
      torque,
      steps
    );
    const snap = await angles(
      {
        kind: "hinge",
        armature: lumped.armature,
        damping: lumped.damping,
        frictionloss: lumped.frictionloss,
        loadInertia: inertia,
      },
      "output",
      torque,
      steps
    );
    for (let i = 0; i < steps; i++) {
      const err = Math.abs((deep[i] ?? 0) - (snap[i] ?? 0));
      if (err > maxAbs) maxAbs = err;
    }
  }
}
const deg = ((maxAbs * 180) / Math.PI).toFixed(4);
expect(deg === "0.2084", `hinge error ${deg} deg`);
console.log(
  `engine body: hinge angle error ${deg} deg under the fixture torques, including 0.176 N·m (free-run-max-abs ${deg} deg)`
);
