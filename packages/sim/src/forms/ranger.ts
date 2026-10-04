/**
 * The ranger form: a part that times an echo off the body world. Moved from
 * the plan's behaviour chain (layered-sim unit 8). Its ports come from the
 * type's roles, not from names.
 */
import type { PortDecl } from "@sfab-bench/contract";

import type { RangerLaw } from "../ranger";
import type { FormAdapter, PlaceCtx } from "./types";

function rangerLaw(numbers: Record<string, number>): RangerLaw {
  return {
    c: numbers.c ?? 0,
    rangeMin: numbers.rangeMin ?? 0,
    rangeMax: numbers.rangeMax ?? 0,
    beamHalf: numbers.beamHalf ?? 0,
    trigMin: numbers.trigMin ?? 0,
    echoDelay: numbers.echoDelay ?? 0,
    echoTimeout: numbers.echoTimeout ?? 0,
    working: numbers.working ?? 0,
    quiescent: numbers.quiescent ?? 0,
    vMin: numbers.vMin ?? 0,
    face: numbers.face ?? 0,
  };
}

/** The first electrical logic port with that direction, in port order. */
function logicPort(
  ports: Record<string, PortDecl>,
  direction: "in" | "out"
): string | null {
  for (const [name, decl] of Object.entries(ports)) {
    if (
      decl.domain === "electrical" &&
      decl.role === "logic" &&
      decl.direction === direction
    ) {
      return name;
    }
  }
  return null;
}

function placeRanger(ctx: PlaceCtx): void {
  const numbers = ctx.numbers();
  if (!numbers) {
    ctx.reject("the run needs ranger@1", "idle");
    return;
  }
  const trig = logicPort(ctx.inst.type.ports, "in");
  const echo = logicPort(ctx.inst.type.ports, "out");
  // The ray uses this scene pose for the whole run. A sensor on a
  // moving link is not supported yet.
  ctx.addRanger({
    id: ctx.inst.path,
    model: ctx.model,
    pose: ctx.pose(),
    law: rangerLaw(numbers),
    pins: ctx.pins(),
    ports: { trig, echo },
  });
  ctx.box("part");
}

export const rangerAdapter: FormAdapter = {
  id: "ranger@1",
  place: placeRanger,
  rays: true,
};
