import {
  type ThreeElements,
  type ThreeEvent,
  useThree,
} from "@react-three/fiber";
import {
  createContext,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useRef,
} from "react";
import * as THREE from "three";

import { faceToward } from "@/scene/SpawnInFront";
import { xrUiStore } from "@/state/xr";
import { CardChrome, HandleButton } from "@/xr/ui/CardChrome";
import { type CardSize, cardMeters, type Region } from "@/xr/ui/chrome";
import {
  type Feedback,
  FeedbackContext,
  useRightControllerFeedback,
} from "@/xr/ui/ToolBtn";

const tmpV = new THREE.Vector3();

type Limits = { minW: number; minH: number; maxW: number; maxH: number };

type WorldCardValue = {
  anchor: React.RefObject<THREE.Group | null>;
  size: CardSize;
  meters: { w: number; h: number };
  limits: Limits;
  feedback: Feedback;
  startMove: (ev: ThreeEvent<PointerEvent>) => void;
  dragMove: (ev: ThreeEvent<PointerEvent>) => void;
  startMoveAt: (world: THREE.Vector3) => void;
  moveTo: (world: THREE.Vector3) => void;
  endMove: (ev?: ThreeEvent<PointerEvent>) => void;
  setSize: (next: CardSize) => void;
  setDragging: (active: boolean) => void;
  notifyDragStart: (region: Region) => void;
  notifyDragEnd: (region: Region) => void;
};

const WorldCardContext = createContext<WorldCardValue | null>(null);

/** Internal — CardChrome and the closed-orb grab. */
export function useWorldCard(): WorldCardValue {
  const ctx = useContext(WorldCardContext);
  if (!ctx) throw new Error("useWorldCard must be used within <WorldCard>");
  return ctx;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

export type WorldCardProps = ThreeElements["group"] & {
  size: CardSize;
  limits?: Limits;
  onSizeChange?: (next: CardSize) => void;
  shape?: "card" | "orb";
  radius?: number;
  resizable?: boolean;
  movable?: boolean;
  handle?: boolean | ReactNode;
  onDragStart?: (region: Region) => void;
  onDragEnd?: (region: Region) => void;
};

export function WorldCard({
  ref,
  size,
  onSizeChange,
  limits = { minW: size.w, minH: size.h, maxW: size.w, maxH: size.h },
  shape = "card",
  radius,
  resizable = true,
  movable = true,
  handle = false,
  onDragStart,
  onDragEnd,
  children,
  ...props
}: WorldCardProps) {
  const inner = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const feedback = useRightControllerFeedback();
  const drag = useRef<{
    kind: "ray" | "near";
    dist: number;
    offset: THREE.Vector3;
  } | null>(null);
  const meters = cardMeters(size);
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const onSizeRef = useRef(onSizeChange);
  onSizeRef.current = onSizeChange;

  const setDragging = useCallback((active: boolean) => {
    xrUiStore.getState().setCardDragging(active);
  }, []);

  const notifyDragStart = useCallback((region: Region) => {
    onDragStartRef.current?.(region);
  }, []);
  const notifyDragEnd = useCallback((region: Region) => {
    onDragEndRef.current?.(region);
  }, []);

  const startMoveAt = useCallback(
    (world: THREE.Vector3, kind: "ray" | "near" = "near", dist = 0) => {
      const a = inner.current;
      if (!a || drag.current) return;
      drag.current = { kind, dist, offset: a.position.clone().sub(world) };
      faceToward(a, cameraRef.current);
      setDragging(true);
      feedback.click();
    },
    [feedback, setDragging]
  );
  const moveTo = useCallback((world: THREE.Vector3) => {
    const d = drag.current;
    const a = inner.current;
    if (!d || !a) return;
    a.position.copy(world).add(d.offset);
    faceToward(a, cameraRef.current);
  }, []);
  const startMove = useCallback(
    (ev: ThreeEvent<PointerEvent>) => {
      const a = inner.current;
      if (!a || drag.current) return;
      ev.stopPropagation();
      const cap = ev.target as {
        setPointerCapture?: (pid: number) => void;
      } | null;
      cap?.setPointerCapture?.(ev.pointerId);
      const dist = ev.ray.origin.distanceTo(ev.point);
      startMoveAt(ev.point, "ray", dist);
    },
    [startMoveAt]
  );
  const dragMove = useCallback(
    (ev: ThreeEvent<PointerEvent>) => {
      const d = drag.current;
      if (!d || d.kind !== "ray") return;
      ev.stopPropagation();
      tmpV.copy(ev.ray.direction).multiplyScalar(d.dist).add(ev.ray.origin);
      moveTo(tmpV);
    },
    [moveTo]
  );
  const endMove = useCallback(
    (ev?: ThreeEvent<PointerEvent>) => {
      if (!drag.current) return;
      ev?.stopPropagation();
      const cap = ev?.target as {
        releasePointerCapture?: (id: number) => void;
      } | null;
      if (ev) cap?.releasePointerCapture?.(ev.pointerId);
      drag.current = null;
      setDragging(false);
    },
    [setDragging]
  );

  const setSize = useCallback((next: CardSize) => {
    onSizeRef.current?.(next);
  }, []);

  const value: WorldCardValue = {
    anchor: inner,
    size,
    meters,
    limits,
    feedback,
    startMove,
    dragMove,
    startMoveAt: (world: THREE.Vector3) => startMoveAt(world, "near"),
    moveTo,
    endMove,
    setSize,
    setDragging,
    notifyDragStart,
    notifyDragEnd,
  };

  const hasHandle = handle === true || (handle != null && handle !== false);
  const showChrome = shape === "orb" || resizable || movable || hasHandle;

  return (
    <FeedbackContext.Provider value={feedback}>
      <WorldCardContext.Provider value={value}>
        <group
          name="world-card"
          ref={(node) => {
            inner.current = node;
            assignRef(ref as Ref<THREE.Group | null> | undefined, node);
          }}
          {...props}
        >
          {showChrome ? (
            <CardChrome
              shape={shape}
              radius={radius}
              corners={resizable}
              edges={movable ? ["t", "l", "r"] : []}
              handle={handle}
            />
          ) : null}
          {children}
        </group>
      </WorldCardContext.Provider>
    </FeedbackContext.Provider>
  );
}

export type { CardSize, Region };
export { HandleButton };
