import { ok as expect } from "node:assert/strict";
import { parseEditorContent, textToDoc } from "../components/ui/chat-input";
import {
  CAD_MENTION_FACE_CAP,
  CAD_MENTION_LIST_CAP,
  type CadMentionItem,
  cadMentionQueryCloses,
  cadRefFromHref,
  cadRefHref,
  filterCadMentionCatalog,
  isCadRefToken,
  linkifyCadRefsInMarkdown,
  parseCadRefs,
  partRefFromCadRef,
  resolveCadRef,
} from "./cad-refs";

const look = parseCadRefs("Look at #o1.1 and #o1.1.f6.");
expect(look.length === 2, "two refs");
expect(look[0]?.ref === "#o1.1", "part token");
expect(look[1]?.ref === "#o1.1.f6", "face token");

expect(
  parseCadRefs("see #heading next").length === 0,
  "ATX heading is not a ref"
);
expect(parseCadRefs("bare #o and done").length === 0, "#o without digits");
expect(parseCadRefs("x #o1.1 y")[0]?.ref === "#o1.1", "longer match beats #o1");
expect(isCadRefToken("#o1.2.1.f6"), "whole-string face token");
expect(!isCadRefToken("#o1.1 extra"), "token must be the whole string");
expect(partRefFromCadRef("#o1.1.f6") === "#o1.1", "strip face suffix");

expect(
  parseCadRefs("https://example.com/#o1.1").length === 0,
  "URL fragment is not a ref"
);
expect(parseCadRefs("foo#o1.1").length === 0, "glued identifier is not a ref");
expect(
  parseCadRefs("user+#o1.1@x.com").length === 0,
  "plus-glued email is not a ref"
);
expect(parseCadRefs("(#o1.1)")[0]?.ref === "#o1.1", "paren-wrapped ref");
expect(parseCadRefs("#o1.1,")[0]?.ref === "#o1.1", "trailing comma");
expect(parseCadRefs("#o1.1")[0]?.ref === "#o1.1", "line-start ref");
expect(parseCadRefs("\n#o1.1")[0]?.ref === "#o1.1", "newline-start ref");
expect(
  parseCadRefs("see #o1.2.")[0]?.ref === "#o1.2",
  "sentence period is not swallowed"
);

const parsed = parseEditorContent(
  {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Make " },
          { type: "part-mention", attrs: { id: "#o1.1", label: "Bracket" } },
          { type: "text", text: " taller" },
        ],
      },
    ],
  },
  { part: { trigger: "#", items: [] } },
  {}
);
expect(parsed.text.includes("#o1.1"), "send path keeps the ref");
expect(!parsed.text.includes("Bracket"), "send path drops the label");
expect(!parsed.text.includes("#Bracket"), "send path is not trigger+label");

const parts = [
  { name: "Bracket", cadRef: "#o1.1" },
  { name: "post_left", cadRef: "#o1.2.1" },
];
expect(
  resolveCadRef("#o1.1.f6", parts)?.kind === "face",
  "face resolves through the part"
);
expect(resolveCadRef("#o1.1.f6", parts)?.label === "Face 6", "face chip label");
expect(
  resolveCadRef("#o1.2.1", parts)?.label === "post_left",
  "part chip uses display name"
);
expect(resolveCadRef("#o9.9", parts) === null, "missing part is unresolved");
expect(
  resolveCadRef("#o9.9.f1", parts) === null,
  "missing face-part is unresolved"
);

const bolts = [
  { name: "Bolt", cadRef: "#o1.1" },
  { name: "Bolt", cadRef: "#o1.2" },
  { name: "plate_1", cadRef: "#o1.3" },
];
const bothBolts = filterCadMentionCatalog(bolts, "bolt");
expect(bothBolts.items.length === 2, "includes matches both duplicate names");
expect(
  bothBolts.items.every((item) => item.name === "Bolt"),
  "chip label is the display name"
);
const byRef = filterCadMentionCatalog(bolts, "#o1.2");
expect(
  byRef.items.length === 1 && byRef.items[0]?.id === "#o1.2",
  "filter by ref"
);
const spaced = filterCadMentionCatalog(
  [{ name: "Left bracket", cadRef: "#o2.1" }],
  "left br"
);
expect(spaced.items.length === 1, "spaces in the query still includes");

const noFaces = filterCadMentionCatalog(bolts, "", {
  selectedPart: bolts[0],
  faces: undefined,
});
expect(
  noFaces.items.every((item) => item.kind === "part"),
  "no faces unless the selected leaf supplies ranges"
);

const withFaces = filterCadMentionCatalog(bolts, "", {
  selectedPart: bolts[0],
  faces: [{ ord: 1 }, { ord: 6 }],
});
expect(withFaces.items.at(-1)?.id === "#o1.1.f6", "faces follow parts");
expect(
  withFaces.items.some((item) => item.name === "Face 6"),
  "face label from ordinal"
);

const faceQuery = filterCadMentionCatalog(bolts, "f6", {
  selectedPart: bolts[0],
  faces: [{ ord: 1 }, { ord: 6 }],
});
expect(
  faceQuery.items.some((item) => item.id === "#o1.1.f6"),
  "face query matches fN"
);

