import { ok as expect } from "node:assert/strict";
import { WORLD_NONCE_MAX } from "@sfab-bench/contract";

import { worldCommandNonce } from "./world-nonce";

const fromUuid = worldCommandNonce({ randomUUID: () => "tab-a" });
expect(fromUuid === "tab-a", "randomUUID is used when it returns");

const long = "x".repeat(WORLD_NONCE_MAX + 8);
expect(
  worldCommandNonce({ randomUUID: () => long }).length === WORLD_NONCE_MAX,
  "a long uuid is clamped to WORLD_NONCE_MAX"
);

let filled = false;
const fromBytes = worldCommandNonce({
  randomUUID: () => {
    throw new Error("secure context required");
  },
  getRandomValues(bytes) {
    filled = true;
    bytes.fill(0xab);
    return bytes;
  },
});
expect(filled, "a throwing randomUUID falls through to getRandomValues");
expect(fromBytes === "ab".repeat(16), `byte nonce ${fromBytes}`);
expect(fromBytes.length <= WORLD_NONCE_MAX, "byte nonce fits");

const missingUuid = worldCommandNonce({
  getRandomValues(bytes) {
    bytes.fill(1);
    return bytes;
  },
});
expect(missingUuid === "01".repeat(16), "no randomUUID still builds a nonce");
expect(missingUuid.length <= WORLD_NONCE_MAX, "fallback fits the server limit");

console.log("world-nonce.selfcheck ok");
