import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { IfInSessionMode, XR } from "@react-three/xr";
import { Suspense, useCallback, useEffect, useLayoutEffect } from "react";
import * as THREE from "three";
import { FIT_HOME_DIR, homeFitDirection } from "@/cad/review";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { usePrefersReducedMotion } from "@/hooks/useMotionReady";
import { useStudioColor } from "@/hooks/useStudioColor";
import { useXrSession } from "@/hooks/useXrSession";
import { fitDistanceScale, fitPanNdc, getLiveFitInsets } from "@/lib/layout";
import { orbitDampingEnabled, viewerFrameloop } from "@/lib/motion";
import { CadModel } from "@/scene/CadModel";
import { bindSceneInvalidate } from "@/scene/invalidate";
import { RecenterOnReset } from "@/scene/RecenterOnReset";
import { SpawnInFront } from "@/scene/SpawnInFront";
import { WorldScene } from "@/scene/WorldScene";
import {
  applyWorldCamera,
  bindWorldCamera,
  takePendingWorldCamera,
} from "@/scene/world-camera";
import { prefsStore } from "@/state/prefs";
import { sceneStore, useScene } from "@/state/scene";
import { useViewer, viewerStore } from "@/state/viewer";
import { useWorld, worldStore } from "@/state/world";
import { tapEmpty } from "@/state/world-tool-tap";
import { xrUiStore } from "@/state/xr";
import { HandRig } from "@/xr/hands/HandRig";
import { HandSkeletons } from "@/xr/hands/HandSkeleton";
import { HandTools } from "@/xr/hands/HandTools";
import { WristWatch } from "@/xr/hands/WristWatch";
import { XRGrab } from "@/xr/hands/XRGrab";
import { CornerAxes, RightAxes, RightHandAxes } from "@/xr/RightAxes";
import { ToolDrawer } from "@/xr/ToolDrawer";
import { CardDock } from "@/xr/ui/CardDock";
import { ChatDock } from "@/xr/ui/ChatDock";
import { useXrTheme } from "@/xr/ui/theme";
import { xrStore } from "@/xrStore";

function StudioFloor() {
  const theme = useXrTheme();
  return (
    <IfInSessionMode allow="immersive-vr">
      <color attach="background" args={[theme.studio]} />
      <gridHelper args={[8, 32, theme.gridMajor, theme.gridMinor]} />
    </IfInSessionMode>
  );
}

function DemandBridge() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    bindSceneInvalidate(invalidate);
    const stores = [viewerStore, sceneStore, prefsStore, xrUiStore, worldStore];
    const unsubs = stores.map((s) => s.subscribe(() => invalidate()));
    return () => {
      for (const unsub of unsubs) unsub();
      bindSceneInvalidate(null);
    };
  }, [invalidate]);
  return null;
}

function FitBridge() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  const setFit = useScene((s) => s.setFit);

  useLayoutEffect(() => {
    setFit((obj, dir) => {
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty() || !(camera instanceof THREE.PerspectiveCamera)) return;
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
      const fov = (camera.fov * Math.PI) / 180;
      const insets = getLiveFitInsets();
      const w = gl.domElement.clientWidth;
      const h = gl.domElement.clientHeight;
      const scale = fitDistanceScale(w, h, insets);
      const dist =
        Math.max((radius / Math.sin(fov / 2)) * 1.2, radius * 1.5, 0.05) *
        scale;
      const from =
        dir?.clone().normalize() ??
        camera.position
          .clone()
          .sub(controls?.target ?? new THREE.Vector3())
          .normalize();
      if (from.lengthSq() < 1e-6) from.set(...FIT_HOME_DIR).normalize();
      camera.position.copy(center).addScaledVector(from, dist);
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
      const ndc = fitPanNdc(w, h, insets);
      if (ndc.x !== 0 || ndc.y !== 0) {
        camera.updateMatrixWorld();
        const halfH = dist * Math.tan(fov / 2);
        const halfW = halfH * camera.aspect;
        const camRight = new THREE.Vector3().setFromMatrixColumn(
          camera.matrixWorld,
          0
        );
        const camUp = new THREE.Vector3().setFromMatrixColumn(
          camera.matrixWorld,
          1
        );
        const shift = camRight
          .multiplyScalar(-ndc.x * halfW)
          .add(camUp.multiplyScalar(-ndc.y * halfH));
        camera.position.add(shift);
        if (controls) {
          controls.target.add(shift);
          controls.update();
        }
      }
      invalidate();
    });
  }, [camera, controls, gl, invalidate, setFit]);
  return null;
}

