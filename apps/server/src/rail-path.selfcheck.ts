/**
 * One rail path. A single board is the shared rail with N = 1, so its
 * numbers match the stamp constructor. Two boards split a pin edge.
 */

import { arduinoPinBit } from "@sfab-bench/contract";
import { AVR_PIN } from "@sfab-bench/engine-circuit";

import { boardStampOf } from "./world/circuit-stamp";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const bit = arduinoPinBit("D13");
if (bit === undefined) throw new Error("D13");

function stampOf(id: string) {
  return boardStampOf("sfab/nano-ch340@1.0.0", "circuits", { boardId: id });
}

function read(circuit: RailCircuit): string {
  return [
    circuit.voltage,
    circuit.current,
    circuit.boardVoltage,
    circuit.boardMinVoltage,
    circuit.ledCurrent,
    circuit.substeps,
    circuit.resetVoltage,
    circuit.lastPieceCount,
  ].join(",");
}

{
  const stamp = stampOf("nano");
  const viaStamp = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    stamp,
    feed: "usb",
    pin: AVR_PIN,
    ledAlias: "nano.led",
  });
  const viaBoards = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    pin: AVR_PIN,
    ledAlias: "nano.led",
    boards: [{ id: "nano", stamp, feed: "usb", pin: AVR_PIN }],
  });
  const step = (circuit: RailCircuit) => {
    circuit.setFixed(NANO_BOARD_A);
    circuit.setD13("low");
    circuit.solve();
    circuit.solve([
      { dt: 0.0005, drive: [{ bit, mode: "low" }] },
      { dt: 0.0005, drive: [{ bit, mode: "high" }] },
    ]);
  };
  step(viaStamp);
  step(viaBoards);
  const stampText = read(viaStamp);
  const boardText = read(viaBoards);
  expect(stampText === boardText, `N = 1 ${boardText} vs stamp ${stampText}`);
  expect(viaBoards.lastPieceCount === 2, `pieces ${viaBoards.lastPieceCount}`);
  expect(!viaBoards.sharedRail, "N = 1 took the shared flag");
  console.log(
    `single-board general path: ${viaBoards.boardVoltage.toFixed(6)} V equals the stamp path, Δ 0, ${viaBoards.lastPieceCount} pieces`
  );
}

{
  const left = stampOf("left");
  const right = stampOf("right");
  const circuit = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    boards: [
      { id: "left", stamp: left, feed: "usb", pin: AVR_PIN },
      { id: "right", stamp: right, feed: "usb", pin: AVR_PIN },
    ],
  });
  expect(circuit.sharedRail, "two boards are one rail");
  circuit.setBoardLoad("left", NANO_BOARD_A);
  circuit.setBoardLoad("right", NANO_BOARD_A);
  circuit.setBoardDrive("left", bit, "low");
  circuit.setBoardDrive("right", bit, "low");
  circuit.solve();
  circuit.solve([
    {
      dt: 0.0004,
      drive: [
        { boardId: "left", bit, mode: "low" },
        { boardId: "right", bit, mode: "low" },
      ],
    },
    {
      dt: 0.0006,
      drive: [
        { boardId: "left", bit, mode: "high" },
        { boardId: "right", bit, mode: "low" },
      ],
    },
  ]);
  const led = circuit.leds["left.led"] ?? 0;
  expect(circuit.lastPieceCount === 2, `pieces ${circuit.lastPieceCount}`);
  expect(led > 0.001, `left LED ${led}`);
  console.log(
    `two boards pin edge: ${circuit.lastPieceCount} pieces, left LED ${led.toFixed(6)} A`
  );
}
