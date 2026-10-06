/** Which instance a firmware chip runs as, and what a composite board exposes from it. */

import type {
  BehaviourImpl,
  Diagnostic,
  Netlist,
  PartFile,
  PinMapRef,
} from "@sfab-bench/contract";
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
 * Header port to chip pin.
 *
 * A composite board uses the expose table of the level that is running.
 * A firmware level that is its own board has no chip child: its
 * `pinMapFrom` names the composite level of the same part whose expose is
 * the pin map, and the chip child in it. Empty for a bare chip, which names
 * none. A board whose map does not resolve is refused by the library lint
 * (`lintPinMap`): the loader idles such a part below the root, and the
 * planner idles it at the root (`pinMapRefused`). It never runs as a bare
 * chip.
 */
export function chipExposure(
  chip: LiveInstance,
  host: LiveInstance
): Map<string, string> {
  if (host !== chip) return selectedExpose(chip, host);
  const behaviour = host.axes.behaviour.impl as BehaviourImpl | null;
  if (behaviour?.kind !== "firmware" || !behaviour.pinMapFrom) {
    return new Map();
  }
  const source = pinMapSource(host.part, behaviour.pinMapFrom);
  return "error" in source
    ? new Map()
    : exposeOnto(source.netlist, source.instance);
}

/**
 * Why a firmware level of `part`, running as its own board, has no pin map;
 * null when it has one or is a bare chip. A part with a composite level is
 * a board: its firmware level must name `pinMapFrom`, and the reference
 * must resolve. A part with no composite level is a bare chip.
 */
export function pinMapRefusal(
  part: PartFile,
  firmware: Extract<BehaviourImpl, { kind: "firmware" }>
): string | null {
  const ref = firmware.pinMapFrom;
  if (!ref) {
    const board = Object.values(part.axes?.behaviour ?? {}).some((slot) =>
      Object.values(slot?.variants ?? {}).some(
        (impl) => impl.kind === "composite"
      )
    );
    return board
      ? "a board's firmware level names no pin map: set pinMapFrom to the composite level whose expose is the header"
      : null;
  }
  const source = pinMapSource(part, ref);
  return "error" in source ? `pinMapFrom: ${source.error}` : null;
}

/** The field the lint names on a refused pin map. */
export const PIN_MAP_FIELD = "pinMapFrom";

/**
 * The lint's refusal of `part`'s pin map, among the load's diagnostics.
 * The loader keeps a root part with a lint error; the planner reads this
 * so a root board with no pin map sits idle too.
 */
export function pinMapRefused(
  diagnostics: readonly Diagnostic[],
  part: PartFile
): Diagnostic | undefined {
  return diagnostics.find(
    (diag) =>
      diag.severity === "error" &&
      diag.path === part.id &&
      diag.right === PIN_MAP_FIELD
  );
}

/**
 * The composite netlist a `pinMapFrom` names on `part`, or why it does not
 * resolve: the level is missing or not a composite, the instance is not in
 * its netlist, or no expose reaches that instance.
 */
export function pinMapSource(
  part: PartFile,
  ref: PinMapRef
): { netlist: Netlist; instance: string } | { error: string } {
  const at = `class ${ref.class} variant ${ref.variant}`;
  const impl =
    part.axes?.behaviour?.[String(ref.class) as "0"]?.variants[ref.variant];
  if (!impl) return { error: `${at} does not exist` };
  if (impl.kind !== "composite")
    return { error: `${at} is ${impl.kind}, not composite` };
  if (!impl.netlist.instances[ref.instance]) {
    return { error: `${at} has no instance ${ref.instance}` };
  }
  if (exposeOnto(impl.netlist, ref.instance).size === 0) {
    return { error: `${at} exposes no port of ${ref.instance}` };
  }
  return { netlist: impl.netlist, instance: ref.instance };
}

function selectedExpose(
  chip: LiveInstance,
  host: LiveInstance
): Map<string, string> {
  const netlist = behaviourNetlist(
    host.part,
    host.axes.behaviour.impl as BehaviourImpl | null
  );
  const child = chip.path.slice(chip.path.lastIndexOf(".") + 1);
  return netlist ? exposeOnto(netlist, child) : new Map();
}

/** The netlist's expose onto `child`'s ports, in expose order. */
function exposeOnto(netlist: Netlist, child: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [port, target] of Object.entries(netlist.expose)) {
    if (target.startsWith(`${child}.`)) {
      out.set(port, target.slice(child.length + 1));
    }
  }
  return out;
}
