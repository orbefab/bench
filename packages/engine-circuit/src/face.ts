// L2 face over the MNA solver. The solver class keeps the name Engine.
import type { Engine } from "@sfab-bench/contract";
import { resistor, vSource } from "./elements";
import { Engine as Solver } from "./engine";
import type { Waveform } from "./wave";

export type CircuitLoad = {
  ohms: number;
  from: string;
  to: string;
};

/** A supply and resistive loads. Nodes are ports; `voltage` is the quantity. */
export type CircuitEngineSpec = {
  /** Fixed step, seconds. */
  h?: number;
  method?: "be" | "trap";
  supply: { volts: number; node: string };
  loads: CircuitLoad[];
};

/**
 * Port face of the circuit solver. `read(node, "voltage")` is the node
 * potential. `write("supply", "voltage", volts)` changes the source.
 */
export class CircuitEngine implements Engine {
  readonly id: string;
  private solver: Solver | null = null;
  private wave: Waveform | null = null;

  constructor(id = "circuit") {
    this.id = id;
  }

  init(spec: unknown): void {
    const parsed = circuitSpec(spec);
    const wave: Waveform = {
      kind: "step",
      t0: 0,
      v0: 0,
      v1: parsed.supply.volts,
    };
    this.wave = wave;
    this.solver = new Solver(
      [
        vSource("vs", parsed.supply.node, "0", wave),
        ...parsed.loads.map((load, index) =>
          resistor(`r${index}`, load.from, load.to, load.ohms)
        ),
      ],
      { method: parsed.method ?? "be", h: parsed.h ?? 1e-5 }
    );
  }

  advance(toSeconds: number): void {
    this.need().advanceTo(toSeconds);
  }

  read(port: string, quantity: string): number {
    if (quantity !== "voltage") {
      throw new Error(`circuit engine has no quantity ${quantity}`);
    }
    return this.need().voltage(port);
  }

  write(port: string, quantity: string, value: number): void {
    if (port !== "supply" || quantity !== "voltage") {
      throw new Error(`circuit engine cannot write ${port}.${quantity}`);
    }
    const wave = this.wave;
    const solver = this.need();
    if (wave?.kind !== "step") {
      throw new Error("circuit engine has no supply");
    }
    wave.v1 = value;
    if (solver.t > 0) solver.relinearize();
  }

  dispose(): void {
    this.solver = null;
    this.wave = null;
  }

  private need(): Solver {
    if (!this.solver) throw new Error("circuit engine is not initialised");
    return this.solver;
  }
}

function circuitSpec(spec: unknown): CircuitEngineSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error("circuit engine spec is missing");
  }
  const row = spec as CircuitEngineSpec;
  if (!row.supply || !(row.supply.volts >= 0) || !row.supply.node) {
    throw new Error("circuit engine spec needs a supply");
  }
  if (!Array.isArray(row.loads) || row.loads.length === 0) {
    throw new Error("circuit engine spec needs a load");
  }
  return row;
}
