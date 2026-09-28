/**
 * Supply forms. Moved from the plan's behaviour chain (layered-sim A2b).
 */
import { batteryFrom, ocvAt } from "@sfab-bench/parts";

import type { FormAdapter, SupplyCtx } from "./types";

function powerAndGround(
  ctx: SupplyCtx,
  pins: Record<string, { kind?: string; output?: boolean }>
): { positive: string; ground: string } | null {
  const positive = Object.entries(pins).find(
    ([, pin]) => pin.kind === "power" && pin.output
  )?.[0];
  const ground = Object.entries(pins).find(
    ([, pin]) => pin.kind === "ground"
  )?.[0];
  if (!positive) {
    ctx.reject(`${ctx.inst.part.id} has no power port`);
    return null;
  }
  if (!ground) {
    ctx.reject(`${ctx.inst.part.id} has no ground port`);
    return null;
  }
  return { positive, ground };
}

function placeThevenin(ctx: SupplyCtx): void {
  const numbers = ctx.numbers();
  if (!numbers) {
    ctx.reject("the run needs thevenin-limit@1");
    return;
  }
  const pins = ctx.pins();
  const ports = powerAndGround(ctx, pins);
  if (!ports) return;
  ctx.add({
    id: ctx.inst.path,
    type: ctx.typeId,
    voltage: numbers.V ?? 0,
    currentLimit: numbers.Ilimit ?? 0,
    rSeries: numbers.Rs ?? 0,
    positivePin: ports.positive,
    groundPin: ports.ground,
    connector: ctx.inst.type.ports[ports.positive]?.connector ?? null,
    pins,
  });
  ctx.box();
}

function placeBattery(ctx: SupplyCtx): void {
  const behaviour = ctx.behaviour;
  if (behaviour.kind !== "form") return;
  const built = batteryFrom(behaviour.params, ctx.inst.params);
  if (!built.ok) {
    ctx.reject(built.error);
    return;
  }
  const cell = built.params;
  const pins = ctx.pins();
  const ports = powerAndGround(ctx, pins);
  if (!ports) return;
  const voc = ocvAt(cell.ocv, cell.soc0);
  ctx.add({
    id: ctx.inst.path,
    type: ctx.typeId,
    voltage: voc,
    currentLimit: cell.rInternal > 0 ? voc / cell.rInternal : 1,
    rSeries: cell.rInternal,
    positivePin: ports.positive,
    groundPin: ports.ground,
    connector: ctx.inst.type.ports[ports.positive]?.connector ?? null,
    pins,
    battery: cell,
  });
  ctx.box();
}

export const supplyAdapters: FormAdapter[] = [
  { id: "thevenin-limit@1", place: placeThevenin },
  { id: "battery@1", place: placeBattery },
];
