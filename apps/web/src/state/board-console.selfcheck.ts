import { ok as expect } from "node:assert/strict";
import {
  type BoardConsoleEntry,
  boundConsoleEntries,
  CONSOLE_TEXT_CAP,
} from "./board-console";

function chars(entries: readonly BoardConsoleEntry[]): number {
  return boundConsoleEntries(entries, Number.POSITIVE_INFINITY).reduce(
    (sum, entry) => {
      if (entry.kind === "out") return sum + entry.text.length;
      const line = entry.text.endsWith("\n") ? entry.text : `${entry.text}\n`;
      return sum + `‹ sent by ${entry.by} › ${line}`.length;
    },
    0
  );
}

const short: BoardConsoleEntry[] = [{ kind: "out", text: "10\r\n" }];
expect(
  boundConsoleEntries(short)[0]?.kind === "out" &&
    boundConsoleEntries(short)[0]?.text === "10\r\n",
  "a short log is kept"
);

const lines = `${"a".repeat(8)}\n${"b".repeat(8)}\n${"c".repeat(8)}`;
const cut = boundConsoleEntries([{ kind: "out", text: lines }], 20);
expect(cut.length === 1 && cut[0]?.kind === "out", "one output chunk remains");
if (cut[0]?.kind === "out") {
  expect(
    cut[0].text.startsWith("b") || cut[0].text.startsWith("c"),
    cut[0].text
  );
  expect(!cut[0].text.startsWith("a"), "the drop ends on a line");
  expect(cut[0].text.length <= 20, `trimmed length ${cut[0].text.length}`);
}

const hard = boundConsoleEntries([{ kind: "out", text: "abcdefghij" }], 4);
expect(
  hard[0]?.kind === "out" && hard[0].text === "ghij",
  "no newline falls back to a hard cut"
);

const mixed = boundConsoleEntries(
  [
    { kind: "out", text: "old\n" },
    { kind: "sent", text: "hi\n", by: "Mac" },
    { kind: "out", text: "new\n" },
  ],
  4
);
expect(
  mixed.every((entry) => entry.kind === "out" && entry.text === "new\n"),
  `leading entries drop first: ${JSON.stringify(mixed)}`
);

const huge = "x".repeat(CONSOLE_TEXT_CAP + 10);
const capped = boundConsoleEntries([{ kind: "out", text: `${huge}\n` }]);
expect(chars(capped) <= CONSOLE_TEXT_CAP, "the default cap holds");

console.log("board-console.selfcheck ok");
