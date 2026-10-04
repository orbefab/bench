/**
 * Form adapters. Stamps moved from the circuit and plan if-chains (layered-sim A2b).
 */
import type { BehaviourImpl, DiagCode, Pose } from "@sfab-bench/contract";
import type { Diode, Element } from "@sfab-bench/engine-circuit";
import type { LiveInstance } from "@sfab-bench/parts";

import type { AssignedPart } from "../circuit-stamp";
import type { RunPin, RunSupply } from "../plan";
import type { RunRanger } from "../ranger";

export type StampedElements = {
  elements: Element[];
  capacitive: boolean;
  led?: { path: string; diode: Diode };
};

/** What one placed form needs from the plan. The plan still owns the arrays. */
export type PlaceCtx = {
  inst: LiveInstance;
  /** The selected behaviour. Place is only called for a form. */
  behaviour: BehaviourImpl;
  typeId: string;
  /** Card and recording label: the part id without publisher or version. */
  model: string;
  numbers(): Record<string, number> | null;
  pins(): Record<string, RunPin>;
  /** The instance's pose in the document frame. */
  pose(): Pose;
  /** The board pin wired to `port`, when that wire lands on board GPIO. */
  peer(port: string): { boardId: string; bit: number } | null;
  /** A degraded row for this instance. Default code `bad-params`. */
  reject(detail: string, code?: DiagCode): void;
  addSupply(supply: RunSupply): void;
  addRanger(ranger: RunRanger): void;
  box(pick: "supply" | "part"): void;
};

/**
 * One form id. A circuit form stamps rail elements. A supply or sensor
 * form places itself on the plan. Param parse may call into parts.
 */
export type FormAdapter = {
  id: string;
  /**
   * Ports the stamp reads. Absent: every port of the type. A type that
   * lacks one of these does not run this form.
   */
  ports?: readonly string[];
  /**
   * The port the form draws its supply from, and the ports that supply
   * reaches. A part runs its law only when `from` is powered. Absent: no
   * supply dependency, and power crosses between all of its ports.
   */
  power?: { from: string; to: readonly string[] };
  /**
   * The part with its supply unmet: what it still contributes. Absent or
   * null: nothing, the part goes.
   */
  unpowered?: (part: AssignedPart) => AssignedPart | null;
  stamp?: (
    part: AssignedPart,
    assigned: readonly AssignedPart[]
  ) => StampedElements;
  parse?: (
    behaviour: BehaviourImpl,
    params: Record<string, number | string | boolean>
  ) => Record<string, number> | null;
  place?: (ctx: PlaceCtx) => void;
  /**
   * The form casts rays into the body world. A run with one moves every
   * geom out of the ray group except targets and static primitives.
   */
  rays?: boolean;
};
