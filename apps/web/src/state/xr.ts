import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type Appearance, readDomAppearance } from "@/lib/appearance";

export type Page = "tree" | "settings" | "help";
/** Where the left-hand card lives: on the wrist, or anchored in the world. */
export type CardMode = "wrist" | "world";
export type XrSwitchTo = "ar" | "vr" | null;

type Setter = boolean | ((open: boolean) => boolean);
const resolve = (cur: boolean, next: Setter) =>
  typeof next === "function" ? next(cur) : next;

/**
 * Stream char count never lives in the store: it changes every token and
 * only drives the orb pulse in `useFrame`.
 */
let xrChatChars = 0;
export function getXrChatChars() {
  return xrChatChars;
}
export function setXrChatChars(n: number) {
  xrChatChars = n;
}

export type XrUiState = {
  page: Page;
  cardOpen: boolean;
  cardMode: CardMode;
  xrChatOpen: boolean;
  xrChatPhase: "idle" | "submitted" | "streaming";
  toolsOpen: boolean;
  appearance: Appearance;
  setPage: (page: Page) => void;
  setCardOpen: (open: Setter) => void;
  setCardMode: (mode: CardMode) => void;
  setXrChatOpen: (open: Setter) => void;
  setXrChatPhase: (phase: "idle" | "submitted" | "streaming") => void;
  /** Places the card in front of the wearer; used by the pin button. */
  bringCard: (() => void) | null;
  setBringCard: (fn: (() => void) | null) => void;
  bringChat: (() => void) | null;
  setBringChat: (fn: (() => void) | null) => void;
  /** True while the tree-card handle is being dragged. */
  cardDragging: boolean;
  setCardDragging: (on: boolean) => void;
  setToolsOpen: (open: Setter) => void;
  setAppearance: (appearance: Appearance) => void;
  left: boolean;
  right: boolean;
  leftHold: boolean;
  rightHold: boolean;
  worldGrabbing: boolean;
  setHandGrab: (side: "left" | "right", on: boolean) => void;
  setHandHold: (side: "left" | "right", on: boolean) => void;
  setWorldGrabbing: (on: boolean) => void;
  switching: XrSwitchTo;
  setXrSwitch: (next: XrSwitchTo) => void;
};

/**
 * Page, card, and hand state for the headset UI. The WebXR session from
 * `createXRStore` stays in `xrStore.ts`. Not persisted.
 */
export const xrUiStore = createStore<XrUiState>()((set, get) => ({
  page: "tree",
  cardOpen: true,
  cardMode: "world",
  xrChatOpen: false,
  xrChatPhase: "idle",
  toolsOpen: false,
  appearance: readDomAppearance(),
  setPage: (page) => set({ page }),
  setCardOpen: (open) => set((s) => ({ cardOpen: resolve(s.cardOpen, open) })),
  setCardMode: (cardMode) => set({ cardMode }),
  setXrChatOpen: (open) =>
    set((s) => ({ xrChatOpen: resolve(s.xrChatOpen, open) })),
  setXrChatPhase: (phase) => {
    if (get().xrChatPhase !== phase) set({ xrChatPhase: phase });
  },
  bringCard: null,
  setBringCard: (bringCard) => set({ bringCard }),
  bringChat: null,
  setBringChat: (bringChat) => set({ bringChat }),
  cardDragging: false,
  setCardDragging: (on) => {
    if (get().cardDragging !== on) set({ cardDragging: on });
  },
  setToolsOpen: (open) =>
    set((s) => ({ toolsOpen: resolve(s.toolsOpen, open) })),
  setAppearance: (appearance) => {
    if (get().appearance !== appearance) set({ appearance });
  },

  left: false,
  right: false,
  leftHold: false,
  rightHold: false,
  worldGrabbing: false,
  // XRGrab calls these every frame; skip unchanged values so listeners stay quiet.
  setHandGrab: (side, on) => {
    const key = side === "left" ? "left" : "right";
    if (get()[key] !== on) set({ [key]: on });
  },
  setHandHold: (side, on) => {
    const key = side === "left" ? "leftHold" : "rightHold";
    if (get()[key] !== on) set({ [key]: on });
  },
  setWorldGrabbing: (on) => {
    if (get().worldGrabbing !== on) set({ worldGrabbing: on });
  },

  switching: null,
  setXrSwitch: (switching) => set({ switching }),
}));

/** Always call with a selector: the whole state changes on every hand frame. */
export function useXrUi<T>(selector: (state: XrUiState) => T): T {
  return useZustandStore(xrUiStore, selector);
}