function WorldCameraBridge() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  useLayoutEffect(() => {
    bindWorldCamera(
      () => {
        if (!controls) return null;
        return {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        };
      },
      (pose) => {
        camera.position.set(...pose.position);
        controls?.target.set(...pose.target);
        controls?.update();
      }
    );
    return () => bindWorldCamera(null, null);
  }, [camera, controls]);
  return null;
}

function SceneCrashBridge({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  const setSceneCrash = useScene((s) => s.setSceneCrash);
  useEffect(() => {
    setSceneCrash({ error, reset });
    return () => setSceneCrash(null);
  }, [error, reset, setSceneCrash]);
  return null;
}

export function ViewerCanvas() {
  const studio = useStudioColor();
  const url = useViewer((s) => s.url);
  const worldPath = useWorld((s) => s.path);
  const setPlaced = useScene((s) => s.setPlaced);
  const xrSession = useXrSession();
  const reduceMotion = usePrefersReducedMotion();
  const onFit = useCallback((obj: THREE.Object3D) => {
    if (xrStore.getState().session) return;
    const pending = takePendingWorldCamera();
    if (pending) {
      applyWorldCamera(pending);
      return;
    }
    sceneStore.getState().fit?.(obj, homeFitDirection());
  }, []);

  return (
    <Canvas
      style={{ position: "absolute", inset: 0 }}
      camera={{ position: [0.42, 0.32, 0.5], fov: 50, near: 0.01, far: 50 }}
      frameloop={viewerFrameloop(Boolean(xrSession))}
      gl={{ antialias: true, alpha: true, localClippingEnabled: true }}
      onPointerMissed={() => {
        if (xrStore.getState().session) return;
        if (!worldStore.getState().path) return;
        tapEmpty();
        if (!worldStore.getState().selection) return;
        worldStore.getState().select(null);
      }}
    >
      <XR store={xrStore}>
        <DemandBridge />
        <IfInSessionMode deny="immersive-ar">
          <color attach="background" args={[studio]} />
        </IfInSessionMode>
        <StudioFloor />
        <RecenterOnReset />
        <hemisphereLight args={[0xffffff, 0xb8bcc2, 0.95]} />
        <directionalLight position={[0.55, 1.1, 0.45]} intensity={1.35} />
        <directionalLight position={[-0.6, 0.25, -0.35]} intensity={0.35} />
        <FitBridge />
        <WorldCameraBridge />
        <group
          ref={(group) => {
            setPlaced(group);
          }}
        >
          <SpawnInFront />
          <RenderErrorBoundary
            resetKeys={[url, worldPath]}
            fallback={({ error, reset }) => (
              <SceneCrashBridge error={error} reset={reset} />
            )}
          >
            {worldPath ? (
              <WorldScene onFit={onFit} />
            ) : (
              <CadModel onFit={onFit} />
            )}
          </RenderErrorBoundary>
        </group>
        <XRGrab />
        <HandSkeletons />
        {/* One wrist XRSpace per hand; everything wrist-mounted hangs off it. */}
        <HandRig handedness="left">
          <WristWatch />
        </HandRig>
        <HandRig handedness="right">
          <HandTools />
          <RightHandAxes />
        </HandRig>
        <RightAxes />
        <Suspense fallback={null}>
          <CardDock />
          <ChatDock />
          <ToolDrawer />
        </Suspense>
        <IfInSessionMode deny={["immersive-ar", "immersive-vr"]}>
          <OrbitControls
            makeDefault
            enableDamping={orbitDampingEnabled(reduceMotion)}
            onStart={() => viewerStore.getState().setCameraMoved(true)}
          />
          <CornerAxes />
        </IfInSessionMode>
      </XR>
    </Canvas>
  );
}
