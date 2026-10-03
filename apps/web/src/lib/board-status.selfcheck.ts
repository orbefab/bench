import { ok as expect } from "node:assert/strict";
import {
  boardStatusLabel,
  boardWarningLines,
  ledLabel,
  recordedSoaLine,
  scrubbedBoardStatus,
} from "./board-status";

expect(boardStatusLabel(undefined, false) === "", "no board yet");
expect(
  boardStatusLabel({ running: true }, false) === "paused",
  "a healthy paused board says paused"
);
expect(
  boardStatusLabel({ running: true }, true) === "running",
  "a healthy playing board says running"
);
expect(
  boardStatusLabel({ running: false, fault: "bad checksum" }, false) ===
    "stopped",
  "a fault says stopped"
);
expect(
  boardStatusLabel({ running: false }, true) === "stopped",
  "a stopped board stays stopped while the world plays"
);
expect(
  boardStatusLabel({ running: false, inReset: true }, true) === "in reset",
  "a board held in reset says in reset"
);
expect(
  boardStatusLabel(
    { running: false, inReset: true, resetCause: "pin" },
    true
  ) === "in reset (RESET pin)",
  "a pin hold names the RESET pin"
);
expect(
  boardStatusLabel(
    { running: false, inReset: true, resetCause: "brownout" },
    true
  ) === "in reset (brownout)",
  "a sag names the brownout"
);
expect(
  boardStatusLabel({ running: true, inReset: false }, false) === "paused",
  "a board that is not in reset stays paused"
);
expect(
  scrubbedBoardStatus({ running: true, inReset: false }) === "running",
  "a recorded running board is not paused"
);
expect(
  scrubbedBoardStatus({ running: false, inReset: true }) === "in reset",
  "a recorded reset stays in reset"
);
const soa =
  "supply 3.20 V is below the 3.78 V the ATmega328P needs at 16 MHz; real boards may misbehave";
expect(
  boardWarningLines([{ message: soa }]).join() === soa,
  "the board status line is the SOA warning"
);
expect(boardWarningLines(undefined).length === 0, "no warning is no line");
const timer4 =
  "ATmega32U4 timer 4 is not emulated: PWM on that timer stays GPIO";
const usb = "ATmega32U4 USB is not emulated";
expect(
  boardWarningLines([
    { message: timer4 },
    { message: usb },
    { message: timer4 },
  ]).join("|") === `${timer4}|${usb}`,
  "every distinct warning gets its own line, in order"
);
expect(ledLabel("D13") === "D13 LED", "a header pin names the LED");
expect(ledLabel("RXLED") === "RXLED", "an LED pin is not doubled");
expect(ledLabel(null) === "LED", "no pin is a plain label");
const soaFacts = {
  brownoutVoltage: 2.7,
  minOperatingVoltage: 3.78,
  clock: { label: "ATmega328P", hz: 16_000_000 },
};
expect(
  recordedSoaLine(true, { voltage: 3.2, minVoltage: 3.2 }, soaFacts) === soa,
  "a scrubbed frame uses this board's 5V node"
);
expect(
  recordedSoaLine(false, { voltage: 3.2, minVoltage: 3.2 }, soaFacts) === "",
  "a frame outside the band has no line"
);
const otherLine = recordedSoaLine(
  true,
  { voltage: 5, minVoltage: 5 },
  soaFacts
);
expect(
  otherLine === "supply was below the 3.78 V the ATmega328P needs at 16 MHz",
  `an in-spec node is not quoted as the sag: ${otherLine}`
);
const promicroLine = recordedSoaLine(
  true,
  { voltage: 5, minVoltage: 5 },
  {
    brownoutVoltage: 2.6,
    minOperatingVoltage: 4.5,
    clock: { label: "ATmega32U4", hz: 16_000_000 },
  }
);
expect(
  promicroLine === "supply was below the 4.50 V the ATmega32U4 needs at 16 MHz",
  `the scrubbed line names the running chip: ${promicroLine}`
);
expect(
  recordedSoaLine(
    true,
    { voltage: 3.2, minVoltage: 3.2 },
    {
      brownoutVoltage: 2.7,
      minOperatingVoltage: 3.78,
    }
  ) === "supply was below the 3.78 V minimum operating voltage",
  "no chip clock on the view still shows the flag, with the floor"
);
expect(
  recordedSoaLine(true, { voltage: 3.2, minVoltage: 3.2 }, {}) ===
    "supply was below the chip's minimum operating voltage",
  "no facts on the view still shows the flag"
);
expect(
  scrubbedBoardStatus({ running: false, fault: "bad checksum" }) === "stopped",
  "a recorded fault stays stopped"
);
expect(
  boardStatusLabel({ running: false, unpowered: true }, true) === "unpowered",
  "a board no supply reaches says unpowered"
);
expect(
  boardStatusLabel(
    { running: false, fault: "bad checksum", unpowered: true },
    false
  ) === "unpowered",
  "unpowered wins over a fault word"
);
expect(
  scrubbedBoardStatus({ running: false, unpowered: true }) === "unpowered",
  "a scrubbed unpowered board stays unpowered"
);
expect(scrubbedBoardStatus(undefined) === "", "no recorded board yet");

console.log("board-status.selfcheck ok");
