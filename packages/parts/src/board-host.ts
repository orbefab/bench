/** Which instance a firmware chip runs as, and what a composite board exposes from it. */

import type { BehaviourImpl } from "@sfab-bench/contract";
import { behaviourNetlist, type LiveInstance } from "./levels";

/** `publisher/name@version` → `name`. */
function partStem(id: string): string {
  const slash = id.lastIndexOf("/");
  const at = id.lastIndexOf("@");
  return id.slice(slash + 1, at > slash ? at : undefined);
}

/**
 * The instance a firmware part runs as.
 *
 * A firmware chip that is a netlist child runs as its parent's board; a
 * firmware part that is not a child is its own board. A child means the parent
 * is a composite whose `expose` reaches one of the chip's ports: the header
 * ports are the parent's, so the board id, the pins, the power input and the
 * `VIN` and `VBUS` ports are the parent's too. A scene wires its parts
 * and exposes none of them, so a board in a scene stays its own board.
 */
export function boardHostOf(
  chip: LiveInstance,
  byPath: ReadonlyMap<string, LiveInstance>,
  rootPath: string
): LiveInstance {
  const dot = chip.path.lastIndexOf(".");
  const parent = byPath.get(dot < 0 ? rootPath : chip.path.slice(0, dot));
  if (!parent || parent === chip) return chip;
  const behaviour = parent.axes.behaviour.impl as BehaviourImpl | null;
  const netlist = behaviourNetlist(parent.part, behaviour);
  if (!netlist) return chip;
  const child = chip.path.slice(dot + 1);
  const exposed = Object.values(netlist.expose).some((target) =>
    target.startsWith(`${child}.`)
  );
  return exposed ? parent : chip;
}

/**
 * Header port to chip pin.
 *
 * A composite board uses the expose table of the level that is running.
 * A firmware level that is its own board has no chip child. The pin map
 * is a fact of the board, not of that level, so the lowest composite
 * class on the same part (then the variant name) supplies the table.
 * Empty when the part authors no such expose: a bare chip.
 */
export function chipExposure(
  chip: LiveInstance,
  host: LiveInstance
): Map<string, string> {
  if (host !== chip) return selectedExpose(chip, host);
  return authoredPinMap(host);
}

function selectedExpose(
  chip: LiveInstance,
  host: LiveInstance
): Map<string, string> {
  const out = new Map<string, string>();
  const netlist = behaviourNetlist(
    host.part,
    host.axes.behaviour.impl as BehaviourImpl | null
  );
  const child = chip.path.slice(chip.path.lastIndexOf(".") + 1);
  for (const [port, target] of Object.entries(netlist?.expose ?? {})) {
    if (target.startsWith(`${child}.`)) {
      out.set(port, target.slice(child.length + 1));
    }
  }
  return out;
}

function authoredPinMap(host: LiveInstance): Map<string, string> {
  const behaviour = host.axes.behaviour.impl as BehaviourImpl | null;
  const chipName = behaviour?.kind === "firmware" ? behaviour.chip : null;
  const axes = host.part.axes?.behaviour;
  if (!chipName || !axes) return new Map();
  for (const key of ["0", "1", "2", "3"] as const) {
    const variants = axes[key]?.variants;
    if (!variants) continue;
    for (const name of Object.keys(variants).sort()) {
      const impl = variants[name];
      if (!impl || impl.kind !== "composite") continue;
      const map = new Map<string, string>();
      for (const [port, target] of Object.entries(impl.netlist.expose)) {
        const dot = target.lastIndexOf(".");
        if (dot < 0) continue;
        const child = impl.netlist.instances[target.slice(0, dot)];
        if (!child || partStem(child.part) !== chipName) continue;
        map.set(port, target.slice(dot + 1));
      }
      if (map.size > 0) return map;
    }
  }
  return new Map();
}
