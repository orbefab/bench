/** Ported from layered-sim E7 (318b899). Port templates are D-023. */

import type {
  PartTypeFile,
  PortDecl,
  PortTemplate,
} from "@sfab-bench/contract";

function flagFor(
  spec: boolean | number[] | undefined,
  n: number
): boolean | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "boolean") return spec;
  return spec.includes(n);
}

function portFromTemplate(template: PortTemplate, n: number): PortDecl {
  const port: PortDecl = { domain: template.domain };
  if (template.role) port.role = template.role;
  if (template.direction) port.direction = template.direction;
  if (template.frame) port.frame = template.frame;
  const pwm = flagFor(template.pwm, n);
  const adc = flagFor(template.adc, n);
  if (pwm !== undefined) port.pwm = pwm;
  if (adc !== undefined) port.adc = adc;
  if (template.ratings) port.ratings = structuredClone(template.ratings);
  return port;
}

/** The checker and reports see expanded ports. The lock hashes the file as stored. */
export function expandPartType(type: PartTypeFile): PartTypeFile {
  const ports: Record<string, PortDecl> = { ...type.ports };
  for (const template of type.templates ?? []) {
    const [lo, hi] = template.n;
    for (let n = lo; n <= hi; n++) {
      const id = template.id.replaceAll("{n}", String(n));
      if (ports[id]) continue;
      ports[id] = portFromTemplate(template, n);
    }
  }
  const expanded: PartTypeFile = { ...type, ports };
  delete expanded.templates;
  return expanded;
}
