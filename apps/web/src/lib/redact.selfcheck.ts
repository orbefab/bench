import { ok as expect } from "node:assert/strict";
import {
  APP_VERSION,
  crashCardReason,
  formatCrashReport,
} from "./crash-report";
import {
  displayLoadError,
  friendlyLoadReason,
  isUnavailableFolder,
  loadCardCopy,
  messageFromHttpBody,
} from "./load-copy";
import { redact, redactHomePaths, redactProjectPrefix } from "./redact";

expect(
  redactHomePaths("/Users/you/cad/part.step") === "~/cad/part.step",
  "Users home"
);
expect(
  redactHomePaths("/home/you/cad/part.step") === "~/cad/part.step",
  "linux home"
);
expect(
  redactHomePaths("file:///Users/you/cad/part.step") ===
    "file://~/cad/part.step",
  "file url"
);
expect(
  redactHomePaths("C:\\Users\\you\\cad\\part.step") === "~\\cad\\part.step",
  "windows backslash"
);
expect(
  redactHomePaths("C:/Users/you/cad/part.step") === "~/cad/part.step",
  "windows forward"
);
expect(
  redactHomePaths("D:\\Users\\you\\a.step") === "~\\a.step",
  "other drive"
);
expect(
  redactHomePaths("file:///C:/Users/you/cad/part.step") ===
    "file://~/cad/part.step",
  "windows file url"
);
expect(
  redactHomePaths("file:///d:/Users/you/a.step") === "file://~/a.step",
  "windows file url other drive"
);
expect(
  redactHomePaths("Users of this Mac stay") === "Users of this Mac stay",
  "plain Users"
);
expect(
  redactHomePaths("saved on the C: drive") === "saved on the C: drive",
  "drive letter only"
);
expect(
  redactHomePaths("D:\\Projects\\cad\\a.step") === "D:\\Projects\\cad\\a.step",
  "non-home windows path"
);
expect(
  redact("tessellating /Users/you/cad/part.step took longer than 300000ms") ===
    "tessellating ~/cad/part.step took longer than 300000ms",
  "occt timeout"
);
expect(
  redactProjectPrefix("/Users/you/proj/cad/a.step", "/Users/you/proj") ===
    "<project>/cad/a.step",
  "project prefix"
);
expect(
  redact("/Users/you/proj/cad/a.step", "/Users/you/proj") ===
    "<project>/cad/a.step",
  "project wins over home"
);
expect(
  redact("no file at missing.step", "/Users/you/proj") ===
    "no file at missing.step",
  "relative stays"
);

expect(
  messageFromHttpBody('{"error":"not a directory: /Users/you/nope"}') ===
    "not a directory: /Users/you/nope",
  "json error"
);
expect(
  messageFromHttpBody("<!DOCTYPE html><html>404</html>", "missing") ===
    "missing",
  "html 404"
);
expect(
  friendlyLoadReason("<!DOCTYPE html><html>404</html>") ===
    "Could not load this file",
  "html never on card"
);
expect(
  displayLoadError("<html>not found</html>") === "Could not load this file",
  "html through display"
);
expect(
  isUnavailableFolder("not a directory: /Users/you/nope"),
  "not a directory"
);
expect(isUnavailableFolder("the project folder is gone"), "gone folder");
expect(
  isUnavailableFolder('{"error":"not a directory: /abs/path"}'),
  "json not a directory"
);
expect(
  isUnavailableFolder("no file at a.step") === false,
  "missing file is not a folder"
);

expect(
  friendlyLoadReason("STEP could not be read (status 3)") ===
    "This file isn't a valid STEP",
  "occt 3"
);
expect(
  friendlyLoadReason("STEP could not be read (status 2)") ===
    "This file isn't a valid STEP",
  "occt 2"
);
expect(
  friendlyLoadReason("STEP could not be read (status 4)") ===
    "STEP could not be read",
  "occt other"
);
expect(
  friendlyLoadReason("not a STEP or GLB: notes.md") ===
    "Not a STEP or GLB file",
  "typed extension"
);
expect(
  friendlyLoadReason("not a directory: /Users/you/nope") ===
    "This folder isn't available",
  "missing folder copy"
);
expect(
  displayLoadError(
    "tessellating /Users/you/cad/part.step took longer than 300000ms"
  ) === "tessellating ~/cad/part.step took longer than 300000ms",
  "timeout through display"
);
expect(
  displayLoadError("not a directory: /Users/you/proj", "/Users/you/proj") ===
    "This folder isn't available",
  "folder card has no abs path"
);

const cold = loadCardCopy({
  title: "bracket.step",
  url: "cad/bracket.step",
  progress: 0,
});
expect(cold.percent === null, "no percent at 0");
expect(cold.detail.includes("0%") === false, "copy never says 0%");
expect(cold.title === "bracket.step", "names the file");
expect(cold.detail.includes("Meshing on this Mac"), "honest mesh wait");

const glb = loadCardCopy({ title: "part.glb", url: "part.glb", progress: 0 });
expect(glb.detail === "Preparing part.glb…", "glb preparing");
expect(glb.percent === null, "glb has no fake bar");

const warm = loadCardCopy({
  title: "bracket.step",
  url: "cad/bracket.step",
  progress: 40,
});
expect(warm.percent === 40, "percent only when > 0");
expect(warm.detail === "Downloading meshes… 40%", "tess download label");

const report = formatCrashReport({
  pathname: "/?project=/Users/you/proj&file=cad/a.step",
  time: "2026-09-15T00:00:00.000Z",
  error: new Error(
    "tessellating /Users/you/cad/part.step took longer than 300000ms"
  ),
  projectPath: "/Users/you/proj",
});
expect(report.includes(`sfab-bench ${APP_VERSION}`), "app + version");
expect(report.includes("Path: /"), "pathname only");
expect(report.includes("?project=") === false, "no query");
expect(report.includes("/Users/") === false, "no Users dir");
expect(report.includes("/home/") === false, "no home dir");
expect(report.includes("2026-09-15T00:00:00.000Z"), "iso time");
expect(report.includes("~/cad/part.step"), "stack redacted");

const cardErr = new Error(
  "tessellating /Users/you/cad/part.step took longer than 300000ms"
);
const cardReason = crashCardReason(cardErr);
expect(
  cardReason === "tessellating ~/cad/part.step took longer than 300000ms",
  "card is redacted message"
);
expect(cardReason.includes("\n") === false, "card reason is one line");
expect(
  (cardErr.stack ?? "").length > cardErr.message.length,
  "stack stays off the card"
);
expect(
  crashCardReason(new Error("failed at C:\\Users\\you\\cad\\a.step")) ===
    "failed at ~\\cad\\a.step",
  "card redacts windows home"
);

console.log("redact.selfcheck ok");
