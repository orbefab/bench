import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useFrame, useThree } from "@react-three/fiber";
import {
  WORLD_TARGET_ROBOT,
  type WorldPose,
  type WorldPrimitive,
  type WorldVec3,
  type WorldViewNode,
} from "@sfab-bench/contract";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

import { applyMeshHighlights, clearHighlights } from "@/cad/highlights";
import { useXrSession } from "@/hooks/useXrSession";
import {
  type LoadedPrimitive,
  type LoadedVisual,
  type LoadedWorld,
  loadWorldAssets,
  releaseMeshes,
} from "@/lib/world-assets";
import { isClick, objectFromPose, poseDelta } from "@/lib/world-drag";
import { moveTarget } from "@/lib/world-move";
import { type PortBody, ROBOT_HALF } from "@/lib/world-ports";
import {
  urdfRpyQuaternion,
  WORLD_TO_SCENE_X,
  worldQuatToThree,
} from "@/lib/world-pose";
import { findViewNode } from "@/lib/world-tree";
import {
  instanceWarningMap,
  warningsFromRun,
  warningText,
} from "@/lib/world-warnings";
import { invalidateSceneNow } from "@/scene/invalidate";
import { useOrbitPause } from "@/scene/use-orbit-pause";
import { ProbeLayer, WireLayer } from "@/scene/WorldPortMarkers";
import { WorldToolGizmo } from "@/scene/WorldToolGizmo";
import { startBodyDrag } from "@/scene/world-body-drag";
import { setWorldFitTarget } from "@/scene/world-fit";
import { rayOwner } from "@/scene/world-pointer";
import { clearPreviews, registerPreview } from "@/scene/world-preview";
import {
  useWorld,
  type WorldSelection,
  worldLiveState,
  worldStore,
} from "@/state/world";
import { resetTimeline, worldViewPoses } from "@/state/world-timeline";
import { worldToolStore } from "@/state/world-tool";
import { tapEmpty } from "@/state/world-tool-tap";
import { useXrTheme } from "@/xr/ui/theme";

const ROBOT_COLORS = [0xc4b8a5, 0x8fa3b0, 0xb7a0c4, 0xa3b59a, 0xc4a090];
const GROUND = 4;

function finiteVec(v: readonly number[], n: number): boolean {
  return v.length >= n && v.slice(0, n).every((item) => Number.isFinite(item));
}

function labelTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "600 36px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function WorldGround() {
  const theme = useXrTheme();
  const grid = useMemo(() => {
    const helper = new THREE.GridHelper(
      GROUND,
      40,
      theme.gridMajor,
      theme.gridMinor
    );
    helper.raycast = () => {};
    return helper;
  }, [theme.gridMajor, theme.gridMinor]);
  useEffect(() => {
    return () => {
      grid.geometry.dispose();
      const material = grid.material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else material.dispose();
    };
  }, [grid]);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.002} raycast={() => {}}>
        <planeGeometry args={[GROUND, GROUND]} />
        <meshStandardMaterial color={theme.gridMinor} roughness={1} />
      </mesh>
      <primitive object={grid} />
    </>
  );
}

function Body({
  pose,
  path,
  children,
}: {
  pose: WorldPose;
  /** Run path, when a tool can move this instance. */
  path?: string;
  children: ReactNode;
}) {
  const quaternion = useMemo(() => worldQuatToThree(pose.rotation), [pose]);
  const ref = useRef<THREE.Group>(null);
  const rest = useRef(pose);
  rest.current = pose;
  useEffect(() => {
    if (!path) return;
    return registerPreview(path, {
      set: (next) => {
        const group = ref.current;
        if (!group) return;
        const object = objectFromPose(next ?? rest.current);
        group.position.copy(object.position);
        group.quaternion.copy(object.quaternion);
      },
    });
  }, [path]);
  return (
    <group ref={ref} position={pose.position} quaternion={quaternion}>
      {children}
    </group>
  );
}

