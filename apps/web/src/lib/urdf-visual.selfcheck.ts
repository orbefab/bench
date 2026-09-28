import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUrdfMesh } from "@sfab-bench/contract";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

import { parseUrdfVisuals } from "./urdf-visual";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const near = (got: number, want: number, eps = 1e-6) =>
  Math.abs(got - want) <= eps;

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const urdfPath = resolve(root, "examples/arm/robot/arm.urdf");
const xml = readFileSync(urdfPath, "utf8");
const visuals = parseUrdfVisuals(xml);

expect(
  visuals.length === 2,
  `arm has two visual meshes, got ${visuals.length}`
);

const base = visuals.find((visual) => visual.link === "base");
const arm = visuals.find((visual) => visual.link === "upper_arm");
expect(Boolean(base && arm), "base and upper_arm visuals");
if (!base || !arm) throw new Error("missing visual");

expect(
  base.kind === "mesh" && base.filename === "meshes/base.stl",
  "base mesh path"
);
expect(
  arm.kind === "mesh" && arm.filename === "meshes/upper_arm.stl",
  "upper arm mesh path"
);
expect(
  base.xyz.every((n, i) => n === [0, 0, 0][i]) &&
    base.rpy.every((n) => n === 0),
  "base origin is identity"
);
expect(
  base.kind === "mesh" && base.scale.every((n) => near(n, 0.001)),
  `base scale is millimetres, got ${base.kind === "mesh" ? base.scale.join(" ") : base.kind}`
);

const collision = visuals.filter(
  (visual) => visual.kind === "mesh" && visual.filename.includes("box")
);
expect(collision.length === 0, "collision geometry is not a visual");

const sample = `
<robot name="sample">
  <!-- <mesh filename="hidden.stl"/> -->
  <link name="base">
    <inertial><origin xyz="9 9 9" rpy="1 1 1"/></inertial>
    <visual>
      <origin xyz="0.1 0.2 0.3" rpy="0.4 0.5 0.6"/>
      <geometry>
        <mesh filename="meshes/a.obj" scale="2 3 4"/>
        <mesh filename="meshes/b.stl"/>
      </geometry>
    </visual>
    <collision>
      <geometry><mesh filename="meshes/skip.stl"/></geometry>
    </collision>
  </link>
  <link name="empty">
    <visual>
      <origin xyz="0.01 0.02 0.03" rpy="0.1 0.2 0.3"/>
      <geometry>
        <box size="1 2 3"/>
        <mesh filename="meshes/with-box.stl"/>
      </geometry>
    </visual>
    <visual>
      <origin xyz="0.2 0 0" rpy="0 0 0.4"/>
      <geometry>
        <cylinder radius="0.01" length="0.04"/>
        <sphere radius="0.02"/>
      </geometry>
    </visual>
    <collision>
      <origin xyz="8 8 8"/>
      <geometry><box size="9 9 9"/></geometry>
    </collision>
  </link>
</robot>
`;
const parsed = parseUrdfVisuals(sample);
expect(
  parsed.length === 6,
  `two meshes, a box beside a mesh, a cylinder, and a sphere, got ${parsed.length}`
);
expect(
  parsed[0]?.kind === "mesh" && parsed[0].filename === "meshes/a.obj",
  "obj filename"
);
expect(parsed[0]?.xyz.join(" ") === "0.1 0.2 0.3", "origin xyz");
expect(parsed[0]?.rpy.join(" ") === "0.4 0.5 0.6", "origin rpy");
expect(
  parsed[0].kind === "mesh" && parsed[0].scale.join(" ") === "2 3 4",
  "mesh scale"
);
expect(
  parsed[1]?.kind === "mesh" && parsed[1].scale.join(" ") === "1 1 1",
  "missing scale is 1"
);
expect(parsed[1]?.link === "base", "second mesh stays on the link");
const drawn = parsed.find((visual) => visual.kind === "box");
expect(
  drawn?.kind === "box" &&
    drawn.link === "empty" &&
    drawn.size.join(" ") === "1 2 3" &&
    drawn.xyz.join(" ") === "0.01 0.02 0.03" &&
    drawn.rpy.join(" ") === "0.1 0.2 0.3",
  `drawn box ${drawn ? JSON.stringify(drawn) : "missing"}`
);
const beside = parsed.find(
  (visual) => visual.kind === "mesh" && visual.link === "empty"
);
expect(
  beside?.kind === "mesh" && beside.filename === "meshes/with-box.stl",
  "a mesh beside a box is drawn too"
);
const cylinder = parsed.find((visual) => visual.kind === "cylinder");
expect(
  cylinder?.kind === "cylinder" &&
    cylinder.radius === 0.01 &&
    cylinder.length === 0.04 &&
    cylinder.xyz.join(" ") === "0.2 0 0",
  "cylinder radius, length, and origin"
);
const sphere = parsed.find((visual) => visual.kind === "sphere");
expect(
  sphere?.kind === "sphere" && sphere.radius === 0.02 && sphere.rpy[2] === 0.4,
  "sphere radius and origin"
);
expect(
  parsed.every((visual) => visual.kind !== "box" || visual.size[0] !== 9),
  "a collision box is dropped"
);
expect(
  parsed.every(
    (visual) => visual.kind !== "mesh" || visual.filename !== "meshes/skip.stl"
  ),
  "collision mesh is dropped"
);
expect(
  parsed.every(
    (visual) => visual.kind !== "mesh" || visual.filename !== "hidden.stl"
  ),
  "a comment is not a mesh"
);
console.log(
  `drawn box: size [${drawn && drawn.kind === "box" ? drawn.size.join(", ") : ""}] origin [${drawn ? drawn.xyz.join(", ") : ""}]`
);

const flagXml = readFileSync(
  resolve(root, "examples/nano/robot/flag.urdf"),
  "utf8"
);
const flag = parseUrdfVisuals(flagXml);
expect(
  flag.length === 2,
  `flag draws its two visual boxes, got ${flag.length}`
);
const flagBase = flag.find((visual) => visual.link === "base");
const vane = flag.find((visual) => visual.link === "vane");
expect(
  flagBase?.kind === "box" &&
    flagBase.size.join(" ") === "0.04 0.04 0.02" &&
    flagBase.xyz.join(" ") === "0 0 0.01",
  "flag base box"
);
expect(
  vane?.kind === "box" &&
    vane.size.join(" ") === "0.08 0.02 0.005" &&
    vane.xyz.join(" ") === "0.04 0 0",
  "flag vane box"
);

const mesh = resolveUrdfMesh(
  "examples/arm/robot/arm.urdf",
  base.kind === "mesh" ? base.filename : ""
);
expect(
  mesh === "examples/arm/robot/meshes/base.stl",
  `mesh joins onto the URDF directory, got ${mesh}`
);

const stl = readFileSync(resolve(root, "examples/arm/robot/meshes/base.stl"));
const geo = new STLLoader().parse(
  stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength)
);
geo.computeBoundingBox();
const box = geo.boundingBox;
expect(Boolean(box), "base STL has a box");
if (box && base.kind === "mesh") {
  const height = (box.max.z - box.min.z) * base.scale[2];
  expect(
    near(height, 0.02, 1e-3),
    `base visual is 20mm tall after scale, got ${height}`
  );
  expect(
    near(box.min.z * base.scale[2], 0, 1e-3),
    `base mesh sits on z=0, min z is ${box.min.z}`
  );
}

console.log("urdf-visual.selfcheck ok");
