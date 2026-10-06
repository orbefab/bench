/**
 * Pin rows follow the board view's names. Bit 5 of a Nano header is D5.
 * Bit 5 of a bare ATmega328P is PB5. This file does not import the
 * retired Arduino pin bridge.
 */

import { ok as expect } from "node:assert/strict";
import type { WorldPinState } from "@sfab-bench/contract";

import { pinRows } from "./pin-rows";

const NANO: readonly string[] = [
  ..."D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13".split(" "),
  ..."A0 A1 A2 A3 A4 A5".split(" "),
];
const BARE: readonly string[] = [
  ..."PB0 PB1 PB2 PB3 PB4 PB5 PB6 PB7".split(" "),
  ..."PC0 PC1 PC2 PC3 PC4 PC5 PC6".split(" "),
  ..."PD0 PD1 PD2 PD3 PD4 PD5 PD6 PD7".split(" "),
];

function words(index: number): WorldPinState {
  const ddr = [0];
  const level = [0];
  const toggled = [0];
  const word = index >>> 5;
  while (ddr.length <= word) {
    ddr.push(0);
    level.push(0);
    toggled.push(0);
  }
  const bit = 1 << (index & 31);
  ddr[word] = bit;
  level[word] = bit;
  return { ddr, level, toggled };
}

expect(NANO.length === 20, "a Nano header view has 20 pins");
const nano5 = pinRows(NANO, words(5));
expect(nano5[5]?.name === "D5", "bit 5 of a Nano is D5");
expect(
  nano5[5]?.dir === "out" && nano5[5]?.level === "H",
  "D5 reads its own bit"
);
const nano13 = pinRows(NANO, words(13));
expect(
  nano13[13]?.name === "D13" && nano13[13]?.dir === "out",
  "bit 13 of a Nano is D13"
);

expect(BARE.length === 23, "a bare chip view has 23 pins");
const bare = pinRows(BARE, words(5));
expect(bare[0]?.name === "PB0", "a bare chip starts at PB0");
expect(bare[5]?.name === "PB5", "bit 5 of a bare chip is PB5");
expect(
  bare[5]?.dir === "out" && bare[5]?.level === "H",
  "PB5 reads its own bit"
);
expect(bare[13]?.name === "PC5", "bit 13 of a bare chip is PC5");

console.log("pin-rows: a Nano D13 and a bare-chip PB5 keep their own names");
