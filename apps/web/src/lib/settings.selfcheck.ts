import { ok as expect } from "node:assert/strict";
import {
  applyTextSize,
  formatDebugReport,
  harnessStatusLabel,
  parseTextSize,
  textSizeScale,
} from "./settings";

expect(parseTextSize("small") === "small", "small size");
expect(parseTextSize("large") === "large", "large size");
expect(parseTextSize("huge") === "default", "unknown size");
expect(textSizeScale("small") === "0.875", "small scale");
expect(textSizeScale("default") === "1", "default scale");
expect(textSizeScale("large") === "1.125", "large scale");

const calls: string[][] = [];
const root = {
  style: {
    setProperty(name: string, value: string) {
      calls.push([name, value]);
    },
    removeProperty(name: string) {
      calls.push(["remove", name]);
    },
  },
};
applyTextSize(root, "large");
expect(
  calls.some((c) => c[0] === "--ui-text-scale" && c[1] === "1.125"),
  "large writes chrome scale"
);
applyTextSize(root, "default");
expect(
  calls.some((c) => c[0] === "remove" && c[1] === "--ui-text-scale"),
  "default clears chrome scale"
);

expect(harnessStatusLabel("ready") === "Ready", "ready label");
expect(harnessStatusLabel("needs-auth") === "Needs login", "auth label");
expect(harnessStatusLabel("missing-cli") === "CLI missing", "cli label");

const report = formatDebugReport({
  appName: "sfab-bench",
  version: "0.1.1",
  userAgent: "Mozilla/5.0",
  principalKind: "loopback",
  folderName: "cad",
  fileBasename: "bracket.step",
  projectPath: "/Users/you/proj",
  harnesses: [
    { label: "Codex", status: "needs-auth" },
    { label: "OpenCode", status: "ready" },
  ],
  theme: "system",
  textSize: "large",
  loadError:
    "tessellating /Users/you/proj/cad/bracket.step took longer than 300000ms",
});
expect(report.includes("sfab-bench 0.1.1"), "app + version");
expect(report.includes("Principal: loopback"), "kind only");
expect(report.includes("Folder: cad"), "folder name");
expect(report.includes("File: bracket.step"), "file basename");
expect(report.includes("Codex: Needs login"), "harness status text");
expect(report.includes("OpenCode: Ready"), "ready harness");
expect(report.includes("Theme: system"), "theme");
expect(report.includes("Contrast:") === false, "contrast dropped");
expect(report.includes("Text size: large"), "text size");
expect(report.includes("<project>/cad/bracket.step"), "load error redacted");
expect(report.includes("/Users/") === false, "no home path");
expect(report.includes("Quest-Living-Room") === false, "no device names");

const empty = formatDebugReport({
  appName: "sfab-bench",
  version: "0.1.1",
  userAgent: "Mozilla/5.0",
  principalKind: "paired",
  folderName: null,
  fileBasename: "",
  harnesses: [],
  theme: "dark",
  textSize: "default",
  loadError: null,
});
expect(empty.includes("Principal: paired"), "paired kind");
expect(empty.includes("Folder: (none)"), "no folder");
expect(empty.includes("File: (none)"), "no file");
expect(empty.includes("Last load error: (none)"), "no error");
expect(empty.includes("  (none)"), "no harnesses");

console.log("settings.selfcheck ok");
