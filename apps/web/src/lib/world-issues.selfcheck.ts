import {
  commandNotice,
  formatSimTime,
  formatWorldIssues,
  formatXrErrorLine,
  formatXrIssueLine,
  isOwnCommandNonce,
  visibleAssetIssues,
} from "./world-issues";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const lines = formatWorldIssues([
  {
    code: "missing-file",
    path: "robots[0].urdf",
    message:
      "URDF is missing. Hint: export STL with $cad (`cadgen stl build`).",
  },
  {
    code: "schema",
    path: "boards[0].size",
    message: "Size needs three lengths.",
  },
]);
expect(lines.length === 2, "one line per error");
expect(lines[0]?.code === "missing-file", "code");
expect(lines[0]?.path === "robots[0].urdf", "path");
expect(lines[0]?.message === "URDF is missing.", "message drops the hint");
expect(
  lines[0]?.hint === "export STL with $cad (`cadgen stl build`).",
  "hint text"
);
expect(lines[1]?.hint === "", "no hint stays empty");
expect(lines[1]?.message === "Size needs three lengths.", "plain message");

const fallback = formatWorldIssues([], "could not open this world");
expect(fallback.length === 1, "a message with no rows still shows");
expect(fallback[0]?.code === "error", "fallback code");
expect(
  fallback[0]?.message === "could not open this world",
  "fallback message"
);
expect(formatWorldIssues([], "  ").length === 0, "blank fallback is hidden");
expect(formatWorldIssues([]).length === 0, "nothing to show");

expect(formatSimTime(12.345) === "12.345 s", "sim time");
expect(formatSimTime(0) === "0.000 s", "zero sim time");
expect(formatSimTime(Number.NaN) === "0.000 s", "bad sim time");

expect(
  commandNotice("pause", { kind: "paired", label: "Headset A" }) ===
    "Paused by Headset A",
  "paired pause"
);
expect(
  commandNotice("play", { kind: "agent" }) === "Played by agent",
  "agent play"
);
expect(
  commandNotice("pause", { kind: "loopback", label: "Mac" }) ===
    "Paused by Mac",
  "mac pause"
);
expect(
  commandNotice("play", { kind: "paired", label: "Quest" }) ===
    "Played by Quest",
  "paired play uses the device label"
);
expect(
  commandNotice("pause", { kind: "paired", label: "" }) === "Paused by someone",
  "a paired sender with no label"
);

const xrLine = formatXrErrorLine([
  {
    code: "missing-file",
    path: "robots[0].urdf",
    message:
      "URDF is missing. Hint: export STL with $cad (`cadgen stl build`).",
  },
  {
    code: "schema",
    path: "boards[0].size",
    message: "Size needs three lengths.",
  },
  {
    code: "wires",
    path: "wires[0]",
    message: "Missing ground.",
  },
]);
expect(
  xrLine === "missing-file: URDF is missing. (+2 more)",
  "headset line keeps the first code and message, and counts the rest"
);
expect(!xrLine.includes("Hint:"), "headset line drops the hint");
expect(!xrLine.includes("robots[0]"), "headset line drops the path");
expect(
  formatXrErrorLine([
    {
      code: "schema",
      path: "boards[0].size",
      message: "Size needs three lengths.",
    },
  ]) === "schema: Size needs three lengths.",
  "a single error has no count"
);
expect(
  formatXrErrorLine([], "could not open this world") ===
    "error: could not open this world",
  "a message with no rows still has a line"
);
expect(formatXrErrorLine([], "  ") === "", "a blank fallback has no line");
expect(formatXrErrorLine([]) === "", "no errors has no line");

const mixedErrors = [
  {
    code: "schema",
    path: "boards[0].size",
    message: "Size needs three lengths.",
  },
];
const mixedAssets = visibleAssetIssues(
  [{ text: "could not load the URDF" }],
  mixedErrors
);
expect(
  formatXrIssueLine(mixedErrors, mixedAssets) ===
    "schema: Size needs three lengths. (+1 more)",
  "a validator error and a non-mesh asset issue count together"
);

const meshLine = {
  text: "examples/arm/robot/meshes/foo.dae is not an STL or OBJ mesh",
  mesh: "meshes/foo.dae",
};
const validator = [
  {
    message:
      'Mesh "meshes/foo.dae" is not .stl or .obj. Hint: export STL with $cad (`cadgen stl build`).',
  },
];
expect(
  visibleAssetIssues([meshLine], validator).length === 0,
  "validator mesh error hides the client line"
);
expect(
  visibleAssetIssues([meshLine], []).length === 1,
  "client mesh error stays when the server reports none"
);
expect(
  visibleAssetIssues(
    [{ text: "meshes/bar.stl missing", mesh: "meshes/bar.stl" }],
    validator
  ).length === 1,
  "a different mesh is still shown"
);
expect(
  visibleAssetIssues([{ text: "could not load the URDF" }], validator)
    .length === 1,
  "a non-mesh client error stays beside validator errors"
);
expect(
  visibleAssetIssues(
    [{ text: "World v1 is no longer supported" }],
    [
      {
        message:
          "World v1 is no longer supported. Hint: write a version 2 world.",
      },
    ]
  ).length === 0,
  "a summary that repeats the schema line is hidden"
);

const sent = new Set(["tab-a"]);
expect(isOwnCommandNonce("tab-a", sent), "echo of this tab's nonce");
expect(!isOwnCommandNonce("tab-b", sent), "another client's nonce");
expect(!isOwnCommandNonce(undefined, sent), "an agent command has no nonce");

console.log("world-issues.selfcheck ok");
