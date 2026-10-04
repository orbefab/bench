/**
 * Compile-time map from form id to adapter (layered-sim A2b).
 */
import { circuitAdapters } from "./circuit";
import { rangerAdapter } from "./ranger";
import { supplyAdapters } from "./supply";
import type { FormAdapter } from "./types";

export { parseCircuitParams, stampDiode } from "./circuit";
export type { FormAdapter, PlaceCtx, StampedElements } from "./types";

const adapters = new Map<string, FormAdapter>();
for (const adapter of [...circuitAdapters, ...supplyAdapters, rangerAdapter]) {
  adapters.set(adapter.id, adapter);
}

export function formAdapter(id: string): FormAdapter | undefined {
  return adapters.get(id);
}
