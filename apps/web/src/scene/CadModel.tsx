import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";

import { pickAlongRay, pickFromIntersections } from "@/cad/highlights";
import { MeasureGizmo } from "@/scene/MeasureGizmo";
import { useViewer } from "@/state/viewer";
import { xrUiStore } from "@/state/xr";

export function CadModel({ onFit }: { onFit: (obj: THREE.Object3D) => void }) {
  const { review, selectFromModel, hover, setVisible, tool, measureClick } =
    useViewer(
      useShallow((s) => ({
        review: s.review,
        selectFromModel: s.selectFromModel,
        hover: s.hover,
        setVisible: s.setVisible,
        tool: s.tool,
        measureClick: s.measureClick,
      }))
    );
  const wrap = useRef<THREE.Group>(null);

  useEffect(() => {
    if (tool !== "measure") hover(null);
  }, [tool, hover]);

  const radius = useMemo(() => {
    if (!review) return 0.08;
    const size = review.bounds.getSize(new THREE.Vector3());
    return Math.max(size.x, size.z, 0.04) * 0.55;
  }, [review]);

  useEffect(() => {
    if (review) onFit(review.root);
  }, [review, onFit]);

  if (!review) return null;

  const fromEvent = (ev: ThreeEvent<MouseEvent>) => {
    ev.stopPropagation();
    return (
      pickFromIntersections(review, ev.intersections) ??
      pickAlongRay(review, ev.ray)
    );
  };

  return (
    <group ref={wrap}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.0008} raycast={() => {}}>
        <circleGeometry args={[radius, 48]} />
        <meshBasicMaterial color="#1a1d21" transparent opacity={0.12} />
      </mesh>
      <group
        position-y={review.sitHeight}
        pointerEvents="auto"
        onClick={(ev) => {
          const hit = fromEvent(ev);
          if (!hit) return;
          // A pinch that starts or ends a grab is not a click on the model.
          const xr = xrUiStore.getState();
          if (xr.worldGrabbing || xr.cardDragging) return;
          if (tool === "measure") {
            const local = wrap.current
              ? wrap.current.worldToLocal(hit.point.clone())
              : hit.point;
            measureClick({
              cadRef: hit.cadRef,
              point: [local.x, local.y, local.z],
            });
            return;
          }
          if (tool === "hide") {
            hover(null);
            setVisible(hit.partId, false);
            return;
          }
          selectFromModel(hit.partId, hit.cadRef);
        }}
        onPointerMove={(ev) => {
          ev.stopPropagation();
          if (tool === "measure") return;
          hover(fromEvent(ev)?.partId ?? null);
        }}
        onPointerOut={() => {
          if (tool === "measure") return;
          hover(null);
        }}
      >
        <primitive object={review.root} />
      </group>
      <MeasureGizmo />
    </group>
  );
}
