import { ok as expect } from "node:assert/strict";

import type { EditRefusal, EditRefusalCode } from "@sfab-bench/contract";

import { editRefusalText, historyRefusalTitle } from "./world-edit-refusal";

/** The server's wording, rebuilt from the same parts it sends. */
function refused(
  port: string,
  quantity: string,
  detail: string,
  left: string,
  right: string,
  code?: EditRefusalCode
) {
  const path = "sfab/arm-scene@1.0.0";
  const refusal: EditRefusal = {
    path,
    port,
    quantity,
    left,
    right,
    detail,
    ...(code ? { code } : {}),
  };
  return {
    message: `${path} port ${port} quantity ${quantity}: ${detail} (${left} vs ${right})`,
    refusal,
  };
}

const wire = [
  refused(
    "uno.A5",
    "Port",
    "uno.A5 is electrical and servo.shaft is rotational; a wire joins ports of one domain",
    "uno.A5 electrical",
    "servo.shaft rotational",
    "wire-domain"
  ),
  refused(
    "uno.A5",
    "Port",
    "uno.A5 cannot be wired to itself",
    "uno.A5",
    "uno.A5",
    "wire-self"
  ),
];
expect(
  editRefusalText(wire[0]) ===
    "uno.A5 is electrical and servo.shaft is rotational; a wire joins ports of one domain",
  "a domain mismatch shows the sentence only"
);
expect(
  editRefusalText(wire[1]) === "uno.A5 cannot be wired to itself",
  "a self wire shows the sentence only"
);

// No code, no cut: the wording alone never makes a refusal a Wire one.
const other = [
  refused(
    "uno.A5",
    "Port",
    "wire uno.A5 to servo.signal already exists",
    "uno.A5",
    "servo.signal"
  ),
  refused("uno.A5", "Port", "port uno.A5 does not exist", "uno.A5", "none"),
  refused(
    "uno.A5",
    "Port",
    "uno.A5 cannot be wired to itself",
    "uno.A5",
    "uno.A5"
  ),
];
for (const row of other) {
  expect(editRefusalText(row) === row.message, `shown as sent: ${row.message}`);
}

// A refusal with no parts (a read-only catalog part, an unknown op) is the
// message as sent.
for (const message of [
  "catalog part is read-only",
  "unknown edit",
  "an edit names a different document",
  "nothing to undo",
  "",
]) {
  expect(editRefusalText({ message }) === message, `no parts: ${message}`);
}

expect(historyRefusalTitle("undo") === "Nothing to undo.", "undo title");
expect(historyRefusalTitle("redo") === "Nothing to redo.", "redo title");

console.log(
  `world-edit-refusal.selfcheck ok (${wire.length} wire, ${other.length} other refusals)`
);
