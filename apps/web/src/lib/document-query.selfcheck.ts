import { applyOpenDocument, readOpenDocument } from "./document-query";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const fileOnly = new URLSearchParams("project=/abs/path&file=cad/a.step");
applyOpenDocument(fileOnly, {
  kind: "world",
  path: "examples/arm/parts/sfab/arm-bench@1.0.0.json",
});
expect(!fileOnly.has("file"), "opening a world clears ?file=");
expect(
  fileOnly.get("world") === "examples/arm/parts/sfab/arm-bench@1.0.0.json",
  "world path is set"
);
expect(fileOnly.get("project") === "/abs/path", "project stays");

applyOpenDocument(fileOnly, { kind: "file", path: "cad/b.step" });
expect(!fileOnly.has("world"), "opening a file clears ?world=");
expect(fileOnly.get("file") === "cad/b.step", "file path replaces the world");
expect(fileOnly.get("project") === "/abs/path", "project stays after a file");

applyOpenDocument(fileOnly, { kind: "none" });
expect(!fileOnly.has("file") && !fileOnly.has("world"), "close clears both");
expect(fileOnly.get("project") === "/abs/path", "close keeps the folder");

const both = readOpenDocument(
  "?project=/abs/path&file=cad/a.step&world=examples/arm/parts/sfab/arm-bench@1.0.0.json"
);
expect(both.kind === "world", "a URL that names both opens the world");
if (both.kind === "world") {
  expect(
    both.path === "examples/arm/parts/sfab/arm-bench@1.0.0.json",
    "world path is read"
  );
}

const file = readOpenDocument("?file=cad/a.step");
expect(file.kind === "file" && file.path === "cad/a.step", "file only");

const empty = readOpenDocument("?project=/abs/path");
expect(empty.kind === "none", "folder with no document");

const blank = readOpenDocument("?world=%20%20&file=cad/a.step");
expect(
  blank.kind === "file" && blank.path === "cad/a.step",
  "blank world falls through"
);

console.log("document-query.selfcheck ok");
