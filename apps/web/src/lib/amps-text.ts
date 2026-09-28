/**
 * Card current. Two decimals below 10 mA, one decimal below 100 mA,
 * and a whole number from there up.
 */
export function ampsText(current: number): string {
  const milli = current * 1000;
  const mag = Math.abs(milli);
  const digits = mag < 10 ? 2 : mag < 100 ? 1 : 0;
  return `${milli.toFixed(digits)} mA`;
}
