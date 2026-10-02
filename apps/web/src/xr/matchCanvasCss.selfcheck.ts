import { ok as expect } from "node:assert/strict";
import { matchCanvasCssToBuffer } from "./matchCanvasCss";

const pane = {
  width: 1440,
  height: 900,
  style: { width: "640px", height: "820px" },
};
matchCanvasCssToBuffer(pane);
expect(pane.style.width === "1440px", "css width follows buffer");
expect(pane.style.height === "900px", "css height follows buffer");

const empty = {
  width: 0,
  height: 0,
  style: { width: "640px", height: "820px" },
};
matchCanvasCssToBuffer(empty);
expect(empty.style.width === "640px", "skip empty buffer width");
expect(empty.style.height === "820px", "skip empty buffer height");

console.log("matchCanvasCss.selfcheck ok");
