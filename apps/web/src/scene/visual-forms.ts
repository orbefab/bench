/**
 * Procedural part visuals, keyed by visual form id. A part's visual axis
 * names a form and its params; nothing here knows a part type or id.
 * Each builder draws inside the box `size` (x, y, z; z up; centred on the
 * origin), apart from small features such as tabs and leads. A form with
 * no builder draws the box.
 *
 * Every build makes its own materials: the scene tints a selected part's
 * materials in place. Only textures are shared, cached by their params.
 */
import type { WorldViewForm } from "@sfab-bench/contract";
import * as THREE from "three";

export type Vec3 = [number, number, number];
export type FormParams = WorldViewForm["params"];
export type FormInput = { size: Vec3; params: FormParams };
export type FormBuilder = (input: FormInput) => THREE.Group;

const HALF_PI = Math.PI / 2;

function num(params: FormParams, name: string, fallback: number): number {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(params: FormParams, name: string, fallback: string): string {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#1b1b1b",
  brown: "#7b4a26",
  red: "#e53935",
  orange: "#fb8c00",
  yellow: "#fdd835",
  green: "#43a047",
  blue: "#1e88e5",
  violet: "#8e24aa",
  grey: "#9e9e9e",
  white: "#f5f5f5",
  gold: "#c9a227",
  silver: "#c0c4c8",
  amber: "#ffb300",
};

/** A named colour or `#rrggbb`. Anything else is the fallback. */
export function colorOf(value: string, fallback = "#9e9e9e"): string {
  const named = NAMED_COLORS[value.toLowerCase()];
  if (named) return named;
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

const BAND_DIGITS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "grey",
  "white",
] as const;

/**
 * Four-band code for a resistance: two digits, the multiplier, and a gold
 * (5 %) tolerance band. Null when the value has no two-digit code.
 */
export function resistorBands(ohms: number): string[] | null {
  if (!Number.isFinite(ohms) || ohms <= 0) return null;
  let exponent = Math.floor(Math.log10(ohms)) - 1;
  let digits = Math.round(ohms / 10 ** exponent);
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exponent += 1;
  }
  const multiplier =
    exponent === -1
      ? "gold"
      : exponent === -2
        ? "silver"
        : BAND_DIGITS[exponent];
  const first = BAND_DIGITS[Math.floor(digits / 10)];
  const second = BAND_DIGITS[digits % 10];
  if (!multiplier || !first || !second) return null;
  return [first, second, multiplier, "gold"];
}

function material(
  color: string,
  opts: THREE.MeshStandardMaterialParameters = {}
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.08,
    roughness: 0.7,
    ...opts,
  });
}

function mesh(
  geometry: THREE.BufferGeometry,
  mat: THREE.Material,
  at: Vec3 = [0, 0, 0]
): THREE.Mesh {
  const out = new THREE.Mesh(geometry, mat);
  out.position.set(at[0], at[1], at[2]);
  return out;
}

/** A cylinder along z. Three.js builds them along y. */
function cylinderZ(
  radius: number,
  height: number,
  segments = 32
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
  geometry.rotateX(HALF_PI);
  return geometry;
}

/** A cylinder along x. */
function cylinderX(
  radius: number,
  height: number,
  segments = 24
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
  geometry.rotateZ(HALF_PI);
  return geometry;
}

const textureCache = new Map<string, THREE.DataTexture>();

/**
 * A board's surface: white with a sparse grid of darker vias. It is
 * neutral, so the material's colour is the board's colour (the texture
 * multiplies it) and highlights still lerp that colour. One texture is
 * shared by every board.
 */
export function boardTexture(): THREE.DataTexture {
  const key = "board";
  const cached = textureCache.get(key);
  if (cached) return cached;
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const shade = x % 8 === 3 && y % 8 === 5 ? 150 : 255;
      const i = (y * size + x) * 4;
      data[i] = shade;
      data[i + 1] = shade;
      data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  textureCache.set(key, texture);
  return texture;
}

/** True when the texture is shared and must outlive a build. */
export function isCachedTexture(texture: THREE.Texture): boolean {
  for (const cached of textureCache.values()) {
    if (cached === texture) return true;
  }
  return false;
}

/**
 * A case: a body with optional mounting tabs, a round boss on top and an
 * output spline. `bodyZ` is the body's share of the height; the boss and
 * spline fill the rest.
 */
const caseForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const group = new THREE.Group();
  const color = colorOf(text(params, "color", "#2f6db5"));
  const opacity = num(params, "opacity", 1);
  const shell = material(color, {
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const bodyZ = z * Math.min(1, Math.max(0.3, num(params, "bodyZ", 0.78)));
  const bottom = -z / 2;
  group.add(
    mesh(new THREE.BoxGeometry(x, y, bodyZ), shell, [0, 0, bottom + bodyZ / 2])
  );
  const flange = num(params, "flange", 0);
  if (flange > 0) {
    const thick = Math.min(0.0025, bodyZ * 0.15);
    const tabZ = bottom + bodyZ * num(params, "flangeZ", 0.75);
    for (const side of [-1, 1]) {
      group.add(
        mesh(new THREE.BoxGeometry(flange, y, thick), shell, [
          side * (x / 2 + flange / 2),
          0,
          tabZ,
        ])
      );
    }
  }
  const boss = Math.min(num(params, "boss", 0), y / 2);
  const bossX = num(params, "bossX", 0);
  const top = z - bodyZ;
  if (boss > 0 && top > 0) {
    const bossH = top * 0.55;
    group.add(
      mesh(cylinderZ(boss, bossH), shell, [
        bossX,
        0,
        bottom + bodyZ + bossH / 2,
      ])
    );
    const spline = Math.min(num(params, "shaft", boss * 0.4), boss);
    if (spline > 0) {
      const splineH = top - bossH;
      group.add(
        mesh(cylinderZ(spline, splineH, 18), material("#f2f2f2"), [
          bossX,
          0,
          bottom + bodyZ + bossH + splineH / 2,
        ])
      );
    }
  }
  return group;
};

/** A motor can along `axis` (x, y or z) with a darker end cap and a shaft. */
const canForm: FormBuilder = ({ size, params }) => {
  const axis = text(params, "axis", "x");
  const index = axis === "y" ? 1 : axis === "z" ? 2 : 0;
  const length = size[index];
  const others = size.filter((_, i) => i !== index);
  const radius = Math.min(...others) / 2;
  const group = new THREE.Group();
  const bodyLength = length * 0.88;
  const capLength = length * 0.06;
  const shaftLength = length - bodyLength - capLength;
  const parts: [THREE.CylinderGeometry, THREE.Material, number][] = [
    [
      new THREE.CylinderGeometry(radius, radius, bodyLength, 28),
      material(colorOf(text(params, "color", "silver")), {
        metalness: 0.6,
        roughness: 0.35,
      }),
      -length / 2 + bodyLength / 2,
    ],
    [
      new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, capLength, 28),
      material(colorOf(text(params, "cap", "#5f6368"))),
      -length / 2 + bodyLength + capLength / 2,
    ],
    [
      new THREE.CylinderGeometry(
        radius * 0.15,
        radius * 0.15,
        Math.max(shaftLength, 1e-6),
        12
      ),
      material("#d7dadd", { metalness: 0.7, roughness: 0.3 }),
      length / 2 - shaftLength / 2,
    ],
  ];
  for (const [geometry, mat, offset] of parts) {
    // Three.js cylinders run along y; turn them onto the axis.
    if (index === 0) geometry.rotateZ(-HALF_PI);
    if (index === 2) geometry.rotateX(HALF_PI);
    const at: Vec3 = [0, 0, 0];
    at[index] = offset;
    group.add(mesh(geometry, mat, at));
  }
  return group;
};

/** A spur gear about z: `teeth` teeth on the box's inscribed circle. */
const gearForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const outer = Math.min(x, y) / 2;
  const root = outer * 0.84;
  const teeth = Math.max(6, Math.min(80, Math.round(num(params, "teeth", 18))));
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const points: [number, number][] = [
      [root, a],
      [outer, a + step * 0.2],
      [outer, a + step * 0.5],
      [root, a + step * 0.7],
    ];
    points.forEach(([r, angle], j) => {
      const px = r * Math.cos(angle);
      const py = r * Math.sin(angle);
      if (i === 0 && j === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, outer * 0.18, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: z,
    bevelEnabled: false,
    curveSegments: 6,
  });
  geometry.translate(0, 0, -z / 2);
  const group = new THREE.Group();
  group.add(
    mesh(geometry, material(colorOf(text(params, "color", "#f1efe9"))))
  );
  return group;
};

