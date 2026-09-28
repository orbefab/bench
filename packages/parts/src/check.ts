/** Ported from layered-sim E7 (318b899). Plausible ranges are D-023. */

import {
  type BehaviourImpl,
  type BodyImpl,
  type Diagnostic,
  FORM_PARAMS,
  QUANTITY_DIM,
  type Quantity,
  RATING_FIELD_QUANTITY,
  type Ratings,
  SI_UNIT,
  type SiNumber,
  SUPPLY_FORMS,
  type VisualImpl,
} from "@sfab-bench/contract";
import { batteryFrom, ocvAt } from "./battery";
import type { LiveInstance } from "./levels";
import { collectPorts, type LiveNet, type LivePort, type Wire } from "./nets";
import { resolve } from "./path";
import {
  dimEqual,
  formatDim,
  formatRange,
  formatSi,
  isScalarParam,
  isTagged,
  makeDiag,
  numericRange,
  siValue,
} from "./si";
import type { Store } from "./store";

function inRange(v: number, range: [number, number]): boolean {
  return v >= range[0] && v <= range[1];
}

function tagDiags(inst: LiveInstance): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const [port, rating] of Object.entries(inst.part.ratings ?? {})) {
    walkRating(inst.path, port, rating as Record<string, unknown>, diags);
  }
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (behaviour?.kind === "form") {
    const form = FORM_PARAMS[behaviour.form];
    for (const [key, value] of Object.entries(behaviour.params)) {
      if (!isScalarParam(value)) continue;
      const expected = form?.params[key];
      if (expected && isTagged(value)) {
        checkTag(
          diags,
          inst.path,
          key,
          expected,
          value,
          `form ${behaviour.form} param ${key}`
        );
      }
    }
  }
  return diags;
}

function walkRating(
  instancePath: string,
  port: string,
  rating: Record<string, unknown>,
  diags: Diagnostic[]
): void {
  for (const [key, value] of Object.entries(rating)) {
    if (key === "logic" && value && typeof value === "object") {
      for (const [lk, lv] of Object.entries(value as Record<string, unknown>)) {
        const expected = RATING_FIELD_QUANTITY[lk];
        if (expected && isTag(lv)) {
          checkTag(diags, instancePath, port, expected, lv, `logic.${lk}`);
        }
      }
      continue;
    }
    const expected = RATING_FIELD_QUANTITY[key];
    if (!expected) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isTag(entry))
          checkTag(diags, instancePath, port, expected, entry, key);
      }
    } else if (isTag(value)) {
      checkTag(diags, instancePath, port, expected, value, key);
    }
  }
}

function isTag(
  value: unknown
): value is { v: number; q: string; d: Record<string, number>; unit?: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "q" in value &&
      "d" in value &&
      "v" in value
  );
}

function checkTag(
  diags: Diagnostic[],
  instancePath: string,
  port: string,
  expected: Quantity,
  tag: { v: number; q: string; d: Record<string, number>; unit?: string },
  field: string
): void {
  const claimedDim = formatDim(tag.d);
  const expectedDim = formatDim(QUANTITY_DIM[expected]);
  if (tag.q !== expected) {
    diags.push(
      makeDiag({
        severity: "error",
        path: instancePath,
        port,
        quantity: expected,
        left: `${tag.q} ${claimedDim} value ${tag.v}`,
        right: `${expected} ${expectedDim}`,
        detail: `field ${field} is quantity ${expected} but the value is tagged ${tag.q}`,
      })
    );
    return;
  }
  if (!dimEqual(tag.d, QUANTITY_DIM[expected])) {
    diags.push(
      makeDiag({
        severity: "error",
        path: instancePath,
        port,
        quantity: expected,
        left: `${claimedDim} value ${tag.v}`,
        right: expectedDim,
        detail: `field ${field} dimension does not match quantity ${expected}`,
      })
    );
    return;
  }
  if (tag.unit !== undefined && tag.unit !== SI_UNIT[expected]) {
    diags.push(
      makeDiag({
        severity: "error",
        path: instancePath,
        port,
        quantity: expected,
        left: tag.unit,
        right: SI_UNIT[expected],
        detail: `field ${field} unit is not SI`,
      })
    );
  }
}

