/** Which instance params a part declares, and their quantity. */

import {
  FORM_PARAMS,
  isParamRef,
  type Netlist,
  type PartFile,
  type Quantity,
} from "@sfab-bench/contract";

/** A quantity, or `text` for a file name such as the firmware image. */
export type ParamQuantity = Quantity | "text";

export function quantityOn(part: PartFile, name: string): ParamQuantity | null {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return null;
  for (const slot of Object.values(behaviour)) {
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      if (variant.kind === "form") {
        const form = FORM_PARAMS[variant.form];
        const quantity = form?.params[name];
        if (quantity) return quantity;
      }
      if (variant.kind === "firmware") {
        if (variant.imageParam === name || name === "source") return "text";
        if (variant.params && name in variant.params) return "Dimensionless";
      }
    }
  }
  return null;
}

/** Every netlist a part's behaviour classes carry. */
function netlistsOf(part: PartFile): Netlist[] {
  const out: Netlist[] = [];
  for (const slot of Object.values(part.axes?.behaviour ?? {})) {
    for (const variant of Object.values(slot?.variants ?? {})) {
      if (variant.kind === "composite") out.push(variant.netlist);
    }
  }
  return out;
}

/**
 * `quantityOn`, plus the params a composite forwards. A composite declares
 * `name` when a child takes `{ "$param": name }` for a param the child part
 * declares, and it inherits that quantity.
 */
export function declaredQuantity(
  part: PartFile,
  name: string,
  partById: (id: string) => PartFile | null,
  visiting: Set<string> = new Set()
): ParamQuantity | null {
  const own = quantityOn(part, name);
  if (own) return own;
  if (visiting.has(part.id)) return null;
  visiting.add(part.id);
  try {
    for (const netlist of netlistsOf(part)) {
      for (const child of Object.values(netlist.instances)) {
        for (const [key, value] of Object.entries(child.params ?? {})) {
          if (!isParamRef(value) || value.$param !== name) continue;
          const childPart = partById(child.part);
          const found = childPart
            ? declaredQuantity(childPart, key, partById, visiting)
            : null;
          if (found) return found;
        }
      }
    }
    return null;
  } finally {
    visiting.delete(part.id);
  }
}
