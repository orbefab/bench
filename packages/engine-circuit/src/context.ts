// Ported from layered-sim E2 src/mna/context.ts @ 8731557.
/** Shared stamp context. Ground is index -1 and is never written. */

export type Method = "be" | "trap";

export type StampCtx = {
  dc: boolean;
  method: Method;
  /** Step length, seconds. Unused when dc. */
  h: number;
  /** Time at the end of the step being solved, seconds. */
  t: number;
  /** Matrix already factored; elements may only touch z. */
  rhsOnly: boolean;
  /**
   * Piecewise devices keep the companion that was factored and only refresh
   * the right-hand side. Set together with rhsOnly.
   */
  freezeNonlinear: boolean;
  n: number;
  A: Float64Array;
  z: Float64Array;
  /** Last accepted solution, then the newest Newton guess. */
  x: Float64Array;
  /**
   * Scales independent sources. 1 on every solve that Newton accepts
   * by itself, so those stamps stay the unscaled value.
   */
  sourceScale: number;
};

export type PowerSplit = {
  absorbed: number;
  delivered: number;
  dissipated: number;
  storedDot: number;
  mechanical: number;
};

export const ZERO_POWER: PowerSplit = {
  absorbed: 0,
  delivered: 0,
  dissipated: 0,
  storedDot: 0,
  mechanical: 0,
};

export function gStamp(ctx: StampCtx, a: number, b: number, g: number): void {
  if (ctx.rhsOnly || g === 0) return;
  const { A, n } = ctx;
  if (a >= 0) A[a * n + a] = (A[a * n + a] as number) + g;
  if (b >= 0) A[b * n + b] = (A[b * n + b] as number) + g;
  if (a >= 0 && b >= 0) {
    A[a * n + b] = (A[a * n + b] as number) - g;
    A[b * n + a] = (A[b * n + a] as number) - g;
  }
}

export function zAdd(ctx: StampCtx, node: number, value: number): void {
  if (node >= 0 && value !== 0) ctx.z[node] = (ctx.z[node] as number) + value;
}

/**
 * Voltage-defined branch. `i` leaves node `a` into the element toward `b`.
 * Equation: v(a) - v(b) - r * i = e.
 */
export function vBranch(
  ctx: StampCtx,
  a: number,
  b: number,
  iCol: number,
  r: number,
  e: number
): void {
  const { A, z, n } = ctx;
  if (!ctx.rhsOnly) {
    if (a >= 0) {
      A[iCol * n + a] = (A[iCol * n + a] as number) + 1;
      A[a * n + iCol] = (A[a * n + iCol] as number) + 1;
    }
    if (b >= 0) {
      A[iCol * n + b] = (A[iCol * n + b] as number) - 1;
      A[b * n + iCol] = (A[b * n + iCol] as number) - 1;
    }
    if (r !== 0) A[iCol * n + iCol] = (A[iCol * n + iCol] as number) - r;
  }
  z[iCol] = (z[iCol] as number) + e;
}

export function volt(ctx: StampCtx, node: number): number {
  return node >= 0 ? (ctx.x[node] as number) : 0;
}
