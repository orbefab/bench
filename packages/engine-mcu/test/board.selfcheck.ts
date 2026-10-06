import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FIRMWARE_RELOADED,
  parseIntelHex,
  SERIAL_CAP,
  SerialRing,
} from "../src/index";

function record(type: number, addr: number, data: number[]): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  bytes.push((0x100 - sum) & 0xff);
  return `:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const holdPath = fileURLToPath(
  new URL("../../../examples/arm/firmware/hold/hold.hex", import.meta.url)
);
const hold = parseIntelHex(readFileSync(holdPath, "utf8"));
expect(hold.ok, `hold.hex: ${hold.ok ? "" : hold.error}`);
if (hold.ok) {
  expect(hold.bytes.length === 32 * 1024, "flash is 32 KiB");
  expect(hold.bytes[0] !== 0xff || hold.bytes[1] !== 0xff, "hold.hex has data");
}

const good = parseIntelHex(
  `${record(0, 0, [0x0c, 0x94])}\n${record(1, 0, [])}\n`
);
expect(good.ok, `good hex: ${good.ok ? "" : good.error}`);
if (good.ok) {
  expect(good.bytes[0] === 0x0c && good.bytes[1] === 0x94, "data lands at 0");
  expect(good.bytes[2] === 0xff, "unprogrammed flash stays erased");
}

const badSum = parseIntelHex(":0000000001\n");
expect(!badSum.ok, "bad checksum is rejected");
if (!badSum.ok) {
  expect(badSum.error.includes("bad checksum"), badSum.error);
}

const pastFlash = parseIntelHex(`${record(0, 0x8000, [0x11])}\n`);
expect(!pastFlash.ok, "address past flash is rejected");
if (!pastFlash.ok) {
  expect(pastFlash.error.includes("past the end of flash"), pastFlash.error);
}

const ring = new SerialRing();
ring.append("abc");
const all = ring.read(0);
expect(
  all.text === "abc" && all.next === 3 && all.dropped === undefined,
  "ring read"
);
const tail = ring.read(1);
expect(tail.text === "bc" && tail.next === 3, "from returns only newer text");
expect(ring.read(3).text === "", "from next is empty");
ring.append("x".repeat(SERIAL_CAP));
const dropped = ring.read(0);
expect(dropped.dropped !== undefined, "overflow reports dropped");
expect(dropped.text.length === SERIAL_CAP, "cap keeps 64 KiB");
const markerAt = ring.next;
ring.clear(FIRMWARE_RELOADED);
const cleared = ring.read(0);
expect(cleared.text === FIRMWARE_RELOADED, "reload marker replaces the ring");
expect(cleared.dropped !== undefined, "old offsets are dropped");
expect(
  cleared.next === markerAt + FIRMWARE_RELOADED.length,
  "offsets stay monotonic"
);
const since = ring.read(markerAt);
expect(
  since.text === FIRMWARE_RELOADED && since.dropped === undefined,
  "from the marker sees only the new text"
);

console.log("board.selfcheck ok");
