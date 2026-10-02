import { createXRStore } from "@react-three/xr";

import { xrUiStore } from "@/state/xr";
import {
  forceIwerRuntimeIfNative,
  shouldForceIwerOnThisPage,
} from "@/xr/devIwer";
import { matchCanvasCssToBuffer } from "@/xr/matchCanvasCss";

/** The subset of `@pmndrs/pointer-events` `Pointer` the opacity callbacks read. */
type PointerLike = { getButtonsDown(): { size: number } };

// Fixed foveated rendering: 0 = off (sharpest edges, most GPU cost), 1 = max
// (cheapest, most peripheral blur). 0.5 is a starting point to be judged on
// the headset; raise it if the frame rate is the bottleneck, lower it if the
// blur is distracting, by editing this constant.
const FOVEATION = 0.5;

const forceIwer =
  typeof window !== "undefined" &&
  shouldForceIwerOnThisPage(window.location.hostname, import.meta.env.DEV);

export const xrStore = createXRStore({
  foveation: FOVEATION,
  offerSession: false,
  bounded: true,
  hitTest: false,
  domOverlay: false,
  anchors: false,
  meshDetection: false,
  planeDetection: false,
  depthSensing: false,
  bodyTracking: false,
  handTracking: true,
  // Default inject hostname is `localhost`; the Mac tab is 127.0.0.1.
  emulate: forceIwer ? { inject: true } : undefined,
});

if (forceIwer) {
  const apply = () => {
    forceIwerRuntimeIfNative(xrStore.getState().emulator);
  };
  apply();
  xrStore.subscribe((state, prev) => {
    if (state.emulator && state.emulator !== prev.emulator) apply();
  });
}

// The library lifts its flat cursor disc 10 mm off the surface by default
// (cursorOffset), which reads as floating on a 20 cm model viewed at arm's
// length. 1 mm is enough: the cursor material does not write depth, so it
// cannot z-fight. Sizes are smaller than the default to read as a mark on the
// surface rather than a plate.
const CURSOR_OFFSET = 0.001;

// Opacity is a function so the ray and cursor brighten while the trigger or
// pinch is held (the library default does this; a fixed number loses it) and
// vanish while a hand or controller is moving the model, when a pinch would
// otherwise still select a part. Idle values match the previous fixed ones.
const fade =
  (idle: number) =>
  (pointer: PointerLike): number => {
    if (xrUiStore.getState().worldGrabbing) return 0;
    return pointer.getButtonsDown().size > 0 ? 1 : idle;
  };

const rightRay = {
  minDistance: 0.02,
  rayModel: { opacity: fade(0.55), color: "#e4e4e7" },
  cursorModel: {
    opacity: fade(0.9),
    size: 0.006,
    color: "#2563eb",
    cursorOffset: CURSOR_OFFSET,
  },
};

const hands = {
  model: false,
  grabPointer: false,
  touchPointer: false,
  rayPointer: {
    minDistance: 0.02,
    rayModel: { opacity: fade(0.4), color: "#e4e4e7", maxLength: 1.2 },
    cursorModel: {
      opacity: fade(0.85),
      size: 0.005,
      color: "#2563eb",
      cursorOffset: CURSOR_OFFSET,
    },
  },
} as const;

function applyARInput() {
  xrStore.setController(
    { model: false, rayPointer: false, grabPointer: false },
    "left"
  );
  xrStore.setController(
    { model: false, rayPointer: rightRay, grabPointer: false },
    "right"
  );
  xrStore.setHand(hands, "left");
  xrStore.setHand(hands, "right");
}

function applyVRInput() {
  xrStore.setController(
    { model: true, rayPointer: false, grabPointer: false },
    "left"
  );
  xrStore.setController(
    { model: true, rayPointer: rightRay, grabPointer: false },
    "right"
  );
  xrStore.setHand(hands, "left");
  xrStore.setHand(hands, "right");
}

let previewCanvas: { style: { width: string; height: string } } | null = null;

function unsquashEmulatorPreview() {
  const apply = () => {
    const canvas = xrStore.getState().emulator?.appCanvas;
    if (!canvas || !("style" in canvas)) return false;
    if (canvas.width < 1 || canvas.height < 1) return false;
    previewCanvas = canvas;
    matchCanvasCssToBuffer(canvas);
    return true;
  };
  // IWER assigns appCanvas in onBaseLayerSet, which can land after enterVR resolves.
  if (apply()) return;
  requestAnimationFrame(() => {
    if (apply()) return;
    requestAnimationFrame(() => {
      apply();
    });
  });
}

function restorePreviewCss() {
  if (!previewCanvas) return;
  previewCanvas.style.width = "";
  previewCanvas.style.height = "";
  previewCanvas = null;
}

xrStore.subscribe((state, prev) => {
  if (prev.session && !state.session) restorePreviewCss();
});

async function swapSession(next: "immersive-ar" | "immersive-vr") {
  const { session, mode } = xrStore.getState();
  if (session && mode === next) return session;
  if (session) {
    xrUiStore.getState().setXrSwitch(next === "immersive-ar" ? "ar" : "vr");
    try {
      await session.end();
      const nextSession = await (next === "immersive-ar"
        ? xrStore.enterAR()
        : xrStore.enterVR());
      unsquashEmulatorPreview();
      return nextSession;
    } finally {
      xrUiStore.getState().setXrSwitch(null);
    }
  }
  const started = await (next === "immersive-ar"
    ? xrStore.enterAR()
    : xrStore.enterVR());
  unsquashEmulatorPreview();
  return started;
}

export function enterAR() {
  applyARInput();
  return swapSession("immersive-ar");
}

export function enterVR() {
  applyVRInput();
  return swapSession("immersive-vr");
}
