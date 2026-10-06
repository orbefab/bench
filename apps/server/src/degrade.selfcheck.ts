/**
 * A broken part does not stop the run. The healthy board matches the
 * same world with the broken parts removed.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RecordingRead } from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { createRailCircuit } from "@sfab-bench/sim/rail-circuit";
import { Sim } from "@sfab-bench/sim/sim";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { planWorld } from "./world/plan";
import { nodePlanEnv } from "./world/plan-host";

const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function scene(id: string, instances: string, wires: string): string {
  return `{
    "format": "sfab.part@1",
    "id": "sfab/${id}@1.0.0",
    "type": "assembly",
    "foreign": false,
    "axes": {
      "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
        "kind": "composite", "omits": ["degraded scene"],
        "netlist": { "instances": { ${instances} }, "wires": [ ${wires} ], "expose": {} }
      } } } },
      "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } },
      "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } }
    }
  }`;
}

const goodNano = `"good": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/blink/blink.hex", "source": "firmware/blink/blink.ino" } }`;
const goodUsb = `"usb": { "part": "sfab/usb-port-500ma@1.0.0" }`;
const goodWires = `["usb.5V", "good.5V"], ["usb.GND", "good.GND"]`;

function writeScene(
  dir: string,
  id: string,
  body: string,
  levels: string,
  name: string
): void {
  mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
  writeFileSync(join(dir, "parts", "sfab", `${id}@1.0.0.json`), body);
  writeFileSync(
    join(dir, `${name}.world.json`),
    `{
      "version": 2,
      "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
      "run": { "seed": 1, "levels": { ${levels} } },
      "root": { "id": "scene", "part": "sfab/${id}@1.0.0" }
    }`
  );
}

/** A part with no body and no visual, under the project's `parts/`. */
function writePart(
  dir: string,
  part: { id: string; type: string; behaviour: Record<string, unknown> }
): void {
  const none = {
    "0": {
      default: "none",
      variants: { none: { kind: "none", omits: ["none"] } },
    },
  };
  const [publisher, file] = part.id.split("/");
  mkdirSync(join(dir, "parts", publisher ?? ""), { recursive: true });
  writeFileSync(
    join(dir, "parts", publisher ?? "", `${file}.json`),
    JSON.stringify({
      format: "sfab.part@1",
      id: part.id,
      type: part.type,
      foreign: false,
      axes: { behaviour: part.behaviour, body: none, visual: none },
    })
  );
}

