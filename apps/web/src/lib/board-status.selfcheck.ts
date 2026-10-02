import { ok as expect } from "node:assert/strict";
import {
  boardStatusLabel,
  boardWarningLine,
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
  boardStatusLabel({ running: false, brownout: true }, true) === "in reset",
  "a board held in reset says in reset"
);
expect(
  boardStatusLabel({ running: true, brownout: false }, false) === "paused",
  "a board that is not in brownout stays paused"
);
expect(
  scrubbedBoardStatus({ running: true, brownout: false }) === "running",
  "a recorded running board is not paused"
);
expect(
  scrubbedBoardStatus({ running: false, brownout: true }) === "in reset",
  "a recorded reset stays in reset"
);
const soa =
  "supply 3.20 V is below the 3.78 V the ATmega328P needs at 16 MHz; real boards may misbehave";
expect(
  boardWarningLine([{ message: soa }]) === soa,
  "the board status line is the SOA warning"
);
expect(boardWarningLine(undefined) === "", "no warning is a blank line");
const soaFacts = { brownoutVoltage: 2.7, minOperatingVoltage: 3.78 };
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
  otherLine !== soa && !otherLine.includes("3.20"),
  `an in-spec node was quoted as the sag: ${otherLine}`
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
