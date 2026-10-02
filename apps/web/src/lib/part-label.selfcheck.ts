import { ok as expect } from "node:assert/strict";
import {
  disambiguateSiblingNames,
  fileStemFromLabel,
  isRawPartName,
  occurrencePath,
  partDisplayName,
  partLabelFileStem,
} from "./part-label";
import { filterPartTree, type PartTreeItem } from "./part-tree";

expect(isRawPartName("=>[0:1:1:2]"), "occt dump");
expect(isRawPartName("=> [0:1:1:2]"), "occt dump with space");
expect(isRawPartName("0:1:1:2"), "tag path");
expect(isRawPartName(""), "empty");
expect(isRawPartName("   "), "whitespace");
expect(isRawPartName("o1.1"), "occurrence id fallback");
expect(isRawPartName("post_left") === false, "real name is not raw");
expect(isRawPartName("cube") === false, "stem is not raw");
expect(isRawPartName("1") === false, "bare digit is a name");
expect(
  isRawPartName("foo =>[0:1]") === false,
  "dump only when the whole name is a dump"
);
expect(isRawPartName("rev.2") === false, "revision-style name is not raw");
expect(isRawPartName("item[1]") === false, "bracket index is not raw");

expect(occurrencePath("#o1.1") === "1.1", "hash ref");
expect(occurrencePath("o1.1.2") === "1.1.2", "bare id");
expect(occurrencePath("#o1.1.f6") === "1.1", "face suffix stripped");
expect(occurrencePath("#heading") === null, "not a cad ref");

expect(fileStemFromLabel("cube.step") === "cube", "step stem");
expect(fileStemFromLabel("a/b/plate.stp") === "plate", "path stem");

expect(
  partDisplayName({ name: "=>[0:1:1:2]", cadRef: "#o1.1" }, "#o1.1") ===
    "Part 1.1",
  "raw dump falls back to ref path"
);
expect(
  partDisplayName({ name: "=>[0:1:1:2]", cadRef: "#o1.1" }, "#o1.1", "cube") ===
    "cube",
  "sole solid uses the file stem"
);
expect(
  partDisplayName({ name: "0:1:1:2" }, "#o1") === "Part 1",
  "tag path fallback"
);
expect(partDisplayName({ name: "" }, "#o1.1.2") === "Part 1.1.2", "empty name");
expect(
  partDisplayName({ name: "o1.1" }, "#o1.1") === "Part 1.1",
  "id-as-name fallback"
);
expect(
  partDisplayName({ name: "post_left" }, "#o1.1.1") === "post_left",
  "real name passthrough"
);
expect(
  partDisplayName({ name: "plate_1" }, "#o1.1", "bracket_assembly") ===
    "plate_1",
  "real name wins over stem"
);
expect(
  partDisplayName({ name: "rev.2" }, "#o1.1") === "rev.2",
  "rev.2 passes through"
);
expect(
  partDisplayName({ name: "item[1]" }, "#o1.1") === "item[1]",
  "item[1] passes through"
);
expect(
  partDisplayName({ name: "foo =>[0:1]" }, "#o1.1") === "foo =>[0:1]",
  "embedded dump text passes through"
);

expect(
  partLabelFileStem(1, "cube.step") === "cube",
  "sole solid gets the stem"
);
expect(
  partLabelFileStem(2, "cube.step") === undefined,
  "siblings do not use the stem"
);
expect(
  partLabelFileStem(3, "bracket_assembly.step") === undefined,
  "assembly with a nested child does not use the stem"
);
expect(
  partDisplayName(
    { name: "=>[0:1:1:2]", cadRef: "#o1.1" },
    "#o1.1",
    partLabelFileStem(2, "cube.step")
  ) === "Part 1.1",
  "raw sibling falls back to the ref path, not the file stem"
);

const boltSiblings = [
  { key: "a", display: "Bolt", ref: "#o1.2" },
  { key: "b", display: "Bolt", ref: "#o1.3" },
  { key: "c", display: "Nut", ref: "#o1.4" },
];
const siblings = disambiguateSiblingNames(boltSiblings);
expect(siblings.get("a") === "Bolt (1.2)", "dup suffix from ref");
expect(siblings.get("b") === "Bolt (1.3)", "other dup suffix");
expect(siblings.get("c") === "Nut", "unique sibling unchanged");
const siblingsAgain = disambiguateSiblingNames(boltSiblings);
expect(siblingsAgain.get("a") === "Bolt (1.2)", "suffix stable on repeat");
expect(
  siblingsAgain.get("b") === "Bolt (1.3)",
  "other suffix stable on repeat"
);
const reordered = disambiguateSiblingNames([
  boltSiblings[1]!,
  boltSiblings[0]!,
  boltSiblings[2]!,
]);
expect(
  reordered.get("a") === "Bolt (1.2)",
  "suffix follows the ref, not list order"
);
expect(
  reordered.get("b") === "Bolt (1.3)",
  "other suffix follows the ref, not list order"
);

const tree: PartTreeItem[] = [
  {
    key: "posts",
    rawName: "posts",
    displayName: "posts",
    children: [
      {
        key: "left",
        rawName: "post_left",
        displayName: "post_left",
        children: [],
      },
      {
        key: "right",
        rawName: "post_right",
        displayName: "post_right",
        children: [],
      },
    ],
  },
  { key: "plate", rawName: "plate_1", displayName: "plate_1", children: [] },
];

const nested = filterPartTree(tree, "post_left");
expect(
  nested.nodes.length === 1 && nested.nodes[0]?.key === "posts",
  "nested match keeps ancestor"
);
expect(
  nested.nodes[0]?.children.length === 1 &&
    nested.nodes[0]?.children[0]?.key === "left",
  "only the hit child"
);
expect(nested.expandKeys.join(",") === "posts", "ancestor is auto-expanded");

const caseHit = filterPartTree(tree, "POST_LEFT");
expect(
  caseHit.nodes[0]?.children[0]?.key === "left",
  "filter is case-insensitive"
);

const rawHit = filterPartTree(
  [
    {
      key: "root",
      rawName: "=>[0:1:1:2]",
      displayName: "cube",
      children: [],
    },
  ],
  "=>[0:1:1:2]"
);
expect(rawHit.nodes.length === 1, "filter matches the raw name");

const parentHit = filterPartTree(tree, "posts");
expect(
  parentHit.nodes[0]?.children.length === 2,
  "self-hit keeps the full subtree"
);
expect(
  parentHit.expandKeys.join(",") === "posts",
  "self-hit with children is expanded"
);

const none = filterPartTree(tree, "nope");
expect(none.nodes.length === 0, "no-match");
expect(none.expandKeys.length === 0, "no-match expands nothing");

expect(filterPartTree(tree, "  ").nodes.length === 2, "blank query is a no-op");

console.log("part-label.selfcheck ok");
