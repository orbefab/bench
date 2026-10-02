import { Billboard, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Container, Text } from "@react-three/uikit";
import { useRef } from "react";
import type { Object3D } from "three";
import * as THREE from "three";

import {
  formatMm,
  MEASURE_DESKTOP_SPHERE_PX,
  MEASURE_DESKTOP_TEXT_PX,
  MEASURE_LABEL_FONT_SIZE,
  MEASURE_LABEL_OFFSET_Y,
  MEASURE_LABEL_PAD_Y,
  MEASURE_LABEL_PIXEL_SIZE,
  MEASURE_SPHERE_RADIUS,
  measureDelta,
  measureDesktopLabelOffsetY,
  measureNativeTextHeight,
  measureScreenScale,
} from "@/lib/measure";
import { useViewer } from "@/state/viewer";

const parentScale = new THREE.Vector3();
const worldPos = new THREE.Vector3();

export function pinWorldSize(obj: Object3D, extraScale = 1) {
  const parent = obj.parent;
  if (!parent) return;
  parent.updateWorldMatrix(true, false);
  parent.getWorldScale(parentScale);
  const s = Math.max(parentScale.x, 1e-6);
  obj.scale.setScalar(extraScale / s);
}

function desktopExtra(
  obj: Object3D,
  camera: THREE.Camera,
  nativeWorld: number,
  targetPx: number,
  canvasHeight: number
) {
  const parent = obj.parent;
  if (!parent) return 1;
  parent.updateWorldMatrix(true, false);
  parent.localToWorld(worldPos.copy(obj.position));
  const dist = camera.position.distanceTo(worldPos);
  const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 50;
  const zoom = camera instanceof THREE.PerspectiveCamera ? camera.zoom : 1;
  return measureScreenScale(
    nativeWorld,
    targetPx,
    dist,
    fov,
    canvasHeight,
    zoom
  );
}

export function MeasureGizmo() {
  const measure = useViewer((s) => s.measure);
  const aRef = useRef<THREE.Mesh>(null);
  const bRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);
  const labelOffsetRef = useRef<THREE.Group>(null);
  const a = measure.a?.point;
  const b = measure.b?.point;
  const delta = measureDelta(measure.a, measure.b);
  const mid: [number, number, number] | null =
    a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] : null;
  // After OrbitControls (priority -1) so zoom/orbit already moved the camera.
  useFrame((state) => {
    const inXr = state.gl.xr.isPresenting;
    const canvasH = state.size.height;
    const pin = (
      obj: Object3D | null,
      nativeWorld: number,
      targetPx: number
    ) => {
      if (!obj) return;
      pinWorldSize(
        obj,
        inXr
          ? 1
          : desktopExtra(obj, state.camera, nativeWorld, targetPx, canvasH)
      );
    };
    pin(aRef.current, MEASURE_SPHERE_RADIUS * 2, MEASURE_DESKTOP_SPHERE_PX);
    pin(bRef.current, MEASURE_SPHERE_RADIUS * 2, MEASURE_DESKTOP_SPHERE_PX);
    pin(labelRef.current, measureNativeTextHeight(), MEASURE_DESKTOP_TEXT_PX);
    if (labelOffsetRef.current) {
      labelOffsetRef.current.position.y = inXr
        ? MEASURE_LABEL_OFFSET_Y
        : measureDesktopLabelOffsetY();
    }
  });
  return (
    <group>
      {a ? (
        <mesh ref={aRef} position={a} renderOrder={20} raycast={() => {}}>
          <sphereGeometry args={[MEASURE_SPHERE_RADIUS, 12, 8]} />
          <meshBasicMaterial
            color="#2563eb"
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      ) : null}
      {b ? (
        <mesh ref={bRef} position={b} renderOrder={20} raycast={() => {}}>
          <sphereGeometry args={[MEASURE_SPHERE_RADIUS, 12, 8]} />
          <meshBasicMaterial
            color="#dc2626"
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      ) : null}
      {a && b ? (
        <Line points={[a, b]} color="#2563eb" lineWidth={2} depthTest={false} />
      ) : null}
      {mid && delta ? (
        // Desktop: constant CSS-pixel size. XR: native world size at arm's length.
        // Offset lives under the pin so it stays clear of the line at any zoom.
        <group ref={labelRef} position={mid}>
          <Billboard>
            <group
              ref={labelOffsetRef}
              position={[0, MEASURE_LABEL_OFFSET_Y, 0]}
              renderOrder={21}
            >
              <Container
                pixelSize={MEASURE_LABEL_PIXEL_SIZE}
                paddingX={10}
                paddingY={MEASURE_LABEL_PAD_Y}
                borderRadius={10}
                backgroundColor="#18181b"
                pointerEvents="none"
                depthTest={false}
              >
                <Text fontSize={MEASURE_LABEL_FONT_SIZE} color="#fafafa">
                  {formatMm(delta.dist)}
                </Text>
              </Container>
            </group>
          </Billboard>
        </group>
      ) : null}
    </group>
  );
}
