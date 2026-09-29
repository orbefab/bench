import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { portProbeId } from "@sfab-bench/contract";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

import { useXrSession } from "@/hooks/useXrSession";
import { type PortBody, type PortMarker, wireMarkers } from "@/lib/world-ports";
import { isDimmed } from "@/lib/world-wire";
import { PORT_MARKER_TAG } from "@/scene/world-pointer";
import { useWorld } from "@/state/world";
import { toggleProbePort, useProbes } from "@/state/world-probe";
import { useWorldTool } from "@/state/world-tool";
import { tapWirePort, useWireHeld } from "@/state/world-wire";

const FREE = "#f59e0b";
const WIRED = "#7c8b9c";
const HELD = "#22c55e";
const PROBED = "#0ea5e9";
const HIT_MIN = 0.006;

function markerLabel(marker: PortMarker): string {
  const facts = [marker.domain, marker.wired ? "wired" : "free"].filter(
    Boolean
  );
  return `${marker.ref} · ${facts.join(" · ")}`;
}

/**
 * Port markers, drawn in the frame they are given (the world content
 * group). It knows nothing about wiring: the caller says which marker is
 * held, which are dimmed, and what a click does, so the Probe tool can pick
 * ports through the same component. A free port is a solid amber dot, a
 * wired one a smaller blue-grey dot, the held one a larger green dot; a
 * dimmed one fades. The name shows on hover.
 */
export function PortMarkers({
  markers,
  held = null,
  marked,
  dimmed,
  onPick,
}: {
  markers: readonly PortMarker[];
  held?: string | null;
  /** Refs drawn as probed. */
  marked?: ReadonlySet<string>;
  dimmed?: (marker: PortMarker) => boolean;
  onPick: (ref: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    document.body.style.cursor = hover ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hover]);
  return (
    <>
      {markers.map((marker) => {
        const isHeld = held === marker.ref;
        const faded = dimmed?.(marker) ?? false;
        const probed = marked?.has(marker.ref) ?? false;
        const scale = isHeld || probed ? 1.4 : marker.wired ? 0.7 : 1;
        const color = isHeld
          ? HELD
          : probed
            ? PROBED
            : marker.wired
              ? WIRED
              : FREE;
        return (
          <group key={marker.ref} position={marker.position}>
            <mesh
              renderOrder={20}
              scale={hover === marker.ref ? 1.3 : 1}
              raycast={() => {}}
            >
              <sphereGeometry args={[marker.radius * scale, 16, 12]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={faded ? 0.25 : 1}
                depthTest={false}
              />
            </mesh>
            <mesh
              renderOrder={21}
              userData={{ [PORT_MARKER_TAG]: true }}
              onClick={(event) => {
                event.stopPropagation();
                if (event.delta > 2) return;
                onPick(marker.ref);
              }}
              onPointerOver={(event) => {
                event.stopPropagation();
                setHover(marker.ref);
              }}
              onPointerOut={() =>
                setHover((current) => (current === marker.ref ? null : current))
              }
            >
              <sphereGeometry
                args={[Math.max(marker.radius * 2, HIT_MIN), 12, 8]}
              />
              <meshBasicMaterial
                transparent
                opacity={0}
                depthWrite={false}
                depthTest={false}
              />
            </mesh>
            {hover === marker.ref ? (
              <Html
                distanceFactor={0.8}
                position={[0, 0, marker.radius * 3]}
                style={{ pointerEvents: "none" }}
              >
                <div className="whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-[11px] text-card-foreground shadow">
                  {markerLabel(marker)}
                  {probed ? " · probed" : ""}
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </>
  );
}

/** A line from the held port to the pointer, on the plane the port sits in. */
function RubberBand({
  from,
  frame,
}: {
  from: PortMarker["position"];
  frame: RefObject<THREE.Group | null>;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3)
    );
    const material = new THREE.LineBasicMaterial({
      color: HELD,
      transparent: true,
      depthTest: false,
    });
    const next = new THREE.Line(geometry, material);
    next.raycast = () => {};
    next.frustumCulled = false;
    next.renderOrder = 19;
    return next;
  }, []);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line]
  );
  useLayoutEffect(() => {
    const position = line.geometry.getAttribute("position");
    position.setXYZ(0, from[0], from[1], from[2]);
    position.setXYZ(1, from[0], from[1], from[2]);
    position.needsUpdate = true;
    invalidate();
  }, [line, from, invalidate]);
  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const ndc = new THREE.Vector2();
    const anchor = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const hit = new THREE.Vector3();
    const move = (event: PointerEvent) => {
      const group = frame.current;
      if (!group) return;
      const rect = element.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      group.updateWorldMatrix(true, false);
      anchor.set(from[0], from[1], from[2]);
      group.localToWorld(anchor);
      normal.set(0, 0, 1).transformDirection(group.matrixWorld);
      plane.setFromNormalAndCoplanarPoint(normal, anchor);
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      group.worldToLocal(hit);
      const position = line.geometry.getAttribute("position");
      position.setXYZ(1, hit.x, hit.y, hit.z);
      position.needsUpdate = true;
      invalidate();
    };
    element.addEventListener("pointermove", move);
    return () => element.removeEventListener("pointermove", move);
  }, [gl, camera, invalidate, from, frame, line]);
  return <primitive object={line} />;
}

/**
 * The Wire tool's layer, inside the world content group so a marker is in
 * the document frame. Present only in Wire, and not in an XR session.
 */
export function WireLayer({ bodies }: { bodies: readonly PortBody[] }) {
  const session = useXrSession();
  const mode = useWorldTool((s) => s.mode);
  const held = useWireHeld();
  const tree = useWorld((s) => s.tree);
  const openDocument = useWorld((s) => s.path);
  const frame = useRef<THREE.Group>(null);
  const markers = useMemo(
    () => wireMarkers(tree, bodies, openDocument),
    [tree, bodies, openDocument]
  );
  const heldMarker = markers.find((marker) => marker.ref === held) ?? null;
  const dimmed = useMemo(
    () => (marker: PortMarker) => isDimmed(marker, heldMarker),
    [heldMarker]
  );
  if (session || mode !== "wire") return null;
  return (
    <group ref={frame} name="wire-layer">
      <PortMarkers
        markers={markers}
        held={held}
        dimmed={dimmed}
        onPick={tapWirePort}
      />
      {heldMarker ? (
        <RubberBand from={heldMarker.position} frame={frame} />
      ) : null}
    </group>
  );
}

/**
 * The Probe tool's layer: the same markers, a click toggles the port on the
 * timeline. Present only in Probe, and not in an XR session.
 */
export function ProbeLayer({ bodies }: { bodies: readonly PortBody[] }) {
  const session = useXrSession();
  const mode = useWorldTool((s) => s.mode);
  const probes = useProbes();
  const tree = useWorld((s) => s.tree);
  const openDocument = useWorld((s) => s.path);
  const markers = useMemo(
    () => wireMarkers(tree, bodies, openDocument),
    [tree, bodies, openDocument]
  );
  const marked = useMemo(
    () =>
      new Set(
        markers
          .filter((marker) =>
            probes.includes(portProbeId(marker.instance, marker.name))
          )
          .map((marker) => marker.ref)
      ),
    [markers, probes]
  );
  if (session || mode !== "probe") return null;
  return (
    <group name="probe-layer">
      <PortMarkers
        markers={markers}
        marked={marked}
        onPick={(ref) => {
          const marker = markers.find((item) => item.ref === ref);
          if (marker)
            toggleProbePort(portProbeId(marker.instance, marker.name));
        }}
      />
    </group>
  );
}