/** A potentiometer disc about z, with a wiper mark on top. */
const discForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const radius = Math.min(x, y) / 2;
  const group = new THREE.Group();
  group.add(
    mesh(
      cylinderZ(radius, z * 0.8),
      material(colorOf(text(params, "color", "#2b2b2b"))),
      [0, 0, -z * 0.1]
    )
  );
  group.add(
    mesh(
      new THREE.BoxGeometry(radius * 1.2, radius * 0.18, z * 0.2),
      material(colorOf(text(params, "mark", "#e8e8e8"))),
      [radius * 0.3, 0, z * 0.4]
    )
  );
  return group;
};

/** A chip package: a dark body, `pins` legs along each long side, a pin-1 dot. */
const dieForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const group = new THREE.Group();
  const bodyY = y * 0.7;
  group.add(
    mesh(
      new THREE.BoxGeometry(x, bodyY, z),
      material(colorOf(text(params, "color", "#1f2328")))
    )
  );
  const pins = Math.max(0, Math.min(40, Math.round(num(params, "pins", 4))));
  if (pins > 0) {
    const leg = material("#c8ccd0", { metalness: 0.7, roughness: 0.3 });
    const pitch = x / pins;
    const legY = (y - bodyY) / 2;
    for (const side of [-1, 1]) {
      for (let i = 0; i < pins; i++) {
        group.add(
          mesh(new THREE.BoxGeometry(pitch * 0.45, legY, z * 0.3), leg, [
            -x / 2 + pitch * (i + 0.5),
            side * (bodyY / 2 + legY / 2),
            -z * 0.25,
          ])
        );
      }
    }
  }
  const dot = Math.min(x, bodyY) * 0.08;
  const dotH = z * 0.04;
  group.add(
    mesh(cylinderZ(dot, dotH, 12), material("#8a8f96"), [
      -x / 2 + dot * 2.5,
      -bodyY / 2 + dot * 2.5,
      z / 2 - dotH / 2 + 1e-7,
    ])
  );
  return group;
};

/**
 * An axial part along x: a body with leads to the box ends. With `ohms`
 * it carries the four-band resistor code.
 */
const axialForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const radius = Math.min(y, z) / 2;
  const bodyLength = x * 0.6;
  const group = new THREE.Group();
  group.add(
    mesh(
      cylinderX(radius * 0.92, bodyLength),
      material(colorOf(text(params, "color", "#d8c39a")))
    )
  );
  const leadLength = (x - bodyLength) / 2;
  const lead = material("#b9bdc2", { metalness: 0.7, roughness: 0.3 });
  for (const side of [-1, 1]) {
    group.add(
      mesh(cylinderX(radius * 0.15, leadLength, 10), lead, [
        side * (bodyLength / 2 + leadLength / 2),
        0,
        0,
      ])
    );
  }
  const bands = resistorBands(num(params, "ohms", Number.NaN));
  if (bands) {
    const at = [-0.3, -0.15, 0, 0.3];
    bands.forEach((band, i) => {
      group.add(
        mesh(cylinderX(radius, bodyLength * 0.07), material(colorOf(band)), [
          (at[i] ?? 0) * bodyLength,
          0,
          0,
        ])
      );
    });
  }
  return group;
};

/**
 * An LED: a rim and a tinted dome along z. With `board` (a colour) it
 * stands on a small board and sits toward the box's +x end.
 */
const lensForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const group = new THREE.Group();
  const tint = colorOf(text(params, "color", "red"), NAMED_COLORS.red);
  const board = text(params, "board", "");
  let floor = -z / 2;
  let centreX = 0;
  let span = Math.min(x, y);
  if (board) {
    const thick = z * 0.15;
    group.add(
      mesh(
        new THREE.BoxGeometry(x, y, thick),
        material(colorOf(board, "#1f6f43"), { map: boardTexture() }),
        [0, 0, floor + thick / 2]
      )
    );
    floor += thick;
    span = Math.min(x / 2, y);
    centreX = x / 4;
  }
  const radius = span / 2;
  const rimH = (z / 2 - floor) * 0.12 + z * 0.02;
  group.add(
    mesh(cylinderZ(radius, rimH), material(tint, { opacity: 0.9 }), [
      centreX,
      0,
      floor + rimH / 2,
    ])
  );
  const lens = material(tint, {
    transparent: true,
    opacity: 0.82,
    roughness: 0.15,
    emissive: new THREE.Color(tint),
    emissiveIntensity: 0.25,
  });
  const dome = radius * 0.88;
  const columnH = Math.max(z / 2 - floor - rimH - dome, 0);
  group.add(
    mesh(cylinderZ(dome, columnH), lens, [
      centreX,
      0,
      floor + rimH + columnH / 2,
    ])
  );
  const cap = new THREE.SphereGeometry(
    dome,
    24,
    12,
    0,
    Math.PI * 2,
    0,
    HALF_PI
  );
  cap.rotateX(HALF_PI);
  group.add(mesh(cap, lens, [centreX, 0, floor + rimH + columnH]));
  return group;
};

