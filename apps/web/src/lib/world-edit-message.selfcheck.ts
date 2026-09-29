import { editMessageText } from "./world-edit-message";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

// The server's wording of the two Wire refusals, as the edit line received it.
expect(
  editMessageText(
    "sfab/arm-scene@1.0.0 port uno.A5 quantity Port: uno.A5 is electrical and servo.shaft is rotational; a wire joins ports of one domain (uno.A5 electrical vs servo.shaft rotational)"
  ) ===
    "uno.A5 is electrical and servo.shaft is rotational; a wire joins ports of one domain",
  "a domain mismatch shows the sentence only"
);
expect(
  editMessageText(
    "sfab/arm-scene@1.0.0 port uno.A5 quantity Port: uno.A5 cannot be wired to itself (uno.A5 vs uno.A5)"
  ) === "uno.A5 cannot be wired to itself",
  "a self wire shows the sentence only"
);

// Anything else is left as the server sent it.
for (const message of [
  "sfab/arm-scene@1.0.0 port uno.A5 quantity Port: wire uno.A5 to servo.signal already exists (uno.A5 vs servo.signal)",
  "sfab/arm-scene@1.0.0 port uno.A5 quantity Port: port uno.A5 does not exist",
  "catalog part is read-only",
  "nothing to undo",
  "",
]) {
  expect(editMessageText(message) === message, `left alone: ${message}`);
}

console.log("world-edit-message.selfcheck ok");
