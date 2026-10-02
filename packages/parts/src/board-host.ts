/** Which instance a firmware chip runs as, and what a composite board exposes from it. */

import type { BehaviourImpl } from "@sfab-bench/contract";
import { behaviourNetlist, type LiveInstance } from "./levels";

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
 * The header ports a composite board exposes from its chip child, as host
 * port to chip pin. Empty when the chip is its own board. The `expose` table is
 * the board's pin map.
 */
export function chipExposure(
  chip: LiveInstance,
  host: LiveInstance
): Map<string, string> {
  const out = new Map<string, string>();
  if (host === chip) return out;
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