/**
 * A robot's link poses come from the run in the document frame, so a
 * preview carries the whole robot by the delta between its stored base
 * pose and the dragged one.
 */
function RobotFrame({
  robotId,
  children,
}: {
  robotId: string;
  children: ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    return registerPreview(robotId, {
      set: (next) => {
        const group = ref.current;
        if (!group) return;
        const tree = worldStore.getState().tree;
        const base = tree ? findViewNode(tree.nodes, robotId)?.pose : null;
        if (!next || !base) {
          group.position.set(0, 0, 0);
          group.quaternion.identity();
          return;
        }
        const delta = poseDelta(base, next);
        group.position.copy(delta.position);
        group.quaternion.copy(delta.quaternion);
      },
    });
  }, [robotId]);
  return (
    <group ref={ref} name={robotId}>
      {children}
    </group>
  );
}

function BoardLabel({
  text,
  color,
  z,
}: {
  text: string;
  color: string;
  z: number;
}) {
  const texture = useMemo(() => labelTexture(text, color), [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite
      position={[0, 0, z]}
      scale={[0.05, 0.0125, 0.001]}
      raycast={() => {}}
    >
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function ObjVisual({
  object,
  material,
  scale,
}: {
  object: THREE.Object3D;
  material: THREE.Material;
  scale: [number, number, number];
}) {
  const clone = useMemo(() => {
    const next = object.clone(true);
    next.scale.set(scale[0], scale[1], scale[2]);
    next.traverse((child) => {
      if (child instanceof THREE.Mesh) child.material = material;
    });
    return next;
  }, [object, material, scale]);
  return <primitive object={clone} />;
}

function PrimitiveMesh({
  primitive,
  material,
}: {
  primitive: WorldPrimitive | LoadedPrimitive;
  material: THREE.Material;
}) {
  if (primitive.shape === "box") {
    if (!finiteVec(primitive.size, 3)) return null;
    const [x, y, z] = primitive.size;
    return (
      <mesh material={material}>
        <boxGeometry args={[x, y, z]} />
      </mesh>
    );
  }
  if (primitive.shape === "sphere") {
    if (!Number.isFinite(primitive.size) || primitive.size <= 0) return null;
    return (
      <mesh material={material}>
        <sphereGeometry args={[primitive.size, 24, 16]} />
      </mesh>
    );
  }
  if (
    !Number.isFinite(primitive.size.radius) ||
    !Number.isFinite(primitive.size.length) ||
    primitive.size.radius <= 0 ||
    primitive.size.length <= 0
  ) {
    return null;
  }
  return (
    <mesh material={material} rotation-x={Math.PI / 2}>
      <cylinderGeometry
        args={[
          primitive.size.radius,
          primitive.size.radius,
          primitive.size.length,
          24,
        ]}
      />
    </mesh>
  );
}

function VisualOrigin({
  xyz,
  rpy,
  children,
}: {
  xyz: [number, number, number];
  rpy: [number, number, number];
  children: ReactNode;
}) {
  const quaternion = useMemo(() => urdfRpyQuaternion(rpy), [rpy]);
  return (
    <group position={xyz} quaternion={quaternion}>
      {children}
    </group>
  );
}

function linkKey(robotId: string, link: string) {
  return `${robotId}/${link}`;
}

function selectionKey(selection: NonNullable<WorldSelection>): string {
  if (selection.link) return `link:${selection.path}/${selection.link}`;
  return `instance:${selection.path}`;
}

function linkMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.12,
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
}

function calloutNodes(
  nodes: readonly WorldViewNode[],
  warnings: ReturnType<typeof warningsFromRun>,
  into: { id: string; pose: WorldViewNode["pose"]; text: string }[] = []
) {
  for (const node of nodes) {
    const rows = warnings.get(node.id);
    if (rows && rows.length > 0) {
      into.push({ id: node.id, pose: node.pose, text: warningText(rows) });
    }
    calloutNodes(node.children, warnings, into);
  }
  return into;
}

function WarningCallouts() {
  const session = useXrSession();
  const tree = useWorld((s) => s.tree);
  const report = useWorld((s) => s.report);
  const diagnostics = useWorld((s) => s.diagnostics);
  const selected = useWorld((s) => s.selection?.path ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const warnings = useMemo(
    () => instanceWarningMap(warningsFromRun(report, diagnostics)),
    [report, diagnostics]
  );
  const markers = useMemo(
    () => (tree ? calloutNodes(tree.nodes, warnings) : []),
    [tree, warnings]
  );
  if (session || markers.length === 0) return null;
  return (
    <>
      {markers.map((marker) => {
        const open = hover === marker.id || selected === marker.id;
        return (
          <Body key={marker.id} pose={marker.pose}>
            <mesh
              onClick={(event) => {
                const owner = rayOwner(event);
                if (owner === "marker") return;
                event.stopPropagation();
                if (owner === "empty") {
                  if (isClick(event.delta)) tapEmpty();
                  return;
                }
                worldStore.getState().select({
                  kind: "instance",
                  path: marker.id,
                });
              }}
              onPointerOut={() =>
                setHover((current) => (current === marker.id ? null : current))
              }
              onPointerOver={(event) => {
                if (rayOwner(event) !== "body") return;
                event.stopPropagation();
                setHover(marker.id);
              }}
            >
              <sphereGeometry args={[0.012, 16, 12]} />
              <meshBasicMaterial color="#c2410c" />
            </mesh>
            {open ? (
              <Html
                distanceFactor={0.8}
                position={[0, 0.04, 0]}
                style={{ pointerEvents: "none" }}
              >
                <div className="max-w-56 whitespace-pre-wrap rounded-md border border-border bg-card px-2 py-1 text-[11px] text-card-foreground shadow">
                  {marker.text}
                </div>
              </Html>
            ) : null}
          </Body>
        );
      })}
    </>
  );
}

export function WorldScene({
  onFit,
}: {
  onFit: (obj: THREE.Object3D) => void;
}) {
  const path = useWorld((s) => s.path);
  const loadId = useWorld((s) => s.loadId);
  const revision = useWorld((s) => s.revision);
  const [loaded, setLoaded] = useState<LoadedWorld | null>(null);
  const heldKeys = useRef<string[]>([]);
  const contentRef = useRef<THREE.Group>(null);
  const proxyRef = useRef<THREE.Group>(null);
  const linkGroups = useRef(new Map<string, THREE.Group>());
  const getThree = useThree((s) => s.get);
  const orbit = useOrbitPause();
  const theme = useXrTheme();

  useEffect(() => {
    let cancelled = false;
    if (!worldStore.getState().sceneReady) {
      worldStore.getState().setAssets("loading");
    }
    void loadWorldAssets(path, revision)
      .then((next) => {
        if (cancelled) {
          releaseMeshes(next.meshKeys);
          return;
        }
        const previous = heldKeys.current;
        heldKeys.current = next.meshKeys;
        setLoaded(next);
        worldStore.getState().setAssetIssues(next.problems);
        worldStore.getState().setAssets("ready", true);
        worldStore.getState().setOutline(next.outline);
        worldStore.getState().setTree(next.tree);
        releaseMeshes(previous);
        invalidateSceneNow();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        releaseMeshes(heldKeys.current);
        heldKeys.current = [];
        setLoaded(null);
        resetTimeline();
        worldStore.getState().setAssetIssues([{ text: message }]);
        worldStore.getState().setAssets("error", false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, loadId, revision]);

  useEffect(() => {
    return () => {
      releaseMeshes(heldKeys.current);
      heldKeys.current = [];
      setWorldFitTarget(null);
    };
  }, []);

  // A reload carries the pose the document now has; a preview is done.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` is the trigger
  useEffect(() => {
    clearPreviews();
  }, [loaded]);

  const robots = useMemo(() => {
    const byRobot = new Map<string, Map<string, LoadedVisual[]>>();
    for (const visual of loaded?.visuals ?? []) {
      let links = byRobot.get(visual.robotId);
      if (!links) {
        links = new Map();
        byRobot.set(visual.robotId, links);
      }
      const list = links.get(visual.link) ?? [];
      list.push(visual);
      links.set(visual.link, list);
    }
    return [...byRobot.entries()];
  }, [loaded]);

  const portBodies = useMemo<PortBody[]>(() => {
    const document = loaded?.document;
    if (!document) return [];
    const halves = (size: readonly number[]): WorldVec3 => [
      size[0] / 2,
      size[1] / 2,
      size[2] / 2,
    ];
    return [
      ...document.boards
        .filter((board) => board.pose && finiteVec(board.size, 3))
        .map((board) => ({ id: board.id, half: halves(board.size) })),
      ...document.boxes
        .filter((box) => box.pose && finiteVec(box.size, 3))
        .map((box) => ({ id: box.id, half: halves(box.size) })),
      ...robots.map(([robotId]) => ({ id: robotId, half: [...ROBOT_HALF] })),
    ] as PortBody[];
  }, [loaded, robots]);

  const linkMaterials = useMemo(() => {
    const map = new Map<string, THREE.MeshStandardMaterial>();
    robots.forEach(([robotId, links], index) => {
      const color = ROBOT_COLORS[index % ROBOT_COLORS.length] ?? 0xc4b8a5;
      for (const name of links.keys()) {
        map.set(linkKey(robotId, name), linkMaterial(color));
      }
    });
    return map;
  }, [robots]);
  const boardMaterials = useMemo(() => {
    const map = new Map<string, THREE.MeshStandardMaterial>();
    for (const board of loaded?.document.boards ?? []) {
      map.set(
        board.id,
        new THREE.MeshStandardMaterial({
          color: 0x6d8ea3,
          metalness: 0.08,
          roughness: 0.7,
        })
      );
    }
    return map;
  }, [loaded]);
  const partMaterials = useMemo(() => {
    const map = new Map<string, THREE.MeshStandardMaterial>();
    for (const box of loaded?.document.boxes ?? []) {
      map.set(
        box.id,
        new THREE.MeshStandardMaterial({
          color: 0xb08968,
          metalness: 0.08,
          roughness: 0.7,
        })
      );
    }
    return map;
  }, [loaded]);
  useEffect(() => {
    return () => {
      clearHighlights();
      for (const material of linkMaterials.values()) material.dispose();
      for (const material of boardMaterials.values()) material.dispose();
      for (const material of partMaterials.values()) material.dispose();
    };
  }, [linkMaterials, boardMaterials, partMaterials]);
  const primitiveMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xb0b4b8,
        metalness: 0.05,
        roughness: 0.85,
      }),
    []
  );
  useEffect(() => {
    return () => {
      primitiveMaterial.dispose();
    };
  }, [primitiveMaterial]);

  const session = useXrSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const hoveredRoot = useRef<THREE.Object3D | null>(null);
  const pickRoots = useRef(new Map<string, THREE.Object3D>());
  const paintRef = useRef<() => void>(() => {});
  paintRef.current = () => {
    if (sessionRef.current) {
      clearHighlights();
      return;
    }
    const selection = worldStore.getState().selection;
    const selected = selection
      ? (pickRoots.current.get(selectionKey(selection)) ?? null)
      : null;
    applyMeshHighlights(selected, hoveredRoot.current);
  };

  useEffect(() => {
    if (session) hoveredRoot.current = null;
    paintRef.current();
    return worldStore.subscribe((state, prev) => {
      if (state.selection === prev.selection) return;
      paintRef.current();
      invalidateSceneNow();
    });
  }, [loaded, session, linkMaterials, boardMaterials, partMaterials]);

  // In Select, a drag that starts on the selected board or box moves it.
  const startDrag = (
    pick: NonNullable<WorldSelection>,
    event: ThreeEvent<PointerEvent>
  ) => {
    if (event.button !== 0 || sessionRef.current) return;
    if (worldToolStore.getState().mode !== "select") return;
    const state = worldStore.getState();
    if (state.selection?.path !== pick.path) return;
    const move = moveTarget(state.tree, pick.path, state.path);
    const content = contentRef.current;
    if (!move.ok || !content) return;
    startBodyDrag({
      event,
      three: getThree(),
      content,
      move,
      path: pick.path,
      orbit,
    });
  };

  const bindPick = (pick: NonNullable<WorldSelection>, draggable = false) => {
    if (session) return {};
    const hover = (event: ThreeEvent<PointerEvent>) => {
      if (rayOwner(event) !== "body") return;
      event.stopPropagation();
      const root = pickRoots.current.get(selectionKey(pick)) ?? null;
      if (hoveredRoot.current === root) return;
      hoveredRoot.current = root;
      paintRef.current();
      invalidateSceneNow();
    };
    return {
      ...(draggable
        ? {
            onPointerDown: (event: ThreeEvent<PointerEvent>) =>
              startDrag(pick, event),
          }
        : {}),
      onClick: (event: ThreeEvent<MouseEvent>) => {
        const owner = rayOwner(event);
        if (owner === "marker") return;
        event.stopPropagation();
        if (!isClick(event.delta) || sessionRef.current) return;
        tapEmpty();
        if (owner === "body") worldStore.getState().select(pick);
      },
      onPointerMove: hover,
      onPointerOut: () => {
        const root = pickRoots.current.get(selectionKey(pick)) ?? null;
        if (hoveredRoot.current !== root) return;
        hoveredRoot.current = null;
        paintRef.current();
        invalidateSceneNow();
      },
    };
  };

  const clearPick = session
    ? {}
    : {
        onClick: (event: ThreeEvent<MouseEvent>) => {
          if (rayOwner(event) === "marker") return;
          event.stopPropagation();
          if (!isClick(event.delta)) return;
          tapEmpty();
          worldStore.getState().select(null);
        },
        onPointerMove: (event: ThreeEvent<PointerEvent>) => {
          if (rayOwner(event) === "marker") return;
          event.stopPropagation();
          if (!hoveredRoot.current) return;
          hoveredRoot.current = null;
          paintRef.current();
          invalidateSceneNow();
        },
      };

  useFrame(() => {
    const poses = sessionRef.current ? null : worldViewPoses();
    const live = poses ?? worldLiveState()?.poses;
    if (!live) return;
    for (const [robotId, links] of Object.entries(live)) {
      for (const [name, pose] of Object.entries(links)) {
        const group = linkGroups.current.get(linkKey(robotId, name));
        if (!group) continue;
        const p = pose.p;
        const q = pose.q;
        group.position.set(p[0], p[1], p[2]);
        group.quaternion.set(q[1], q[2], q[3], q[0]);
      }
    }
  });

  useLayoutEffect(() => {
    const obj = contentRef.current;
    if (!obj || !loaded) return;
    setWorldFitTarget(obj);
    onFit(obj);
  }, [loaded, onFit]);

  if (!loaded) return null;
  const doc = loaded.document;
  const primitives = doc.environment.primitives;
  const targets = doc.environment.targets;

  return (
    <>
      {doc.environment.ground.plane ? <WorldGround /> : null}
      <group ref={contentRef} rotation-x={WORLD_TO_SCENE_X} name="world">
        <group ref={proxyRef} name="tool-proxy" />
        {robots.map(([robotId, links]) => (
          <RobotFrame key={robotId} robotId={robotId}>
            {[...links.entries()].map(([name, visuals]) => {
              const material = linkMaterials.get(linkKey(robotId, name));
              if (!material) return null;
              const pick = {
                kind: "instance" as const,
                path: robotId,
                link: name,
              };
              return (
                <group
                  key={name}
                  name={linkKey(robotId, name)}
                  userData={{ worldPick: pick }}
                  {...bindPick(pick)}
                  ref={(node) => {
                    const poseKey = linkKey(robotId, name);
                    const key = selectionKey(pick);
                    if (node) {
                      linkGroups.current.set(poseKey, node);
                      pickRoots.current.set(key, node);
                    } else {
                      linkGroups.current.delete(poseKey);
                      pickRoots.current.delete(key);
                    }
                  }}
                >
                  {visuals.map((visual, visualIndex) => (
                    <VisualOrigin
                      key={`${visual.link}:${visualIndex}`}
                      xyz={visual.xyz}
                      rpy={visual.rpy}
                    >
                      {visual.mesh?.kind === "stl" ? (
                        <mesh
                          geometry={visual.mesh.geometry}
                          material={material}
                          scale={visual.scale}
                        />
                      ) : visual.mesh?.kind === "obj" ? (
                        <ObjVisual
                          object={visual.mesh.object}
                          material={material}
                          scale={visual.scale}
                        />
                      ) : visual.primitive ? (
                        <PrimitiveMesh
                          primitive={visual.primitive}
                          material={material}
                        />
                      ) : null}
                    </VisualOrigin>
                  ))}
                </group>
              );
            })}
          </RobotFrame>
        ))}
        {primitives.map((primitive) =>
          primitive.pose ? (
            <Body key={primitive.id} pose={primitive.pose}>
              <group {...clearPick}>
                <PrimitiveMesh
                  primitive={primitive}
                  material={primitiveMaterial}
                />
              </group>
            </Body>
          ) : null
        )}
        {targets.map((target) => (
          <group
            key={target.id}
            name={linkKey(WORLD_TARGET_ROBOT, target.id)}
            position={target.pose.position}
            quaternion={[
              target.pose.rotation[1],
              target.pose.rotation[2],
              target.pose.rotation[3],
              target.pose.rotation[0],
            ]}
            ref={(node) => {
              const key = linkKey(WORLD_TARGET_ROBOT, target.id);
              if (node) linkGroups.current.set(key, node);
              else linkGroups.current.delete(key);
            }}
          >
            <PrimitiveMesh primitive={target} material={primitiveMaterial} />
          </group>
        ))}
        {doc.boards.map((board) => {
          const material = boardMaterials.get(board.id);
          if (!board.pose || !finiteVec(board.size, 3) || !material) {
            return null;
          }
          const pick = { kind: "instance" as const, path: board.id };
          return (
            <Body key={board.id} pose={board.pose} path={board.id}>
              <group
                userData={{ worldPick: pick }}
                {...bindPick(pick, true)}
                ref={(node) => {
                  const key = selectionKey(pick);
                  if (node) pickRoots.current.set(key, node);
                  else pickRoots.current.delete(key);
                }}
              >
                <mesh material={material}>
                  <boxGeometry args={board.size as WorldVec3} />
                </mesh>
                <BoardLabel
                  text={board.id}
                  color={theme.text}
                  z={board.size[2] / 2 + 0.008}
                />
              </group>
            </Body>
          );
        })}
        {doc.boxes.map((box) => {
          const material = partMaterials.get(box.id);
          if (!box.pose || !finiteVec(box.size, 3) || !material) return null;
          const pick = { kind: "instance" as const, path: box.id };
          return (
            <Body key={`${box.pick}:${box.id}`} pose={box.pose} path={box.id}>
              <group
                userData={{ worldPick: pick }}
                {...bindPick(pick, true)}
                ref={(node) => {
                  const key = selectionKey(pick);
                  if (node) pickRoots.current.set(key, node);
                  else pickRoots.current.delete(key);
                }}
              >
                <mesh material={material}>
                  <boxGeometry args={box.size} />
                </mesh>
                <BoardLabel
                  text={box.id}
                  color={theme.text}
                  z={box.size[2] / 2 + 0.008}
                />
              </group>
            </Body>
          );
        })}
        <WarningCallouts />
        <WireLayer bodies={portBodies} />
        <ProbeLayer bodies={portBodies} />
      </group>
      <WorldToolGizmo proxyRef={proxyRef} />
    </>
  );
}
