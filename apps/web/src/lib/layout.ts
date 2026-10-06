/**
 * Desktop layout math for the Mac tab / Electron window.
 * The floating composer's width is the stored size, 280–720.
 * Docked chat is a resizable panel and does not use this width.
 */

export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;
export const CHAT_DEFAULT_WIDTH = 384;

export const PART_TREE_WIDTH = 280;
export const PART_TREE_CHIP_WIDTH = 96;
export const DETAIL_WIDTH = 260;
export const OVERLAY_LEFT = 12;
export const OVERLAY_RIGHT = 16;
export const OVERLAY_TOP = 64;
export const OVERLAY_BOTTOM = 24;
/** PartTree 280 + Detail 260 + ~80px of gaps/margins. */
export const OVERLAY_BOTH_THRESHOLD = 620;
export const DETAIL_COMPACT_THRESHOLD = 480;
export const OVERLAY_MAX_HEIGHT_CAP = 32 * 16;
/** Five 36px tools + gap-0.5 + p-1 + border (~198 measured). */
export const TOOLBAR_WIDTH = 198;
/**
 * World bar: Home 36 + gap-0.5 + tools `mx-0.5` + five 36px tools + four
 * gaps + `p-1` + border. Wider than the CAD bar.
 */
export const WORLD_TOOLBAR_WIDTH = 240;
/** World float column: `left-3` (12) + `w-80` (320). */
export const WORLD_FLOAT_RIGHT = 12 + 320;
export const TOOLBAR_TOP = 16;
export const CHAT_TOGGLE_RESERVE = 44;
/** Hidden-chat "Replying… · Stop · Show chat" chip. */
export const CHAT_LIVE_CHIP_RESERVE = 220;
/** "Enter Studio" pill + wrapper padding/border. */
export const ENTER_XR_RESERVE = 140;
export const OVERLAY_CLUSTER_GAP = 8;

export type FitInsets = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const ZERO_INSETS: FitInsets = { left: 0, right: 0, top: 0, bottom: 0 };

let liveFitInsets: FitInsets = {
  ...ZERO_INSETS,
  left: OVERLAY_LEFT,
  right: OVERLAY_RIGHT,
  top: OVERLAY_TOP,
  bottom: OVERLAY_BOTTOM,
};

export function setLiveFitInsets(next: FitInsets) {
  liveFitInsets = next;
}

export function getLiveFitInsets(): FitInsets {
  return liveFitInsets;
}

export function preferredChatWidth(stored: number): number {
  if (!Number.isFinite(stored)) return CHAT_DEFAULT_WIDTH;
  return Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, Math.round(stored)));
}

/** Persist-path clamp: 280–720 only. Window floors are layout, not storage. */
export function clampStoredChatWidth(n: number): number {
  return preferredChatWidth(n);
}

/** Drag / double-click: this value is what we persist. */
export function clampChatDrag(width: number): number {
  return preferredChatWidth(width);
}

export const CHAT_RESIZE_STEP = 16;
export const CHAT_RESIZE_STEP_LARGE = 64;

/**
 * Keyboard resize for the chat separator. ArrowLeft grows the rail (handle is
 * on the left edge); ArrowRight shrinks. Same clamp as dragging.
 */
export function chatWidthAfterKey(
  key: string,
  shiftKey: boolean,
  current: number
): number | null {
  const clamp = (width: number) => clampChatDrag(width);
  if (key === "Home") return clamp(CHAT_MIN_WIDTH);
  if (key === "End") return clamp(CHAT_MAX_WIDTH);
  const step = shiftKey ? CHAT_RESIZE_STEP_LARGE : CHAT_RESIZE_STEP;
  if (key === "ArrowLeft") return clamp(current + step);
  if (key === "ArrowRight") return clamp(current - step);
  return null;
}

export function overlayLayout(canvasWidth: number): {
  autoCollapseParts: boolean;
  detailCompact: boolean;
} {
  return {
    autoCollapseParts: canvasWidth > 0 && canvasWidth < OVERLAY_BOTH_THRESHOLD,
    detailCompact: canvasWidth > 0 && canvasWidth < DETAIL_COMPACT_THRESHOLD,
  };
}

export function overlayMaxHeight(canvasHeight: number): number {
  if (canvasHeight <= 0) return OVERLAY_MAX_HEIGHT_CAP;
  return Math.max(
    120,
    Math.min(
      OVERLAY_MAX_HEIGHT_CAP,
      canvasHeight - OVERLAY_TOP - OVERLAY_BOTTOM
    )
  );
}

export function detailPanelWidth(
  canvasWidth: number,
  compact: boolean,
  partsChip: boolean
): number {
  if (!compact) return DETAIL_WIDTH;
  const chip = partsChip ? OVERLAY_LEFT + PART_TREE_CHIP_WIDTH : 0;
  return Math.max(
    160,
    Math.min(DETAIL_WIDTH, canvasWidth - OVERLAY_RIGHT - 12 - chip)
  );
}