function plausibilityDiags(inst: LiveInstance): Diagnostic[] {
  const ranges = inst.type.plausible;
  if (!ranges) return [];
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  const check = (
    port: string,
    field: string,
    quantity: Quantity,
    value: number
  ) => {
    const range = numericRange(ranges[quantity]);
    if (!range || inRange(value, range)) return;
    const key = `${port}|${field}|${quantity}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const scale =
      quantity === "Current" && Math.abs(value) >= 10
        ? `; ${value * 1000} mA`
        : "";
    diags.push(
      makeDiag({
        severity: "error",
        path: inst.path,
        port,
        quantity,
        left: `${formatSi(value, quantity)}${scale}`,
        right: formatRange(range, quantity),
        detail: `field ${field} is outside the plausible range for ${inst.type.id}`,
      })
    );
  };

  for (const [port, decl] of Object.entries(inst.type.ports)) {
    if (decl.ratings)
      walkPlausible(port, decl.ratings as Record<string, unknown>, check);
  }
  for (const [port, rating] of Object.entries(inst.part.ratings ?? {})) {
    walkPlausible(port, rating as Record<string, unknown>, check);
  }
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (behaviour?.kind === "form") {
    const form = FORM_PARAMS[behaviour.form];
    const params: Record<string, SiNumber> = {};
    for (const [key, value] of Object.entries(behaviour.params)) {
      if (isScalarParam(value)) params[key] = value;
    }
    for (const [key, override] of Object.entries(inst.params)) {
      if (typeof override === "number" && form?.params[key])
        params[key] = override;
    }
    for (const [key, value] of Object.entries(params)) {
      const quantity = form?.params[key];
      if (!quantity) continue;
      check(key, key, quantity, siValue(value));
    }
  }
  return diags;
}

function walkPlausible(
  port: string,
  rating: Record<string, unknown>,
  check: (
    port: string,
    field: string,
    quantity: Quantity,
    value: number
  ) => void
): void {
  for (const [key, value] of Object.entries(rating)) {
    if (key === "logic" && value && typeof value === "object") {
      for (const [lk, lv] of Object.entries(value as Record<string, unknown>)) {
        const quantity = RATING_FIELD_QUANTITY[lk];
        if (!quantity) continue;
        const n = numberOf(lv);
        if (n !== null) check(port, `logic.${lk}`, quantity, n);
      }
      continue;
    }
    const quantity = RATING_FIELD_QUANTITY[key];
    if (!quantity) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const n = numberOf(entry);
        if (n !== null) check(port, key, quantity, n);
      }
    } else {
      const n = numberOf(value);
      if (n !== null) check(port, key, quantity, n);
    }
  }
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (isTag(value)) return value.v;
  return null;
}

function wireDiags(instances: LiveInstance[], wires: Wire[]): Diagnostic[] {
  const ports = collectPorts(instances);
  const diags: Diagnostic[] = [];
  for (const wire of wires) {
    const pa = ports.get(wire.a.full);
    const pb = ports.get(wire.b.full);
    if (!pa) diags.push(missingPort(wire.a, pb));
    if (!pb) diags.push(missingPort(wire.b, pa));
    if (pa && pb && pa.domain !== pb.domain) {
      diags.push(
        makeDiag({
          severity: "error",
          path: pa.path,
          port: pa.port,
          quantity: pa.across,
          left: `${pa.domain} ${pa.across}`,
          right: `${pb.domain} ${pb.across}`,
          detail: `${pa.full} domain ${pa.domain} does not match ${pb.full} domain ${pb.domain}`,
        })
      );
    }
  }
  return diags;
}

function missingPort(
  end: { path: string; port: string; full: string },
  other: LivePort | undefined
): Diagnostic {
  return makeDiag({
    severity: "error",
    path: end.path,
    port: end.port,
    quantity: other?.across ?? "Port",
    left: "missing",
    right: other ? `${other.full} ${other.across}` : end.full,
    detail: `port ${end.port} does not exist`,
  });
}

function logicNumber(
  ratings: Ratings,
  key: "vil" | "vih" | "vol" | "voh"
): number | null {
  const raw = ratings.logic?.[key];
  if (raw === undefined) return null;
  return siValue(raw);
}

function isLogicDriver(port: LivePort): boolean {
  if (port.role !== "logic") return false;
  if (port.direction !== "out" && port.direction !== "inout") return false;
  return logicNumber(port.ratings, "voh") !== null;
}

function isLogicReceiver(port: LivePort): boolean {
  if (port.role !== "logic") return false;
  if (port.direction !== "in" && port.direction !== "inout") return false;
  return (
    logicNumber(port.ratings, "vih") !== null ||
    numericRange(port.ratings.absMaxVoltage) !== null
  );
}

function logicDiags(net: LiveNet): Diagnostic[] {
  if (net.domain !== "electrical") return [];
  const diags: Diagnostic[] = [];
  const drivers = net.ports.filter(isLogicDriver);
  const receivers = net.ports.filter(isLogicReceiver);
  for (const driver of drivers) {
    const voh = logicNumber(driver.ratings, "voh");
    const vol = logicNumber(driver.ratings, "vol");
    if (voh === null) continue;
    for (const receiver of receivers) {
      if (receiver.full === driver.full) continue;
      const abs = numericRange(receiver.ratings.absMaxVoltage);
      const vih = logicNumber(receiver.ratings, "vih");
      const vil = logicNumber(receiver.ratings, "vil");
      if (abs && (voh > abs[1] || (vol !== null && vol < abs[0]))) {
        const high = voh > abs[1];
        diags.push(
          makeDiag({
            severity: "error",
            path: receiver.path,
            port: receiver.port,
            quantity: "Voltage",
            left: formatSi(high ? voh : (vol ?? voh), "Voltage"),
            right: formatSi(high ? abs[1] : abs[0], "Voltage"),
            detail: `logic-incompatible: driver ${driver.full} output exceeds receiver ${receiver.full} abs-max`,
          })
        );
        continue;
      }
      if (vih !== null && voh < vih) {
        diags.push(
          makeDiag({
            severity: "error",
            path: receiver.path,
            port: receiver.port,
            quantity: "Voltage",
            left: formatSi(voh, "Voltage"),
            right: formatSi(vih, "Voltage"),
            detail: `logic-incompatible: driver ${driver.full} VOH is below receiver ${receiver.full} VIH`,
          })
        );
        continue;
      }
      if (vol !== null && vil !== null && vol > vil) {
        diags.push(
          makeDiag({
            severity: "error",
            path: receiver.path,
            port: receiver.port,
            quantity: "Voltage",
            left: formatSi(vol, "Voltage"),
            right: formatSi(vil, "Voltage"),
            detail: `logic-incompatible: driver ${driver.full} VOL is above receiver ${receiver.full} VIL`,
          })
        );
      }
    }
  }
  return diags;
}

function sourceVoltage(inst: LiveInstance, portName: string): number | null {
  const decl = inst.type.ports[portName];
  if (decl?.role !== "power" || decl?.direction !== "out") return null;
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (behaviour?.kind === "form" && behaviour.form === "battery@1") {
    const built = batteryFrom(behaviour.params, inst.params);
    return built.ok ? ocvAt(built.params.ocv, built.params.soc0) : null;
  }
  if (
    behaviour?.kind === "form" &&
    (SUPPLY_FORMS as readonly string[]).includes(behaviour.form)
  ) {
    const override = inst.params.V;
    if (typeof override === "number") return override;
    const value = behaviour.params.V;
    if (value !== undefined && isScalarParam(value)) return siValue(value);
  }
  const ratings = inst.part.ratings?.[portName] ?? decl.ratings;
  const range = numericRange(ratings?.voltage);
  if (range && range[0] === range[1]) return range[0];
  return null;
}

function supplyDiags(
  net: LiveNet,
  instances: Map<string, LiveInstance>
): Diagnostic[] {
  if (net.domain !== "electrical") return [];
  const diags: Diagnostic[] = [];
  const sources: { port: LivePort; voltage: number }[] = [];
  for (const port of net.ports) {
    if (port.role !== "power" || port.direction !== "out") continue;
    const inst = instances.get(port.path);
    if (!inst) continue;
    const voltage = sourceVoltage(inst, port.port);
    if (voltage === null) continue;
    sources.push({ port, voltage });
  }
  if (!sources.length) return diags;
  for (const port of net.ports) {
    if (port.role !== "power" || port.direction !== "in") continue;
    const operating = numericRange(port.ratings.voltage);
    if (!operating) continue;
    const abs = numericRange(port.ratings.absMaxVoltage);
    for (const source of sources) {
      if (source.port.full === port.full) continue;
      if (inRange(source.voltage, operating)) continue;
      const beyond = abs ? !inRange(source.voltage, abs) : false;
      diags.push(
        makeDiag({
          severity: beyond ? "error" : "warning",
          path: port.path,
          port: port.port,
          quantity: "Voltage",
          left: formatSi(source.voltage, "Voltage"),
          right:
            beyond && abs
              ? `${formatRange(abs, "Voltage")} abs-max`
              : formatRange(operating, "Voltage"),
          detail: beyond
            ? `supply ${source.port.full} is beyond abs-max of ${port.full}`
            : `supply ${source.port.full} is outside the operating range of ${port.full}`,
        })
      );
    }
  }
  return diags;
}

function fileDiags(
  instances: LiveInstance[],
  assetRoot: string,
  store: Store
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const inst of instances) {
    const body = inst.axes.body.impl as BodyImpl | null;
    if (body?.kind === "urdf" || body?.kind === "mjcf") {
      const abs = resolve(assetRoot, body.file);
      if (!store.exists(abs)) {
        diags.push(
          makeDiag({
            severity: "error",
            path: inst.path,
            port: "body",
            quantity: "Position",
            left: body.file,
            right: "missing file",
            detail: "body file does not exist",
          })
        );
      }
    }
    if (
      body?.kind === "children" &&
      (inst.axes.behaviour.impl as BehaviourImpl | null)?.kind !== "composite"
    ) {
      diags.push(
        makeDiag({
          severity: "error",
          path: inst.path,
          port: "body",
          quantity: "Mass",
          left: "children",
          right: inst.axes.behaviour.label,
          detail: "body children require a structural behaviour composite",
        })
      );
    }
    const visual = inst.axes.visual.impl as VisualImpl | null;
    if (visual?.kind === "mesh" && !visual.placeholder) {
      for (const file of visual.files) {
        if (!store.exists(resolve(assetRoot, file))) {
          diags.push(
            makeDiag({
              severity: "error",
              path: inst.path,
              port: "visual",
              quantity: "Position",
              left: file,
              right: "missing file",
              detail: "visual mesh does not exist",
            })
          );
        }
      }
    }
    const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
    if (behaviour?.kind === "firmware" && behaviour.imageParam) {
      const image = inst.params[behaviour.imageParam];
      if (
        typeof image === "string" &&
        !store.exists(resolve(assetRoot, image))
      ) {
        diags.push(
          makeDiag({
            severity: "error",
            path: inst.path,
            port: behaviour.imageParam,
            quantity: "Time",
            left: image,
            right: "missing file",
            detail: "firmware image does not exist",
          })
        );
      }
    }
  }
  return diags;
}

export function checkWorld(
  instances: LiveInstance[],
  nets: LiveNet[],
  wires: Wire[],
  assetRoot: string,
  store: Store
): Diagnostic[] {
  const byPath = new Map(instances.map((inst) => [inst.path, inst]));
  const diags: Diagnostic[] = [];
  for (const inst of instances) {
    diags.push(...tagDiags(inst), ...plausibilityDiags(inst));
  }
  diags.push(...wireDiags(instances, wires));
  for (const net of nets) {
    diags.push(...logicDiags(net), ...supplyDiags(net, byPath));
  }
  diags.push(...fileDiags(instances, assetRoot, store));
  diags.sort((a, b) => {
    const ka = `${a.severity}|${a.path}|${a.port}|${a.quantity}|${a.message}`;
    const kb = `${b.severity}|${b.path}|${b.port}|${b.quantity}|${b.message}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return diags;
}