const parentNameLeak = filterCadMentionCatalog(
  [{ name: "post_right", cadRef: "#o1.2.2" }],
  "po",
  {
    selectedPart: { name: "post_right", cadRef: "#o1.2.2" },
    faces: [{ ord: 1 }, { ord: 2 }, { ord: 3 }],
  }
);
expect(
  parentNameLeak.items.every((item) => item.kind === "part"),
  "faces do not inherit the parent part name filter"
);

const many = Array.from({ length: CAD_MENTION_LIST_CAP + 5 }, (_, i) => ({
  name: `stud_${i + 1}`,
  cadRef: `#o1.${i + 1}`,
}));
const capped = filterCadMentionCatalog(many, "", {
  selectedPart: many[0],
  faces: [{ ord: 1 }, { ord: 2 }],
});
expect(
  capped.items.filter((item) => item.kind === "part").length ===
    CAD_MENTION_LIST_CAP,
  "part cap"
);
expect(
  capped.items.filter((item) => item.kind === "face").length === 2,
  "matching faces survive a truncated part list"
);
expect(capped.truncated, "truncated footer signal");

const manyFaces = filterCadMentionCatalog(
  [{ name: "plate_1", cadRef: "#o1.1" }],
  "",
  {
    selectedPart: { name: "plate_1", cadRef: "#o1.1" },
    faces: Array.from({ length: CAD_MENTION_FACE_CAP + 4 }, (_, i) => ({
      ord: i + 1,
    })),
  }
);
expect(
  manyFaces.items.filter((item) => item.kind === "face").length ===
    CAD_MENTION_FACE_CAP,
  "face cap is separate"
);
expect(manyFaces.truncated, "face overflow sets truncated");

expect(cadMentionQueryCloses("post  "), "two trailing spaces close");
expect(cadMentionQueryCloses("post\n"), "newline closes");
expect(!cadMentionQueryCloses("post "), "one trailing space stays open");
expect(!cadMentionQueryCloses("left br"), "internal space stays open");

const seeded = [
  "I raised #o1.2.1 by 5 mm. `#o1.2.2` is unchanged, and #o9.9.f1 is not in this model.",
  "",
  "## Changes",
  "",
  "- Post height: #o1.2.1 now 25 mm",
  "- Plate #o1.1 untouched",
  "",
  "```",
  "ref #o1.2.2 stays",
  "```",
  "",
  "See **#o1.2** for both posts.",
].join("\n");
const linked = linkifyCadRefsInMarkdown(seeded);
expect(linked.includes("- Post height:"), "list marker survives");
expect(linked.includes("- Plate"), "second list item survives");
expect(
  linked.includes("**[#o1.2](#cad-ref:o1.2)**"),
  "emphasis markers wrap the link"
);
expect(linked.includes("## Changes"), "heading survives");
expect(linked.includes("`#o1.2.2`"), "inline code is untouched");
expect(linked.includes("ref #o1.2.2 stays"), "fenced code is untouched");
expect(
  linked.includes("[#o1.2.1](#cad-ref:o1.2.1)"),
  "prose ref becomes a cad-ref link"
);
expect(
  linked.includes("[#o9.9.f1](#cad-ref:o9.9.f1)"),
  "unresolved prose ref is still linked"
);
expect(cadRefFromHref(cadRefHref("#o1.2.1")) === "#o1.2.1", "href round-trips");
expect(
  cadRefFromHref("https://example.com/#cad-ref:o1.1") === "#o1.1",
  "absolute hash still parses"
);
expect(cadRefFromHref("#heading") === null, "plain fragment is not a cad ref");

const mentionCfg = {
  part: {
    trigger: "#",
    items: [] as CadMentionItem[],
    refsInText: parseCadRefs,
    resolve: (ref: string) => {
      const hit = resolveCadRef(ref, parts);
      if (!hit) return undefined;
      return { id: hit.ref, name: hit.label, cadRef: hit.ref, kind: hit.kind };
    },
  },
};
const seededItems: Record<string, Map<string, CadMentionItem>> = {};
const restored = "raise #o1.2.1 5 mm";
const hydrated = textToDoc(restored, mentionCfg, seededItems);
const roundTrip = parseEditorContent(hydrated, mentionCfg, seededItems);
expect(roundTrip.text === restored, "hydrated draft round-trips");
expect(
  hydrated.content?.[0]?.content?.some(
    (node) => node.type === "part-mention" && node.attrs?.id === "#o1.2.1"
  ) === true,
  "resolved ref is a chip whose id already includes the trigger"
);
expect(
  seededItems.part?.get("#o1.2.1")?.name === "post_left",
  "hydrate seeds selectedItems"
);
const leftover = textToDoc("see #o9.9 please", mentionCfg, {});
expect(
  leftover.content?.[0]?.content?.every((node) => node.type === "text") ===
    true,
  "unresolved ref stays plain text"
);

const referenceStyle = "Click [see #o1.1][post] then #o1.2\n\n[post]: #o1.1";
const referenceLinked = linkifyCadRefsInMarkdown(referenceStyle);
expect(
  referenceLinked.includes("[see #o1.1][post]"),
  "reference link text is not rewritten"
);
expect(
  referenceLinked.includes("[post]: #o1.1"),
  "link definition line is not rewritten"
);
expect(
  referenceLinked.includes("[#o1.2](#cad-ref:o1.2)"),
  "prose after a reference link still linkifies"
);

console.log("cad-refs.selfcheck ok");