export type FitInsetInput = {
  partsExpanded: boolean;
  partsChip: boolean;
  detailVisible: boolean;
  detailWidth: number;
  /** Measured card heights (0 when unmounted). Chip uses its real height. */
  partsHeight?: number;
  detailHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
};

/** True once every visible overlay card has a measured height. */
export function fitCardsReady(input: {
  partsExpanded: boolean;
  partsChip: boolean;
  detailVisible: boolean;
  partsHeight: number;
  detailHeight: number;
}): boolean {
  if ((input.partsExpanded || input.partsChip) && input.partsHeight <= 0)
    return false;
  if (input.detailVisible && input.detailHeight <= 0) return false;
  return true;
}

/** Treat PartTree / Detail as full-height side columns (area 6). */
export function fitBesideInsets(input: FitInsetInput): FitInsets {
  const left = input.partsExpanded
    ? OVERLAY_LEFT + PART_TREE_WIDTH
    : input.partsChip
      ? OVERLAY_LEFT + PART_TREE_CHIP_WIDTH
      : OVERLAY_LEFT;
  const right = input.detailVisible
    ? OVERLAY_RIGHT + input.detailWidth
    : OVERLAY_RIGHT;
  return { left, right, top: OVERLAY_TOP, bottom: OVERLAY_BOTTOM };
}

/**
 * Free rect under the floating cards: base side margins, top = lowest card
 * bottom + cluster gap. Cards sit at OVERLAY_TOP (`top-16`).
 */
export function fitBelowInsets(input: FitInsetInput): FitInsets {
  const cardH = Math.max(input.partsHeight ?? 0, input.detailHeight ?? 0);
  const top =
    cardH > 0 ? OVERLAY_TOP + cardH + OVERLAY_CLUSTER_GAP : OVERLAY_TOP;
  return {
    left: OVERLAY_LEFT,
    right: OVERLAY_RIGHT,
    top,
    bottom: OVERLAY_BOTTOM,
  };
}

/**
 * Pick the free rect with the smaller pull-back. Tie (or unmeasured cards /
 * unknown canvas) → beside, so a fresh load with no detail card stays the
 * area-6 pose or only improves.
 */
export function fitInsets(input: FitInsetInput): FitInsets {
  const beside = fitBesideInsets(input);
  const w = input.canvasWidth ?? 0;
  const h = input.canvasHeight ?? 0;
  if (w < 2 || h < 2) return beside;
  if (
    !fitCardsReady({
      partsExpanded: input.partsExpanded,
      partsChip: input.partsChip,
      detailVisible: input.detailVisible,
      partsHeight: input.partsHeight ?? 0,
      detailHeight: input.detailHeight ?? 0,
    })
  ) {
    return beside;
  }
  const below = fitBelowInsets(input);
  const besideScale = fitDistanceScale(w, h, beside);
  const belowScale = fitDistanceScale(w, h, below);
  return belowScale < besideScale ? below : beside;
}

/** Pull the camera back so the sphere fits in the inset rectangle. */
export function fitDistanceScale(
  canvasWidth: number,
  canvasHeight: number,
  insets: FitInsets
): number {
  const availW = Math.max(1, canvasWidth - insets.left - insets.right);
  const availH = Math.max(1, canvasHeight - insets.top - insets.bottom);
  return Math.max(canvasWidth / availW, canvasHeight / availH, 1);
}

/**
 * Remaining-rect center in NDC. Applied as a camera+target pan so the model
 * sits in the uncovered canvas, not under PartTree/Detail.
 */
export function fitPanNdc(
  canvasWidth: number,
  canvasHeight: number,
  insets: FitInsets
): { x: number; y: number } {
  return {
    x: (insets.left - insets.right) / Math.max(1, canvasWidth),
    y: (insets.bottom - insets.top) / Math.max(1, canvasHeight),
  };
}

export function toolbarLayout(input: {
  canvasWidth: number;
  leftReserve: number;
  rightReserve: number;
  /** Defaults to the CAD bar. Pass the world bar when that one is on screen. */
  barWidth?: number;
}): { stacked: boolean; left: number; top: number } {
  const { canvasWidth, leftReserve, rightReserve } = input;
  const barWidth = input.barWidth ?? TOOLBAR_WIDTH;
  const remaining = canvasWidth - leftReserve - rightReserve;
  if (remaining >= barWidth + 8) {
    return {
      stacked: false,
      left: leftReserve + (remaining - barWidth) / 2,
      top: TOOLBAR_TOP,
    };
  }
  const maxLeft = Math.max(12, canvasWidth - barWidth - 12);
  return {
    stacked: true,
    left: Math.max(12, Math.min(leftReserve, maxLeft)),
    top: TOOLBAR_TOP,
  };
}

export function toolbarRightReserve(
  chatToggle: boolean,
  enterXr: boolean,
  liveChip = false
): number {
  let n = 12;
  if (enterXr) n += ENTER_XR_RESERVE;
  if (chatToggle) n += liveChip ? CHAT_LIVE_CHIP_RESERVE : CHAT_TOGGLE_RESERVE;
  if (enterXr && chatToggle) n += OVERLAY_CLUSTER_GAP;
  return n;
}
