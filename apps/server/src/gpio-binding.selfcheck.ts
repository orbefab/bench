/**
 * A part's logic ports bind to board GPIO through the resolved nets
 * (layered-sim M3a). The gauge world runs as shipped, with its sensor
 * renamed to sort before the board, and inside one and two transparent
 * shells. Each records the same echoes. A trigger whose net reaches two
 * board pins is not bound, and the plan names the port.
 */
import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { headlessSim } from "./run";
import { planWorld } from "./world/plan";

const gaugeDir = fileURLToPath(
  new URL("../../../examples/gauge/", import.meta.url)
);
const WORLD = "parts/sfab/gauge-usb@1.0.0.json";
const SCENE = "parts/sfab/gauge-scene@1.0.0.json";
const MS = 3000;

type Json = Record<string, unknown>;

/** A transparent shell of the ranger type around `inner`. */
function shellPart(id: string, inner: string): Json {
  return {
    format: "sfab.part@1",
    id,
    type: "ultrasonic-ranger-4pin",
    axes: {
      behaviour: {
        "1": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: [],
              netlist: {
                instances: { inner: { part: inner } },
                wires: [],
                expose: {
                  VCC: "inner.VCC",
                  GND: "inner.GND",
                  Trig: "inner.Trig",
                  Echo: "inner.Echo",
                },
              },
            },
          },
        },
      },
      body: {
        "0": {
          default: "none",
          variants: { none: { kind: "none", omits: [] } },
        },
      },
      visual: {
        "0": {
          default: "none",
          variants: { none: { kind: "none", omits: [] } },
        },
      },
    },
  };
}

type Variant = {
  /** The ranger's instance path in the run. */
  path: string;
  edit(root: string): void;
};

function sceneEdit(root: string, edit: (text: string) => string): void {
  const file = join(root, SCENE);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

function renamed(name: string, part?: string): (text: string) => string {
  return (text) => {
    const next = text
      .replaceAll('"sensor":', `"${name}":`)
      .replaceAll('"sensor.', `"${name}.`);
    return part ? next.replace('"sfab/hc-sr04@1.0.0"', `"${part}"`) : next;
  };
}

function writeShell(root: string, id: string, inner: string): void {
  const [publisher, file] = id.split("/");
  writeFileSync(
    join(root, "parts", publisher ?? "", `${file}.json`),
    `${JSON.stringify(shellPart(id, inner), null, 2)}\n`
  );
}

const VARIANTS: Record<string, Variant> = {
  shipped: { path: "sensor", edit: () => {} },
  renamed: {
    path: "aaa",
    edit: (root) => sceneEdit(root, renamed("aaa")),
  },
  shell: {
    path: "zzz.inner",
    edit: (root) => {
      writeShell(root, "sfab/ranger-shell@1.0.0", "sfab/hc-sr04@1.0.0");
      sceneEdit(root, renamed("zzz", "sfab/ranger-shell@1.0.0"));
    },
  },
  "two shells": {
    path: "aaa.inner.inner",
    edit: (root) => {
      writeShell(root, "sfab/ranger-shell@1.0.0", "sfab/hc-sr04@1.0.0");
      writeShell(root, "sfab/ranger-shell2@1.0.0", "sfab/ranger-shell@1.0.0");
      sceneEdit(root, renamed("aaa", "sfab/ranger-shell2@1.0.0"));
    },
  },
};

/** JSON with sorted keys and the ranger's path as `sensor`. */
function canonical(value: unknown, path: string): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .map((key) => [key === path ? "sensor" : key, key] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, key]) => [name, sort((item as Json)[key])])
      );
    }
    return item === path ? "sensor" : item;
  };
  return JSON.stringify(sort(value));
}

function copyGauge(base: string, name: string): string {
  const root = join(base, name.replace(" ", "-"));
  cpSync(gaugeDir, root, { recursive: true });
  // The edits change the scene's hash; no copy keeps a lock.
  rmSync(join(root, "parts", "sfab", "gauge-usb@1.0.0.lock.json"));
  return root;
}

async function record(
  root: string,
  path: string
): Promise<{ frames: string; echoes: number; warnings: string[] }> {
  const sim = headlessSim();
  try {
    const loaded = await sim.load({
      project: root,
      world: WORLD,
      generation: 1,
    });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    await sim.step(MS);
    const read = sim.record({ op: "read", from: 0, to: MS / 1000 });
    if (read.op !== "read") throw new Error("no recording");
    const frames = read.read.frames;
    return {
      frames: canonical(frames, path),
      echoes: frames.filter((frame) => frame.parts[path]?.echoS != null).length,
      warnings: (sim.report()?.warnings ?? []).map((row) => row.message),
    };
  } finally {
    sim.dispose();
  }
}

const base = mkdtempSync(join(tmpdir(), "sfab-gpio-binding-"));
try {
  const runs: Record<string, Awaited<ReturnType<typeof record>>> = {};
  for (const [name, variant] of Object.entries(VARIANTS)) {
    const root = copyGauge(base, name);
    variant.edit(root);
    const planned = planWorld(root, WORLD);
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    const ranger = planned.plan.rangers?.find(
      (item) => item.id === variant.path
    );
    expect(ranger, `${name}: no ranger at ${variant.path}`);
    expect(
      ranger.trig?.boardId === "nano" && ranger.echo?.boardId === "nano",
      `${name}: trig ${JSON.stringify(ranger.trig)} echo ${JSON.stringify(ranger.echo)}`
    );
    runs[name] = await record(root, variant.path);
  }
  const shipped = runs.shipped;
  if (!shipped) throw new Error("unreachable");
  expect(shipped.echoes > 0, "the shipped gauge records no echo");
  for (const [name, run] of Object.entries(runs)) {
    expect(
      run.echoes === shipped.echoes,
      `${name}: ${run.echoes} echo frames vs ${shipped.echoes}`
    );
    expect(
      run.frames === shipped.frames,
      `${name}: the recording differs from the shipped gauge`
    );
    expect(
      run.warnings.length === 0,
      `${name}: warnings ${run.warnings.join("; ")}`
    );
  }

  // A second board pin on the trigger's net: not bound, and named.
  const both = copyGauge(base, "two pins");
  sceneEdit(both, (text) =>
    text.replace(
      '["nano.D7", "sensor.Trig"],',
      '["nano.D7", "sensor.Trig"],\n                ["nano.D9", "sensor.Trig"],'
    )
  );
  const planned = planWorld(both, WORLD);
  if (!planned.ok) {
    throw new Error(planned.errors.map((row) => row.message).join("; "));
  }
  const ranger = planned.plan.rangers?.find((item) => item.id === "sensor");
  expect(
    ranger?.trig === null && ranger.echo?.boardId === "nano",
    `two pins: trig ${JSON.stringify(ranger?.trig)}`
  );
  const row = planned.plan.degraded?.find(
    (item) => item.path === "sensor" && item.port === "Trig"
  );
  expect(
    row?.code === "wiring" &&
      row.message.includes("Trig reaches 2 board pins (nano.D7, nano.D9)"),
    `two pins: ${JSON.stringify(planned.plan.degraded)}`
  );

  console.log(
    `gpio binding: shipped, renamed, one and two shells record the same ${MS} ms (${shipped.echoes} echo frames); two board pins on Trig: unbound, "${row.message}"`
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log("gpio-binding.selfcheck ok");
