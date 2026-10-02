// Ported from layered-sim E1 src/mna/element.ts @ 031dc5e.
import type { PowerSplit, StampCtx } from "./context";

export interface Element {
  readonly id: string;
  readonly form: string;
  readonly nonlinear: boolean;
  nodes(): readonly string[];
  branches(): readonly string[];
  /** Called once after node and branch indices exist. */
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void;
  /** Changes when the matrix structure or values change (switch, step size aside). */
  signature(t: number): string;
  stamp(ctx: StampCtx): void;
  /** History update after an accepted step. `ctx.x` is the accepted solution. */
  commit(ctx: StampCtx): void;
  power(ctx: StampCtx): PowerSplit;
  /** Currents leaving each incident node into this element, for the KCL check. */
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]>;
}
