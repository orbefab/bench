// Ported from layered-sim E1 src/mna/lu.ts @ 031dc5e.
/** Dense LU with partial pivoting. Factors in place. Pure TypeScript, no native code. */

const SINGULAR = 1e-18;

export function luFactor(a: Float64Array, n: number, perm: Int32Array): void {
  for (let i = 0; i < n; i++) perm[i] = i;
  for (let k = 0; k < n; k++) {
    let piv = k;
    let max = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]);
      if (v > max) {
        max = v;
        piv = i;
      }
    }
    if (!(max > SINGULAR)) {
      throw new Error(`singular Jacobian at column ${k} (pivot ${max})`);
    }
    if (piv !== k) {
      const tmp = perm[k];
      perm[k] = perm[piv];
      perm[piv] = tmp;
      const rk = k * n;
      const rp = piv * n;
      for (let j = 0; j < n; j++) {
        const t = a[rk + j];
        a[rk + j] = a[rp + j];
        a[rp + j] = t;
      }
    }
    const akk = a[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = a[i * n + k] / akk;
      a[i * n + k] = f;
      const ri = i * n;
      const rk = k * n;
      for (let j = k + 1; j < n; j++) a[ri + j] -= f * a[rk + j];
    }
  }
}

/** Solve A x = b. `a` holds LU, `perm[i]` is the original row now at position i. `b` is not modified. */
export function luSolve(
  a: Float64Array,
  n: number,
  perm: Int32Array,
  b: Float64Array,
  x: Float64Array
): void {
  for (let i = 0; i < n; i++) x[i] = b[perm[i] as number];
  for (let i = 0; i < n; i++) {
    let s = x[i] as number;
    const row = i * n;
    for (let j = 0; j < i; j++) s -= (a[row + j] as number) * (x[j] as number);
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i] as number;
    const row = i * n;
    for (let j = i + 1; j < n; j++)
      s -= (a[row + j] as number) * (x[j] as number);
    x[i] = s / (a[row + i] as number);
  }
}
