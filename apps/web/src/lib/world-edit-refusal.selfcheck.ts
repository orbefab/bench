import { ok as expect } from "node:assert/strict";

import type { EditRefusal } from "@sfab-bench/contract";

import { editRefusalText, historyRefusalTitle } from "./world-edit-refusal";

// What the edit line showed before the server sent the parts: the message
// cut by a pattern. The new text must equal it for every case below.
const TODAY =
  /^.* port \S+ quantity Port: (\S+ cannot be wired to itself|\S+ is \S+ and \S+ is \S+; a wire joins ports of one domain) \(.*\)$/s;
const todayText = (message: string) => TODAY.exec(message)?.[1] ?? message;

/** The server's wording, rebuilt from the same parts it sends. */
function refused(
  port: string,
  quantity: string,
  detail: string,
  left: string,
  right: string
) {
  const path = "sfab/arm-scene@1.0.0";
  const refusal: EditRefusal = { path, port, quantity, left, right, detail };
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
    "servo.shaft rotational"
  ),
  refused(
    "uno.A5",
    "Port",
    "uno.A5 cannot be wired to itself",
    "uno.A5",
    "uno.A5"
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

const other = [
  refused(
    "uno.A5",
    "Port",
    "wire uno.A5 to servo.signal already exists",
    "uno.A5",
    "servo.signal"
  ),
  refused("uno.A5", "Port", "port uno.A5 does not exist", "uno.A5", "none"),
  // The detail reads like a Wire refusal but the quantity is not the port's.
  refused(
    "servo",
    "Param",
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

for (const row of [...wire, ...other]) {
  expect(
    editRefusalText(row) === todayText(row.message),
    `same as today: ${row.message}`
  );
}

expect(historyRefusalTitle("undo") === "Nothing to undo.", "undo title");
expect(historyRefusalTitle("redo") === "Nothing to redo.", "redo title");

console.log(
  `world-edit-refusal.selfcheck ok (${wire.length} wire, ${other.length} other refusals)`
);
