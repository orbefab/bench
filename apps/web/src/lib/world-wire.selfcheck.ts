import { isDimmed, wireCommit, wireStep } from "./world-wire";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const FILE = "parts/sfab/arm-scene@1.0.0.json";

// First port: it is held, nothing is sent.
const first = wireStep(null, { type: "port", ref: "uno.D10" });
expect(
  first.hold === "uno.D10" && first.commit === null,
  "the first port holds"
);

// The same port again lets go and sends nothing.
const same = wireStep("uno.D10", { type: "port", ref: "uno.D10" });
expect(same.hold === null && same.commit === null, "the same port cancels");

// Empty space lets go, held or not.
const empty = wireStep("uno.D10", { type: "empty" });
expect(empty.hold === null && empty.commit === null, "empty space cancels");
expect(
  wireStep(null, { type: "empty" }).hold === null,
  "empty space with nothing held is nothing"
);

// The second port commits, and the hold is let go.
const second = wireStep("uno.D10", { type: "port", ref: "servo.signal" });
expect(
  second.hold === null &&
    second.commit?.a === "uno.D10" &&
    second.commit.b === "servo.signal",
  "the second port commits the pair, first end first"
);

// Another domain still commits: the server names the refusal.
const across = wireStep("uno.D10", { type: "port", ref: "servo.shaft" });
expect(
  across.commit?.b === "servo.shaft",
  "a port of another domain is sent, and the server refuses it"
);

// A port that already has a wire may take another: nothing here checks it.
const again = wireStep("uno.5V", { type: "port", ref: "servo.V+" });
expect(again.commit !== null, "a wired port may take another wire");

// Dimming while a first port is held.
const held = { ref: "uno.D10", domain: "electrical" as const };
expect(
  !isDimmed({ ref: "servo.signal", domain: "electrical" }, held),
  "a port of the same domain stays bright"
);
expect(
  isDimmed({ ref: "servo.shaft", domain: "rotational" }, held),
  "a port of another domain is dimmed"
);
expect(
  !isDimmed({ ref: "servo.mount" }, held),
  "a port with no known domain is never dimmed"
);
expect(!isDimmed(held, held), "the held port is never dimmed");
expect(
  !isDimmed({ ref: "servo.shaft", domain: "rotational" }, null),
  "nothing is dimmed with no port held"
);
expect(
  !isDimmed({ ref: "servo.shaft", domain: "rotational" }, { ref: "x.y" }),
  "a held port of unknown domain dims nothing"
);

// The commit: one wire op on the open document, one named undo step.
const commit = wireCommit({ a: "uno.D10", b: "servo.signal" }, FILE);
const op = commit.ops[0];
expect(commit.ops.length === 1, "a wire is one op");
expect(
  op?.kind === "wire" &&
    op.document === FILE &&
    op.a === "uno.D10" &&
    op.b === "servo.signal",
  "the op names the tab's file and the two ends"
);
expect(
  commit.label === "Wire uno.D10 to servo.signal",
  "the undo step is named"
);

console.log("world-wire.selfcheck ok");