/**
 * A circuit board: a slab at the bottom of the box, header strips along
 * both long edges, a chip in the middle and, with `usb` (`-x` or `+x`), a
 * connector at that end.
 */
const pcbForm: FormBuilder = ({ size, params }) => {
  const [x, y, z] = size;
  const group = new THREE.Group();
  const color = colorOf(text(params, "color", "#1d6fa5"));
  const thick = Math.min(num(params, "thickness", 0.0016), z);
  const top = -z / 2 + thick;
  const slab = boardTexture();
  group.add(
    mesh(new THREE.BoxGeometry(x, y, thick), material(color, { map: slab }), [
      0,
      0,
      -z / 2 + thick / 2,
    ])
  );
  const room = z - thick;
  if (num(params, "headers", 1) > 0 && room > 0) {
    const header = material("#151515");
    const stripY = Math.min(0.0025, y * 0.12);
    const stripZ = Math.min(0.0085, room);
    for (const side of [-1, 1]) {
      group.add(
        mesh(new THREE.BoxGeometry(x * 0.78, stripY, stripZ), header, [
          x * 0.04,
          side * (y / 2 - stripY),
          top + stripZ / 2,
        ])
      );
    }
  }
  if (room > 0) {
    const chip = Math.min(x, y) * 0.22;
    const chipZ = Math.min(0.0012, room);
    group.add(
      mesh(new THREE.BoxGeometry(chip, chip, chipZ), material("#1f2328"), [
        x * 0.12,
        0,
        top + chipZ / 2,
      ])
    );
  }
  const usb = text(params, "usb", "");
  if ((usb === "-x" || usb === "+x") && room > 0) {
    const side = usb === "-x" ? -1 : 1;
    const w = x * 0.16;
    const h = Math.min(room, y * 0.22);
    group.add(
      mesh(
        new THREE.BoxGeometry(w, Math.min(y * 0.25, 0.012), h),
        material("#c0c4c8", { metalness: 0.7, roughness: 0.3 }),
        [side * (x / 2 - w / 2 + w * 0.1), 0, top + h / 2]
      )
    );
  }
  return group;
};

export const FORM_BUILDERS: Readonly<Record<string, FormBuilder>> = {
  "case@1": caseForm,
  "can@1": canForm,
  "gear@1": gearForm,
  "disc@1": discForm,
  "die@1": dieForm,
  "axial@1": axialForm,
  "lens@1": lensForm,
  "pcb@1": pcbForm,
};

function boxGroup(size: Vec3, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.add(mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat));
  return group;
}

/**
 * What the scene draws for one part: its form, with any inner forms at
 * their offsets, or the plain box in `fallback` when there is no form or
 * no builder for it.
 */
export function buildVisual(
  size: Vec3,
  form: WorldViewForm | undefined,
  fallback: THREE.Material
): THREE.Group {
  const builder = form ? FORM_BUILDERS[form.form] : undefined;
  if (!form || !builder) return boxGroup(size, fallback);
  const group = builder({ size, params: form.params });
  for (const row of form.inner ?? []) {
    const inner = FORM_BUILDERS[row.form];
    const child = inner
      ? inner({ size: row.size, params: row.params })
      : boxGroup(row.size, material("#9e9e9e"));
    child.position.set(row.at[0], row.at[1], row.at[2]);
    group.add(child);
  }
  return group;
}

/** Free a build's geometries and materials. Shared textures and `keep` stay. */
export function disposeVisual(group: THREE.Object3D, keep?: THREE.Material) {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    const list = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of list) {
      if (mat === keep) continue;
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map && !isCachedTexture(map)) map.dispose();
      mat.dispose();
    }
  });
}
