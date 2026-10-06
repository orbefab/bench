import { ok as expect } from "node:assert/strict";
import {
  CHAT_DEFAULT_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  clampChatDrag,
  clampStoredChatWidth,
  detailPanelWidth,
  fitBelowInsets,
  fitBesideInsets,
  fitCardsReady,
  fitDistanceScale,
  fitInsets,
  fitPanNdc,
  OVERLAY_CLUSTER_GAP,
  OVERLAY_LEFT,
  OVERLAY_RIGHT,
  OVERLAY_TOP,
  overlayLayout,
  overlayMaxHeight,
  PART_TREE_WIDTH,
  preferredChatWidth,
  TOOLBAR_TOP,
  TOOLBAR_WIDTH,
  toolbarLayout,
  toolbarRightReserve,
  WORLD_FLOAT_RIGHT,
  WORLD_TOOLBAR_WIDTH,
} from "./layout";

expect(preferredChatWidth(100) === CHAT_MIN_WIDTH, "stored below min");
expect(preferredChatWidth(900) === CHAT_MAX_WIDTH, "stored above max");
expect(preferredChatWidth(384.4) === 384, "rounds");
expect(clampStoredChatWidth(720) === 720, "persist path keeps 720");
expect(clampStoredChatWidth(200) === 280, "persist path still has 280 floor");

expect(
  clampStoredChatWidth(720) === 720,
  "layout clamp does not rewrite stored 720"
);
expect(clampChatDrag(800) === CHAT_MAX_WIDTH, "drag stays within 720");
expect(clampChatDrag(200) === CHAT_MIN_WIDTH, "drag still has 280 floor");
expect(
  clampChatDrag(CHAT_DEFAULT_WIDTH) === CHAT_DEFAULT_WIDTH,
  "double-click default"
);

const overlaysWide = overlayLayout(800);
expect(
  overlaysWide.autoCollapseParts === false,
  "800 canvas keeps both overlays"
);
expect(overlaysWide.detailCompact === false, "800 is above detail compact");
const overlaysMid = overlayLayout(619);
expect(overlaysMid.autoCollapseParts, "below 620 chips PartTree");
expect(overlaysMid.detailCompact === false, "619 keeps Detail as a panel");
const overlaysTight = overlayLayout(479);
expect(overlaysTight.autoCollapseParts, "479 chips PartTree");
expect(overlaysTight.detailCompact, "below 480 Detail is compact");
expect(
  overlayLayout(0).autoCollapseParts === false,
  "unmeasured canvas does not collapse"
);

expect(overlayMaxHeight(600) === 600 - 64 - 24, "Electron min height 600");
expect(overlayMaxHeight(600) <= 512, "never above 32rem cap on short canvas");
expect(overlayMaxHeight(900) === 512, "tall canvas caps at 32rem");

expect(detailPanelWidth(800, false, false) === 260, "full Detail");
expect(detailPanelWidth(350, true, true) < 260, "compact Detail shrinks");
expect(
  detailPanelWidth(350, true, true) <= 350 - 16 - 12 - 12 - 96,
  "leaves the Model chip"
);

const insets = fitInsets({
  partsExpanded: true,
  partsChip: false,
  detailVisible: true,
  detailWidth: 260,
});
expect(insets.left === 12 + 280, "expanded tree inset");
expect(insets.right === 16 + 260, "detail inset");
expect(insets.top === 64, "toolbar row");
const chipInsets = fitInsets({
  partsExpanded: false,
  partsChip: true,
  detailVisible: true,
  detailWidth: 200,
});
expect(chipInsets.left === 12 + 96, "chip inset");
expect(chipInsets.right === 16 + 200, "compact detail inset");

expect(
  fitDistanceScale(752, 900, insets) > 1,
  "pull back when overlays eat the view"
);
expect(
  fitDistanceScale(800, 600, { left: 0, right: 0, top: 0, bottom: 0 }) === 1,
  "no inset is 1×"
);
const pan = fitPanNdc(800, 600, { left: 292, right: 16, top: 64, bottom: 24 });
expect(pan.x > 0, "tree on the left shifts remaining center right");
expect(pan.y < 0, "toolbar on top shifts remaining center down in NDC");

expect(
  fitCardsReady({
    partsExpanded: true,
    partsChip: false,
    detailVisible: true,
    partsHeight: 0,
    detailHeight: 165,
  }) === false,
  "wait for the tree height"
);
expect(
  fitCardsReady({
    partsExpanded: true,
    partsChip: false,
    detailVisible: true,
    partsHeight: 270,
    detailHeight: 165,
  }),
  "both cards measured"
);
expect(
  fitCardsReady({
    partsExpanded: true,
    partsChip: false,
    detailVisible: false,
    partsHeight: 270,
    detailHeight: 0,
  }),
  "no detail card is ready"
);

