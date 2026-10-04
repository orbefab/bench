/**
 * Procedural visuals: the resistor code, colours, every builder inside its
 * box, the box fallback, inner forms at their offsets, and that the
 * builder map is keyed by form ids only.
 */
import { ok as expect } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  boardTexture,
  buildVisual,
  colorOf,
  disposeVisual,
  FORM_BUILDERS,
  resistorBands,
  type Vec3,
} from "./visual-forms";

const bands = (ohms: number) => resistorBands(ohms)?.join(" ") ?? "none";
expect(bands(220) === "red red brown gold", `220 Ω ${bands(220)}`);
expect(bands(1000) === "brown black red gold", `1 kΩ ${bands(1000)}`);
expect(bands(10_000) === "brown black orange gold", `10 kΩ ${bands(10_000)}`);
expect(bands(4.7) === "yellow violet gold gold", `4.7 Ω ${bands(4.7)}`);
expect(bands(0.47) === "yellow violet silver gold", `0.47 Ω ${bands(0.47)}`);
expect(bands(999) === "brown black red gold", `999 Ω rounds to 1 kΩ`);
expect(bands(0) === "none" && bands(Number.NaN) === "none", "no code");
expect(colorOf("red") === "#e53935", "named colour");
expect(colorOf("#12AB34") === "#12AB34", "hex colour");
expect(colorOf("plaid", "#000000") === "#000000", "unknown colour");
const blue = boardTexture("#1d6fa5");
expect(
  blue === boardTexture("#1d6fa5") && blue !== boardTexture("#1f6f43"),
  "board textures are cached by colour"
);

const fallback = new THREE.MeshStandardMaterial();

function bounds(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

function within(box: THREE.Box3, size: Vec3, slack: Vec3): boolean {
  // Geometry is float32.
  const eps = 1e-6;
  return (
    box.min.x >= -size[0] / 2 - slack[0] - eps &&
    box.max.x <= size[0] / 2 + slack[0] + eps &&
    box.min.y >= -size[1] / 2 - slack[1] - eps &&
    box.max.y <= size[1] / 2 + slack[1] + eps &&
    box.min.z >= -size[2] / 2 - slack[2] - eps &&
    box.max.z <= size[2] / 2 + slack[2] + eps
  );
}

// Each builder, with the params the catalog gives it, stays in its box
// (a case's tabs stand out by `flange` on x, a board's USB connector by a
// tenth of its width).
const samples: Record<
  string,
  { size: Vec3; params: Record<string, number | string>; slack?: Vec3 }
> = {
  "case@1": {
    size: [0.023, 0.0122, 0.029],
    params: { flange: 0.0047, boss: 0.0059, bossX: -0.0055, color: "blue" },
    slack: [0.0047, 0, 0],
  },
  "can@1": { size: [0.02, 0.012, 0.01], params: { axis: "x" } },
  "gear@1": { size: [0.012, 0.012, 0.002], params: { teeth: 30 } },
  "disc@1": { size: [0.008, 0.008, 0.003], params: {} },
  "die@1": { size: [0.006, 0.004, 0.0012], params: { pins: 4 } },
  "axial@1": { size: [0.006, 0.002, 0.002], params: { ohms: 220 } },
  "lens@1": { size: [0.01, 0.005, 0.008], params: { board: "#1f6f43" } },
  "pcb@1": {
    size: [0.0686, 0.0534, 0.012],
    params: { usb: "-x" },
    slack: [0.0012, 0, 0],
  },
};
for (const id of Object.keys(FORM_BUILDERS)) {
  const sample = samples[id];
  expect(sample, `a sample for ${id}`);
  const group = buildVisual(
    sample.size,
    { form: id, params: sample.params },
    fallback
  );
  let meshes = 0;
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) meshes++;
  });
  expect(meshes >= 1, `${id} draws ${meshes} meshes`);
  const box = bounds(group);
  expect(
    within(box, sample.size, sample.slack ?? [0, 0, 0]),
    `${id} stays in its box: ${JSON.stringify([box.min, box.max])}`
  );
  disposeVisual(group, fallback);
}

// The axial form carries one band mesh per colour: 220 Ω adds four.
const count = (params: Record<string, number>) => {
  let n = 0;
  buildVisual(
    [0.006, 0.002, 0.002],
    { form: "axial@1", params },
    fallback
  ).traverse((node) => {
    if (node instanceof THREE.Mesh) n++;
  });
  return n;
};
expect(count({ ohms: 220 }) === count({}) + 4, "bands from ohms");

// No form, or a form with no builder: the box in the scene's material.
for (const form of [undefined, { form: "nope@9", params: {} }]) {
  const group = buildVisual([0.01, 0.02, 0.03], form, fallback);
  const only = group.children[0];
  expect(
    group.children.length === 1 &&
      only instanceof THREE.Mesh &&
      only.material === fallback,
    `fallback box for ${form?.form ?? "no form"}`
  );
  const size = bounds(group).getSize(new THREE.Vector3());
  expect(
    Math.abs(size.x - 0.01) < 1e-9 && Math.abs(size.z - 0.03) < 1e-9,
    "the fallback box has the part's size"
  );
}

// Inner forms sit at their offsets inside the case.
const servo = buildVisual(
  [0.023, 0.0122, 0.029],
  {
    form: "case@1",
    params: { opacity: 0.3 },
    inner: [
      {
        form: "can@1",
        size: [0.012, 0.01, 0.01],
        at: [0.004, 0, -0.008],
        params: {},
      },
      {
        form: "nope@9",
        size: [0.002, 0.002, 0.002],
        at: [-0.005, 0, 0],
        params: {},
      },
    ],
  },
  fallback
);
const canBox = bounds(servo.children.at(-2) ?? servo);
expect(
  Math.abs((canBox.min.x + canBox.max.x) / 2 - 0.004) < 1e-9 &&
    Math.abs((canBox.min.z + canBox.max.z) / 2 + 0.008) < 1e-6,
  `inner can at its offset ${JSON.stringify(canBox)}`
);
expect(
  servo.children.at(-1)?.position.x === -0.005,
  "an inner form with no builder is a box at its offset"
);

// Keyed by form ids only: every key is `<name>@<n>`, and no catalog part
// type id names a builder.
const here = dirname(fileURLToPath(import.meta.url));
const catalog = join(here, "../../../server/catalog");
const types = new Set<string>();
for (const file of readdirSync(join(catalog, "types"), { recursive: true })) {
  const name = String(file);
  if (!name.endsWith(".json")) continue;
  const doc = JSON.parse(readFileSync(join(catalog, "types", name), "utf8"));
  if (typeof doc.id === "string") types.add(doc.id);
}
expect(types.size > 10, `read ${types.size} catalog types`);
for (const id of Object.keys(FORM_BUILDERS)) {
  expect(/^[a-z][a-z0-9-]*@\d+$/.test(id), `form id ${id}`);
  expect(
    !types.has(id) && !types.has(id.split("@")[0] ?? ""),
    `${id} is not a type`
  );
}

console.log(
  `visual forms: ${Object.keys(FORM_BUILDERS).length} builders in their boxes, 220 Ω red red brown, fallback box, inner at offset, no type ids`
);
console.log("visual-forms.selfcheck ok");
