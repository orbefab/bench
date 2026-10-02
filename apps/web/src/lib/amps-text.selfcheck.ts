import { ok as expect } from "node:assert/strict";
import { ampsText } from "./amps-text";

const cases: [number, string][] = [
  [0.00019, "0.19 mA"],
  [0.0029, "2.90 mA"],
  [0.0365, "36.5 mA"],
  [0.6356, "636 mA"],
];

const names = ["0.19 mA", "2.9 mA", "36.5 mA", "635.6 mA"];
cases.forEach(([amps, text], index) => {
  const got = ampsText(amps);
  expect(got === text, `${amps} A formats as ${text}, got ${got}`);
  console.log(`${names[index]} → ${got}`);
});

console.log("amps-text.selfcheck ok");