async function runWorld(
  dir: string,
  world: string,
  ms: number
): Promise<{
  serial: string;
  leds: number[];
  degraded: string[];
  codes: Map<string, string>;
}> {
  const sim = new Sim({
    post() {},
    now: () => performance.now(),
    schedule: (fn, delay) => setTimeout(fn, delay),
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
    const loaded = await sim.load({ project: dir, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((item) => item.message).join("; "));
    }
    const state = sim.state();
    const degraded = (state?.diagnostics ?? []).map(
      (row) => `degraded ${row.path}: ${row.message}`
    );
    const codes = new Map(
      (state?.diagnostics ?? []).map((row) => [row.path, row.code])
    );
    await sim.step(ms);
    const settled = sim.state();
    if (!settled) throw new Error("no state");
    const body = sim.record({ op: "read", from: 0, to: settled.simTime });
    if (body.op !== "read") throw new Error("no recording");
    const read = body.read as RecordingRead;
    const leds = read.frames.map(
      (frame) => frame.boards.good?.leds?.["good.led"] ?? Number.NaN
    );
    const serial = sim
      .drainSerial()
      .map((chunk) => (chunk.board === "good" ? chunk.text : ""))
      .join("");
    return { serial, leds, degraded, codes };
  } finally {
    sim.dispose();
  }
}

const dir = mkdtempSync(join(tmpdir(), "sfab-degrade-"));
try {
  cpSync(join(nanoExample, "firmware"), join(dir, "firmware"), {
    recursive: true,
  });
  writeFileSync(join(dir, "broken.world.json"), "{ not json");
  const broken = planWorld(dir, "broken.world.json");
  expect(!broken.ok, "a non-JSON world planned");
  if (broken.ok) throw new Error("unreachable");
  expect(
    broken.errors[0]?.message ===
      "World file is not JSON. Hint: a world is a root part, parts/<publisher>/<name>@<version>.json.",
    broken.errors.map((item) => item.message).join("; ")
  );
  console.log(broken.errors[0]?.message);

  const mixed = scene(
    "mixed-scene",
    [
      goodUsb,
      goodNano,
      `"usb2": { "part": "sfab/usb-port-500ma@1.0.0" }`,
      `"badhex": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "no-such.hex", "source": "firmware/blink/blink.ino" } }`,
      `"bench": { "part": "sfab/bench-supply@1.0.0", "params": { "V": 9, "Ilimit": 2 } }`,
      `"vin": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/hold/hold.hex", "source": "firmware/hold/hold.ino" } }`,
      `"pack": { "part": "sfab/battery-2s-lipo@1.0.0", "params": { "vCutoff": "nope" } }`,
      `"servo": { "part": "sfab/sg90@1.0.0" }`,
      `"badlint": { "part": "sfab/bad-rating@1.0.0" }`,
      `"ghost": { "part": "sfab/no-such@1.0.0" }`,
      `"nobo": { "part": "sfab/no-brownout@1.0.0", "params": { "firmware": "firmware/blink/blink.hex" } }`,
      `"nor": { "part": "sfab/no-r@1.0.0" }`,
      `"levels": { "part": "sfab/odd-levels@1.0.0" }`,
    ].join(", "),
    [
      goodWires,
      `["usb2.5V", "badhex.5V"], ["usb2.GND", "badhex.GND"]`,
      `["bench.5V", "vin.VIN"], ["bench.GND", "vin.GND"]`,
    ].join(", ")
  );
  writeScene(
    dir,
    "mixed-scene",
    mixed,
    `"default": 2, "paths": { "vin": { "behaviour": 1 }, "servo": { "behaviour": 1 } }`,
    "mixed"
  );
  writeFileSync(
    join(dir, "parts", "sfab", "bad-rating@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/bad-rating@1.0.0",
      type: "resistor",
      foreign: false,
      ratings: { NOPE: { voltage: [0, 5] } },
      axes: {
        behaviour: {
          "1": {
            default: "ohmic",
            variants: {
              ohmic: {
                kind: "form",
                form: "resistor@1",
                params: { R: 1000 },
                omits: ["tolerance"],
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["none"] } },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["none"] } },
          },
        },
      },
    })
  );
  writePart(dir, {
    id: "sfab/no-brownout@1.0.0",
    type: "arduino-nano",
    behaviour: {
      "1": {
        default: "avr",
        variants: {
          avr: {
            kind: "firmware",
            chip: "atmega328p",
            imageParam: "firmware",
            resetPort: "RESET",
            railVoltage: 5,
            resetFraction: 0.9,
            params: { quiescent: 0.01, rpu: 35000 },
            omits: ["test"],
          },
        },
      },
    },
  });
  writePart(dir, {
    id: "sfab/no-r@1.0.0",
    type: "resistor",
    behaviour: {
      "1": {
        default: "ohmic",
        variants: {
          ohmic: {
            kind: "form",
            form: "resistor@1",
            params: {},
            omits: ["tolerance"],
          },
        },
      },
    },
  });
  const divider = (expose: Record<string, string>) => ({
    kind: "composite",
    omits: ["test"],
    netlist: {
      instances: {
        r1: { part: "sfab/resistor@1.0.0" },
        r2: { part: "sfab/resistor@1.0.0" },
      },
      wires: [["r1.B", "r2.A"]],
      expose,
    },
  });
  writePart(dir, {
    id: "sfab/odd-levels@1.0.0",
    type: "potentiometer",
    behaviour: {
      "1": {
        default: "one",
        variants: { one: divider({ A: "r1.A", B: "r2.B" }) },
      },
      "2": {
        default: "two",
        variants: { two: divider({ A: "r1.A", W: "r2.A" }) },
      },
    },
  });
  writeScene(
    dir,
    "healthy-scene",
    scene("healthy-scene", [goodUsb, goodNano].join(", "), goodWires),
    `"default": 2`,
    "healthy"
  );

  const planned = planWorld(dir, "mixed.world.json");
  expect(planned.ok, "mixed world did not plan");
  if (!planned.ok) throw new Error("unreachable");
  const power = planned.plan.report?.levels.find(
    (row) => row.path === "vin.power" && row.axis === "behaviour"
  );
  expect(power?.class === 2, `vin.power class ${power?.class}`);
  expect(power?.reason === "nearest runnable level", power?.reason ?? "");
  expect(power?.source === "fallback", power?.source ?? "");

  const healthy = await runWorld(dir, "healthy.world.json", 400);
  const full = await runWorld(dir, "mixed.world.json", 400);
  expect(full.serial === healthy.serial, "healthy serial moved");
  expect(
    JSON.stringify(full.leds) === JSON.stringify(healthy.leds),
    `healthy D13 moved ${full.leds.length} ${healthy.leds.length}`
  );
  expect(
    full.leds.some((amps) => amps > 0.001),
    "D13 did not blink on"
  );
  expect(
    full.leds.some((amps) => amps < 0.0001),
    "D13 did not blink off"
  );
  for (const line of full.degraded) console.log(line);
  // Each row keeps the code of what went wrong; nothing reads the message.
  const want: Record<string, string> = {
    badhex: "missing-file",
    ghost: "missing-file",
    pack: "bad-params",
    nor: "bad-params",
    nobo: "unsupported",
  };
  for (const [path, code] of Object.entries(want)) {
    expect(
      full.codes.get(path) === code,
      `${path} code ${full.codes.get(path)}, want ${code}`
    );
  }
  const nobo = (planned.plan.degraded ?? []).find((row) => row.path === "nobo");
  expect(
    nobo?.message ===
      'chip "atmega328p" lacks brownoutVoltage, brownoutAssertVoltage, brownoutReleaseVoltage, resetHoldS, roh, rol, rLeak',
    `nobo: ${nobo?.message}`
  );
  const ports = (planned.plan.report?.warnings ?? []).filter(
    (row) => row.code === "level-ports"
  );
  expect(
    ports.length === 1 && ports[0]?.path === "sfab/odd-levels@1.0.0",
    `level-ports ${ports.map((row) => row.message).join("; ")}`
  );
  console.log(`warning ${ports[0]?.message}`);
  console.log(
    `healthy nano: serial and D13 byte-identical to the world without the broken parts, ${full.leds.length} frames`
  );

  const ideal = createRailCircuit({
    vNom: 5,
    rSeries: 0,
    iLimit: 0,
    motors: [],
    ideal: true,
  });
  ideal.setFixed(0.02);
  ideal.solve();
  expect(
    Math.abs(ideal.voltage - 5) < 1e-9 && Math.abs(ideal.current - 0.02) < 1e-9,
    `ideal source ${ideal.voltage} V ${ideal.current} A`
  );
  console.log(
    `ideal-voltage@1: 5.000000 V, 0.020000 A, an ideal source on the rail`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