const qaBase = {
  partsExpanded: true,
  partsChip: false,
  detailVisible: false,
  detailWidth: 0,
  partsHeight: 270,
  detailHeight: 0,
  canvasWidth: 754,
  canvasHeight: 900,
};
const qaSelected = {
  ...qaBase,
  detailVisible: true,
  detailWidth: 260,
  detailHeight: 165,
};
const besideSelected = fitBesideInsets(qaSelected);
const belowSelected = fitBelowInsets(qaSelected);
expect(
  besideSelected.left === OVERLAY_LEFT + PART_TREE_WIDTH,
  "beside keeps the tree column"
);
expect(
  besideSelected.right === OVERLAY_RIGHT + 260,
  "beside keeps the detail column"
);
expect(
  belowSelected.left === OVERLAY_LEFT && belowSelected.right === OVERLAY_RIGHT,
  "below uses base side margins"
);
expect(
  belowSelected.top === OVERLAY_TOP + 270 + OVERLAY_CLUSTER_GAP,
  "below top is the lowest card + gap"
);
expect(
  fitDistanceScale(754, 900, belowSelected) <
    fitDistanceScale(754, 900, besideSelected),
  "below pulls back less than full-height columns when a part is selected"
);
const chosenSelected = fitInsets(qaSelected);
expect(
  chosenSelected.top === belowSelected.top,
  "selection Home uses the below rect"
);
expect(
  chosenSelected.left === OVERLAY_LEFT,
  "selection Home is not a 190px-wide column"
);
const chosenClear = fitInsets(qaBase);
const besideClear = fitBesideInsets(qaBase);
const clearScale = fitDistanceScale(754, 900, chosenClear);
expect(
  Math.abs(fitDistanceScale(754, 900, chosenSelected) - clearScale) < 0.05,
  "Home with a selection is about the same size as with none"
);
expect(
  clearScale <= fitDistanceScale(754, 900, besideClear) + 1e-12,
  "clear selection is unchanged or better than area-6 beside"
);
expect(
  fitInsets({ ...qaSelected, partsHeight: 0, detailHeight: 0 }).left ===
    besideSelected.left,
  "unmeasured cards stay beside so settledFit does not jump"
);
expect(
  fitInsets({ ...qaSelected, canvasWidth: 0 }).left === besideSelected.left,
  "unknown canvas stays beside (legacy fitInsets)"
);
const tallTree = fitInsets({ ...qaBase, partsHeight: 512 });
expect(
  tallTree.left === besideClear.left,
  "a tall tree keeps beside so load does not worsen"
);
const selectedPan = fitPanNdc(754, 900, chosenSelected);
const belowPan = fitPanNdc(754, 900, belowSelected);
expect(
  selectedPan.x === belowPan.x && selectedPan.y === belowPan.y,
  "pan uses the same free rect"
);

const roomy = toolbarLayout({
  canvasWidth: 752,
  leftReserve: 12,
  rightReserve: 48,
});
expect(roomy.stacked === false, "wide canvas keeps toolbar on the top row");
expect(roomy.top === TOOLBAR_TOP, "top-4");
const squeezed = toolbarLayout({
  canvasWidth: 210,
  leftReserve: 48,
  rightReserve: 48,
});
expect(squeezed.stacked, "tiny canvas offsets the toolbar");
expect(squeezed.top === TOOLBAR_TOP, "stays on the top row, not over PartTree");
expect(squeezed.left >= 12, "offset toolbar stays on the canvas");

expect(WORLD_TOOLBAR_WIDTH === 240, "world bar is home plus five tools");
expect(WORLD_FLOAT_RIGHT === 332, "float column ends at left-3 plus w-80");
const worldFree = toolbarLayout({
  canvasWidth: 900,
  leftReserve: WORLD_FLOAT_RIGHT,
  rightReserve: 12,
  barWidth: WORLD_TOOLBAR_WIDTH,
});
const worldGap = 900 - WORLD_FLOAT_RIGHT - 12;
expect(
  worldFree.stacked === false,
  "900px stage keeps the bar beside the tree"
);
expect(
  worldFree.left === WORLD_FLOAT_RIGHT + (worldGap - WORLD_TOOLBAR_WIDTH) / 2,
  "world bar centers in the free rect"
);
expect(
  worldFree.left >= WORLD_FLOAT_RIGHT,
  "world bar starts to the right of the column"
);
expect(
  worldFree.left + WORLD_TOOLBAR_WIDTH <= 900 - 12,
  "world bar ends before the right reserve"
);
const dockedViewer = toolbarLayout({
  canvasWidth: 640,
  leftReserve: WORLD_FLOAT_RIGHT,
  rightReserve: toolbarRightReserve(false, false),
  barWidth: WORLD_TOOLBAR_WIDTH,
});
expect(
  dockedViewer.stacked === false,
  "a 640px docked viewer still clears the tree"
);
expect(
  dockedViewer.left >= WORLD_FLOAT_RIGHT,
  "docked bar stays to the right of the column"
);
const worldTight = toolbarLayout({
  canvasWidth: 520,
  leftReserve: WORLD_FLOAT_RIGHT,
  rightReserve: 12,
  barWidth: WORLD_TOOLBAR_WIDTH,
});
expect(worldTight.stacked, "a stage narrower than the bar drops the column");
expect(worldTight.top === TOOLBAR_TOP, "the bar stays on the top row");
const cadDefault = toolbarLayout({
  canvasWidth: 752,
  leftReserve: OVERLAY_LEFT,
  rightReserve: 48,
});
expect(
  cadDefault.left ===
    OVERLAY_LEFT + (752 - OVERLAY_LEFT - 48 - TOOLBAR_WIDTH) / 2,
  "omitted bar width is the CAD bar"
);

expect(toolbarRightReserve(false, false) === 12, "padding only");
expect(toolbarRightReserve(true, false) === 12 + 44, "chat toggle");
expect(toolbarRightReserve(false, true) === 12 + 140, "Enter Studio");
expect(toolbarRightReserve(true, true) === 12 + 140 + 44 + 8, "both plus gap");
expect(toolbarRightReserve(true, false, true) === 12 + 220, "live chip");
expect(
  toolbarRightReserve(true, true, true) === 12 + 140 + 220 + 8,
  "live chip plus Enter Studio"
);

console.log("layout.selfcheck ok");
