// Ported from layered-sim E1 src/mna/spice.ts @ 031dc5e. Netlist text only; ngspice stays outside.
import type { Element } from "./element";
import {
  Capacitor,
  Diode,
  Inductor,
  ISource,
  Resistor,
  Switch,
  VSource,
} from "./elements";
import { waveSpice } from "./wave";

const num = (v: number) => v.toExponential(16);

export type SpiceOpts = {
  h: number;
  tStop: number;
  /** Max internal step. Defaults to h. */
  tmax?: number;
};

/** Same elements, one ngspice netlist. The title line is the circuit name. */
export function toSpice(
  name: string,
  elements: readonly Element[],
  opts: SpiceOpts
): string {
  const lines: string[] = [name];
  const models: string[] = [];
  for (const el of elements) {
    if (el instanceof Resistor) {
      lines.push(`R${el.id} ${el.aName} ${el.bName} ${num(el.R)}`);
    } else if (el instanceof Capacitor) {
      lines.push(`C${el.id} ${el.aName} ${el.bName} ${num(el.C)}`);
    } else if (el instanceof Inductor) {
      lines.push(`L${el.id} ${el.aName} ${el.bName} ${num(el.L)}`);
    } else if (el instanceof VSource) {
      lines.push(`V${el.id} ${el.pName} ${el.mName} ${waveSpice(el.wave)}`);
    } else if (el instanceof ISource) {
      lines.push(`I${el.id} ${el.pName} ${el.mName} ${waveSpice(el.wave)}`);
    } else if (el instanceof Diode) {
      const model = `D${el.id}`;
      const p = el.params;
      lines.push(`D${el.id} ${el.aName} ${el.kName} ${model}`);
      models.push(
        `.model ${model} D(Is=${num(p.Is)} N=${num(p.N)} Rs=${num(p.Rs)} EG=1.11 XTI=3)`
      );
    } else if (el instanceof Switch) {
      const model = `S${el.id}`;
      lines.push(`S${el.id} ${el.aName} ${el.bName} ctl_${el.id} 0 ${model}`);
      lines.push(`Vctl_${el.id} ctl_${el.id} 0 ${waveSpice(el.wave)}`);
      models.push(
        `.model ${model} SW(Vt=0.5 Ron=${num(el.Ron)} Roff=${num(el.Roff)})`
      );
    } else {
      throw new Error(`cannot export ${el.form}`);
    }
  }
  lines.push(...models);
  lines.push(
    ".options reltol=1e-6 abstol=1e-12 vntol=1e-7 gmin=1e-12 method=gear temp=25 tnom=25"
  );
  const tmax = opts.tmax ?? opts.h;
  lines.push(`.tran ${num(opts.h)} ${num(opts.tStop)} 0 ${num(tmax)}`);
  lines.push(".end");
  return `${lines.join("\n")}\n`;
}
