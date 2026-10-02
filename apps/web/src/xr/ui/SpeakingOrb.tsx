import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { getXrChatChars, useXrUi } from "@/state/xr";

/** Ashima 3D simplex. Zero-mean, smooth folds — not the blocky value hash. */
const SNOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m *= m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uWarp;
uniform float uFlow;
varying vec3 vView;
varying vec3 vNorm;
varying vec3 vPos;

${SNOISE}

void main() {
  vec3 nrm = normalize(position);
  float t = uTime;
  float n = snoise(nrm * 2.0 + vec3(0.0, t * 0.25, t * 0.18));
  float n2 = snoise(nrm * 5.0 - vec3(t * 0.4 * uFlow));
  float morph = n * 0.7 + n2 * 0.3;
  vec3 p = nrm * length(position) * (1.0 + morph * uWarp);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vNorm = normalize(normalMatrix * nrm);
  vPos = p;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uGlow;
uniform float uTime;
uniform float uFlow;
varying vec3 vView;
varying vec3 vNorm;
varying vec3 vPos;

void main() {
  vec3 n = normalize(vNorm);
  vec3 v = normalize(vView);
  float ndv = max(dot(n, v), 0.0);

  vec3 q = normalize(vPos);
  for (int i = 0; i < 4; i++) {
    float d = exp2(float(i) + 1.0);
    q += 0.22 * sin(q.yzx * d + uTime * uFlow) / d;
  }
  float field = 0.5 + 0.5 * sin(q.x * 3.0 + q.y * 2.2 + uTime * 0.35);
  vec3 col = mix(uColorA, uColorB, field);

  float core = pow(ndv, 3.2);
  col += core * uGlow * uColorB * 0.65;

  float fres = pow(1.0 - ndv, 2.4);
  col += fres * uGlow * mix(uColorB, vec3(0.85, 0.92, 1.0), 0.55);

  float alpha = mix(0.78, 0.96, ndv);
  gl_FragColor = vec4(col, alpha);
}
`;

const IDLE_A = new THREE.Color("#243044");
const IDLE_B = new THREE.Color("#6b8aa8");
const THINK_A = new THREE.Color("#3a3018");
const THINK_B = new THREE.Color("#c4a056");
const SPEAK_A = new THREE.Color("#1a3354");
const SPEAK_B = new THREE.Color("#7eb6f0");

export const ORB_RADIUS = 0.05;
const RADIUS = ORB_RADIUS;

export function SpeakingOrb({
  x = 0,
  y = 0,
  onClick,
}: {
  x?: number;
  y?: number;
  onClick?: () => void;
}) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uWarp: { value: 0.06 },
          uFlow: { value: 0.55 },
          uGlow: { value: 0.32 },
          uColorA: { value: IDLE_A.clone() },
          uColorB: { value: IDLE_B.clone() },
        },
        transparent: true,
        depthWrite: false,
      }),
    []
  );
  useEffect(() => () => mat.dispose(), [mat]);

  const phase = useXrUi((s) => s.xrChatPhase);
  const lastChars = useRef(0);
  const pulse = useRef(0);
  const warp = useRef(0.06);
  const flow = useRef(0.55);
  const glow = useRef(0.32);
  const colA = useRef(IDLE_A.clone());
  const colB = useRef(IDLE_B.clone());

  useFrame((_, dt) => {
    const chars = getXrChatChars();
    if (chars > lastChars.current) pulse.current = 1;
    lastChars.current = chars;
    pulse.current = Math.max(0, pulse.current - dt * 5);
    const speaking = phase === "streaming";
    const thinking = phase === "submitted";
    const targetWarp = speaking
      ? 0.14 + pulse.current * 0.06
      : thinking
        ? 0.1
        : 0.06;
    const targetFlow = speaking ? 1.35 : thinking ? 1.05 : 0.55;
    const targetGlow = speaking
      ? 0.7 + pulse.current * 0.25
      : thinking
        ? 0.5
        : 0.32;
    const ta = speaking ? SPEAK_A : thinking ? THINK_A : IDLE_A;
    const tb = speaking ? SPEAK_B : thinking ? THINK_B : IDLE_B;
    const k = 1 - Math.exp(-dt * 5);
    warp.current += (targetWarp - warp.current) * k;
    flow.current += (targetFlow - flow.current) * k;
    glow.current += (targetGlow - glow.current) * k;
    colA.current.lerp(ta, k);
    colB.current.lerp(tb, k);
    mat.uniforms.uTime.value += dt * flow.current;
    mat.uniforms.uWarp.value = warp.current;
    mat.uniforms.uFlow.value = flow.current;
    mat.uniforms.uGlow.value = glow.current;
    (mat.uniforms.uColorA.value as THREE.Color).copy(colA.current);
    (mat.uniforms.uColorB.value as THREE.Color).copy(colB.current);
  });

  return (
    <group position={[x, y, 0.02]}>
      <mesh
        renderOrder={2}
        material={mat}
        raycast={onClick ? () => {} : undefined}
      >
        <icosahedronGeometry args={[RADIUS, 4]} />
      </mesh>
      {onClick ? (
        <mesh
          onClick={(ev) => {
            ev.stopPropagation();
            onClick();
          }}
        >
          <sphereGeometry args={[RADIUS + 0.01, 16, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
    </group>
  );
}
