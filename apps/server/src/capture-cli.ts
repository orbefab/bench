/** Ported from layered-sim E4 (fd10742). `pnpm --filter @sfab-bench/server capture`. */
import { captureNanoUsb } from "./capture";

const fixture = process.argv[2];
const stats = await captureNanoUsb(fixture);
process.stdout.write(
  `capture knots=${stats.knots} static=${stats.staticMaxAbsMv.toFixed(3)} mV line=${stats.lineMaxAbsMv.toFixed(3)} mV trip=${stats.tripA} A envelope<=${stats.envelopeMaxA} A\n`
);
for (const row of stats.cases) {
  process.stdout.write(
    `${row.name}: max-abs ${row.maxAbsMv.toFixed(3)} mV, rms ${row.rmsMv.toFixed(3)} mV, ` +
      `half ${row.firstRmsMv.toFixed(3)}/${row.secondRmsMv.toFixed(3)} mV, ` +
      `resets ${row.resets1}/${row.resets2}\n`
  );
}
process.stdout.write(
  `INFO move µs/ms class 2 ${stats.moveUsPerMs.class2.toFixed(1)}, class 1 ${stats.moveUsPerMs.class1.toFixed(1)}\n`
);
