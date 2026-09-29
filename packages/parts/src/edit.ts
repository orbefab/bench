/**
 * Pure edits of one part document. No file access: the caller passes a
 * read-only view of the library. Every edit returns an inverse that
 * restores the part.
 */

import type {
  AxisLevel,
  AxisName,
  Diagnostic,
  EditOp,
  EditRefusal,
  LevelClass,
  LevelSpec,
  Netlist,
  NetlistInstance,
  PartFile,
  PlayBlock,
  PortRef,
  Pose,
  Quantity,
} from "@sfab-bench/contract";
import {
  DEFAULT_TIMESTEP_S,
  FORM_PARAMS,
  type Params,
} from "@sfab-bench/contract";

import { environmentKind } from "./document";
import { applyLevelEdit } from "./level-edit";
import { makeDiag, parsePartRef, splitPortRef } from "./si";

/** A refused edit: the diagnostic, and the detail its sentence was built from. */
export type EditFailure = Diagnostic & { detail: string };

export function refusalOf(failure: EditFailure): EditRefusal {
  const { path, port, quantity, left, right, detail } = failure;
  return { path, port, quantity, left, right, detail };
}

export type EditContext = {
  /** Paths that name this open document. */
  names: readonly string[];
  partById(id: string): PartFile | null;
  /** Port names on the part's type. Null when the part or its type is missing. */
  portsOf(partId: string): readonly string[] | null;
  /** The domain the part's type declares for a port. Null when it has none. */
  domainOf(partId: string, port: string): string | null;
  /**
   * The quantity of one behaviour param, or `"text"` for a firmware
   * path. Null when the part or the param is unknown.
   */
  quantityOf(partId: string, name: string): Quantity | "text" | null;
};

export type EditSuccess = { part: PartFile; inverse: EditOp };

const INSTANCE_ID = /^[A-Za-z0-9_-]+$/;

export function applyEdit(
  part: PartFile,
  op: EditOp,
  ctx: EditContext
): EditSuccess | { error: EditFailure } {
  const named = namesThis(op, ctx);
  if (named) return named;
  const next = structuredClone(part);
  const edited = applyTo(next, op, ctx);
  if ("error" in edited) return edited;
  return { part: next, inverse: edited.inverse };
}

export function editLabel(op: EditOp): string {
  switch (op.kind) {
    case "add-instance":
      return `added ${op.id}`;
    case "remove-instance":
      return `removed ${op.id}`;
    case "set-pose":
      return `set the pose of ${op.id}`;
    case "set-param":
      return `set ${op.id} ${op.name}`;
    case "set-level":
      return levelLabel(op);
    case "wire":
      return `wired ${op.a} to ${op.b}`;
    case "unwire":
      return `removed the wire from ${op.a} to ${op.b}`;
    case "rename-instance":
      return `renamed ${op.id} to ${op.to}`;
    case "rename-part":
      return `renamed the part to ${op.to}`;
    case "set-play":
      return "set play";
    case "batch":
      return op.label;
    case "pin-expose":
      return op.remove ? "unpinned ports" : "pinned ports";
  }
}

/** A tool or socket payload, checked before it is applied. */
export function readEditOp(value: unknown): EditOp | { error: string } {
  const read = readEditOpRaw(value);
  if ("error" in read || !value || typeof value !== "object") return read;
  const confirm = (value as { confirm?: unknown }).confirm;
  if (confirm === undefined) return read;
  if (confirm !== "break") return { error: "confirm must be break" };
  return { ...read, confirm: "break" };
}

function readEditOpRaw(value: unknown): EditOp | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "edit is not an operation" };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.document !== "string" || row.document.length === 0) {
    return { error: "edit needs a document" };
  }
  const document = row.document;
  switch (row.kind) {
    case "add-instance": {
      if (typeof row.id !== "string" || typeof row.part !== "string") {
        return { error: "add-instance needs an id and a part" };
      }
      let level: LevelSpec | undefined;
      if (row.level !== undefined) {
        const read = readLevelSpec(row.level);
        if ("error" in read) return read;
        level = read.level;
      }
      return {
        kind: "add-instance",
        document,
        id: row.id,
        part: row.part,
        ...(isPose(row.pose) ? { pose: row.pose } : {}),
        ...(isParams(row.params) ? { params: row.params } : {}),
        ...(level !== undefined ? { level } : {}),
      };
    }
    case "remove-instance":
      if (typeof row.id !== "string")
        return { error: "remove-instance needs an id" };
      return { kind: "remove-instance", document, id: row.id };
    case "set-pose":
      if (typeof row.id !== "string" || !isPose(row.pose)) {
        return { error: "set-pose needs an id and a pose" };
      }
      return { kind: "set-pose", document, id: row.id, pose: row.pose };
    case "set-param":
      if (typeof row.id !== "string" || typeof row.name !== "string") {
        return { error: "set-param needs an id and a name" };
      }
      if (!isParamValue(row.value)) return { error: "set-param needs a value" };
      return {
        kind: "set-param",
        document,
        id: row.id,
        name: row.name,
        value: row.value,
      };
    case "set-level": {
      if (
        row.scope !== "default" &&
        row.scope !== "type" &&
        row.scope !== "path"
      ) {
        return { error: "set-level needs a scope" };
      }
      if (
        row.class !== null &&
        row.class !== 0 &&
        row.class !== 1 &&
        row.class !== 2 &&
        row.class !== 3
      ) {
        return { error: "set-level needs a class" };
      }
      if (
        row.variant !== undefined &&
        (typeof row.variant !== "string" || row.variant.length === 0)
      ) {
        return { error: "set-level variant is not a name" };
      }
      return {
        kind: "set-level",
        document,
        scope: row.scope,
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        ...(row.axis === "behaviour" ||
        row.axis === "body" ||
        row.axis === "visual"
          ? { axis: row.axis }
          : {}),
        class: row.class,
        ...(typeof row.variant === "string" ? { variant: row.variant } : {}),
      };
    }
    case "wire":
    case "unwire":
      if (typeof row.a !== "string" || typeof row.b !== "string") {
        return { error: `${row.kind} needs two ports` };
      }
      return { kind: row.kind, document, a: row.a, b: row.b };
    case "rename-instance":
      if (typeof row.id !== "string" || typeof row.to !== "string") {
        return { error: "rename-instance needs an id and a new name" };
      }
      return { kind: "rename-instance", document, id: row.id, to: row.to };
    case "rename-part":
      if (typeof row.to !== "string" || row.to.length === 0) {
        return { error: "rename-part needs a new name" };
      }
      return { kind: "rename-part", document, to: row.to };
    case "set-play":
      return {
        kind: "set-play",
        document,
        ...(isVec3(row.gravity) ? { gravity: row.gravity } : {}),
        ...(typeof row.seed === "number" ? { seed: row.seed } : {}),
        ...(typeof row.timestep === "number" ? { timestep: row.timestep } : {}),
      };
    case "batch": {
      if (typeof row.label !== "string" || !Array.isArray(row.ops)) {
        return { error: "batch needs a label and operations" };
      }
      const ops: EditOp[] = [];
      for (const item of row.ops) {
        const read = readEditOp(item);
        if ("error" in read) return read;
        ops.push(read);
      }
      return { kind: "batch", document, label: row.label, ops };
    }
    default:
      return { error: "unknown edit" };
  }
}

function applyTo(
  part: PartFile,
  op: EditOp,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  switch (op.kind) {
    case "batch":
      return applyBatch(part, op, ctx);
    case "add-instance":
      return applyAdd(part, op, ctx);
    case "remove-instance":
      return applyRemove(part, op);
    case "set-pose":
      return applyPose(part, op);
    case "set-param":
      return applyParam(part, op, ctx);
    case "set-level":
      return applyLevel(part, op, ctx);
    case "wire":
      return applyWire(part, op, ctx);
    case "unwire":
      return applyUnwire(part, op);
    case "rename-instance":
      return applyRename(part, op);
    case "rename-part":
      return applyRenamePart(part, op, ctx);
    case "set-play":
      return applyPlay(part, op);
    case "pin-expose":
      return applyPin(part, op);
  }
}

function applyPin(
  part: PartFile,
  op: Extract<EditOp, { kind: "pin-expose" }>
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  if (op.remove) {
    for (const entry of op.entries) delete netlist.expose[entry.key];
  } else {
    for (const entry of op.entries) netlist.expose[entry.key] = entry.ref;
  }
  return {
    inverse: {
      kind: "pin-expose",
      document: op.document,
      entries: op.entries.map((entry) => ({ ...entry })),
      remove: !op.remove,
    },
  };
}

function applyBatch(
  part: PartFile,
  op: Extract<EditOp, { kind: "batch" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  if (op.ops.length === 0) {
    return fail(
      op.document,
      "edit",
      "Edit",
      "empty",
      "operations",
      "batch has no operations"
    );
  }
  if (op.ops.some(containsRename)) {
    return fail(
      op.document,
      "edit",
      "Edit",
      "rename-part",
      "its own step",
      "rename-part is its own step"
    );
  }
  const inverses: EditOp[] = [];
  for (const child of op.ops) {
    const named = namesThis(child, ctx);
    if (named) return named;
    const step = applyTo(part, child, ctx);
    if ("error" in step) return step;
    inverses.push(step.inverse);
  }
  inverses.reverse();
  return {
    inverse: {
      kind: "batch",
      document: op.document,
      label: op.label,
      ops: inverses,
    },
  };
}

function applyAdd(
  part: PartFile,
  op: Extract<EditOp, { kind: "add-instance" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const idError = checkId(op.id);
  if (idError) return fail(op.id, "id", "Instance", op.id, "name", idError);
  if (netlist.instances[op.id]) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      "free",
      `instance "${op.id}" already exists`
    );
  }
  if (op.restore) {
    const { index, instance, wires, expose, paths } = op.restore;
    netlist.instances = insertKey(netlist.instances, index, op.id, instance);
    for (const wire of [...wires].sort((a, b) => a.index - b.index)) {
      netlist.wires.splice(wire.index, 0, wire.pair);
    }
    if (expose.length > 0) {
      netlist.expose = insertEntries(netlist.expose, expose);
    }
    const levels = part.play?.levels;
    if (levels && paths.length > 0) {
      levels.paths = insertEntries(
        levels.paths ?? {},
        paths.map((row) => ({
          index: row.index,
          key: row.key,
          ref: row.spec,
        }))
      ) as Record<string, LevelSpec>;
    }
    return {
      inverse: { kind: "remove-instance", document: op.document, id: op.id },
    };
  }
  if (!ctx.partById(op.part)) {
    return fail(
      op.id,
      "part",
      "Part",
      op.part,
      "library",
      `part ${op.part} is not in the library`
    );
  }
  if (op.pose) {
    const poseError = checkPose(op.pose);
    if (poseError) return fail(op.id, "pose", "Pose", op.id, "pose", poseError);
  }
  let level: LevelSpec | undefined;
  if (op.level !== undefined) {
    const read = readLevelSpec(op.level);
    if ("error" in read) {
      return fail(op.id, "level", "Level", "level", "class", read.error);
    }
    level = read.level;
  }
  const instance: NetlistInstance = { part: op.part };
  if (op.pose) instance.pose = structuredClone(op.pose);
  if (op.params) instance.params = structuredClone(op.params);
  if (level !== undefined) instance.level = structuredClone(level);
  netlist.instances[op.id] = instance;
  return {
    inverse: { kind: "remove-instance", document: op.document, id: op.id },
  };
}

function applyRemove(
  part: PartFile,
  op: Extract<EditOp, { kind: "remove-instance" }>
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  if (!netlist.instances[op.id]) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      "present",
      `no instance "${op.id}"`
    );
  }
  const pairs = Object.entries(netlist.instances);
  const index = pairs.findIndex(([key]) => key === op.id);
  const instance = structuredClone(netlist.instances[op.id] as NetlistInstance);
  delete netlist.instances[op.id];
  const wires = netlist.wires
    .map((pair, at) => ({
      index: at,
      pair: [pair[0], pair[1]] as [PortRef, PortRef],
    }))
    .filter((wire) => wire.pair.some((ref) => touches(ref, op.id)));
  netlist.wires = netlist.wires.filter(
    (pair) => !pair.some((ref) => touches(ref, op.id))
  );
  const expose = Object.entries(netlist.expose)
    .map(([key, ref], at) => ({ index: at, key, ref }))
    .filter((row) => touches(row.ref, op.id));
  if (expose.length > 0) {
    const kept = Object.entries(netlist.expose).filter(
      ([, ref]) => !touches(ref, op.id)
    );
    netlist.expose = Object.fromEntries(kept);
  }
  const paths: { index: number; key: string; spec: LevelSpec }[] = [];
  const table = part.play?.levels.paths;
  if (table) {
    const entries = Object.entries(table);
    entries.forEach(([key, spec], at) => {
      if (underId(key, op.id))
        paths.push({ index: at, key, spec: structuredClone(spec) });
    });
    if (paths.length > 0) {
      const kept = entries.filter(([key]) => !underId(key, op.id));
      if (kept.length === 0) delete part.play?.levels.paths;
      else part.play!.levels.paths = Object.fromEntries(kept);
    }
  }
  return {
    inverse: {
      kind: "add-instance",
      document: op.document,
      id: op.id,
      part: instance.part,
      ...(instance.pose ? { pose: instance.pose } : {}),
      ...(instance.params ? { params: instance.params } : {}),
      ...(instance.level !== undefined ? { level: instance.level } : {}),
      restore: { index, instance, wires, expose, paths },
    },
  };
}

function applyPose(
  part: PartFile,
  op: Extract<EditOp, { kind: "set-pose" }>
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const instance = netlist.instances[op.id];
  if (!instance) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      "present",
      `no instance "${op.id}"`
    );
  }
  if (op.clear) {
    const previous = instance.pose ? structuredClone(instance.pose) : undefined;
    delete instance.pose;
    return {
      inverse: previous
        ? { kind: "set-pose", document: op.document, id: op.id, pose: previous }
        : { kind: "set-pose", document: op.document, id: op.id, clear: true },
    };
  }
  if (!op.pose)
    return fail(
      op.id,
      "pose",
      "Pose",
      "missing",
      "pose",
      "set-pose needs a pose"
    );
  const poseError = checkPose(op.pose);
  if (poseError) return fail(op.id, "pose", "Pose", op.id, "pose", poseError);
  const previous = instance.pose ? structuredClone(instance.pose) : undefined;
  instance.pose = structuredClone(op.pose);
  return {
    inverse: previous
      ? { kind: "set-pose", document: op.document, id: op.id, pose: previous }
      : { kind: "set-pose", document: op.document, id: op.id, clear: true },
  };
}

function applyParam(
  part: PartFile,
  op: Extract<EditOp, { kind: "set-param" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const instance = netlist.instances[op.id];
  if (!instance) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      "present",
      `no instance "${op.id}"`
    );
  }
  if (!op.clear) {
    const quantity = ctx.quantityOf(instance.part, op.name);
    if (!ctx.partById(instance.part)) {
      return fail(
        op.id,
        "part",
        "Part",
        instance.part,
        "library",
        `part ${instance.part} is not in the library`
      );
    }
    if (!quantity) {
      return fail(
        op.id,
        op.name,
        "Param",
        op.name,
        "known",
        `unknown param ${op.name}`
      );
    }
    if (op.value === undefined) {
      return fail(
        op.id,
        op.name,
        quantity,
        "missing",
        quantity,
        "set-param needs a value"
      );
    }
    if (quantity === "text") {
      if (typeof op.value !== "string") {
        return fail(
          op.id,
          op.name,
          "Param",
          String(op.value),
          "text",
          `param ${op.name} is text`
        );
      }
    } else if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
      return fail(
        op.id,
        op.name,
        quantity,
        String(op.value),
        quantity,
        `param ${op.name} is quantity ${quantity}`
      );
    }
  }
  const previous = instance.params?.[op.name];
  const had = instance.params ? Object.hasOwn(instance.params, op.name) : false;
  if (op.clear || op.value === undefined) {
    if (instance.params) {
      delete instance.params[op.name];
      if (Object.keys(instance.params).length === 0) delete instance.params;
    }
  } else {
    if (!instance.params) instance.params = {};
    instance.params[op.name] = op.value;
  }
  if (!had) {
    return {
      inverse: {
        kind: "set-param",
        document: op.document,
        id: op.id,
        name: op.name,
        clear: true,
      },
    };
  }
  return {
    inverse: {
      kind: "set-param",
      document: op.document,
      id: op.id,
      name: op.name,
      value: previous as number | string | boolean,
    },
  };
}

function applyLevel(
  part: PartFile,
  op: Extract<EditOp, { kind: "set-level" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  if (!part.play) {
    return fail(
      part.id,
      "play",
      "Level",
      "missing",
      "play.levels",
      "world file has no run.levels"
    );
  }
  const previous = structuredClone(part.play.levels);
  if (op.levels) {
    part.play.levels = structuredClone(op.levels);
    return { inverse: levelInverse(op, previous) };
  }
  if (op.variant) {
    const known = variantKnown(part, op, ctx);
    if (known) return known;
  }
  const edited = applyLevelEdit(part.play.levels, {
    scope: op.scope,
    ...(op.key !== undefined ? { key: op.key } : {}),
    ...(op.axis !== undefined ? { axis: op.axis } : {}),
    class: op.class,
    ...(op.variant !== undefined ? { variant: op.variant } : {}),
  });
  if ("error" in edited) {
    return fail(part.id, "levels", "Level", op.scope, "rule", edited.error);
  }
  part.play.levels = edited.levels;
  return { inverse: levelInverse(op, previous) };
}

function levelInverse(
  op: Extract<EditOp, { kind: "set-level" }>,
  previous: PlayBlock["levels"]
): EditOp {
  return {
    kind: "set-level",
    document: op.document,
    scope: op.scope,
    ...(op.key !== undefined ? { key: op.key } : {}),
    ...(op.axis !== undefined ? { axis: op.axis } : {}),
    ...(op.variant !== undefined ? { variant: op.variant } : {}),
    class: op.class,
    levels: previous,
  };
}

function applyWire(
  part: PartFile,
  op: Extract<EditOp, { kind: "wire" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const ends = [op.a, op.b];
  for (const ref of ends) {
    const split = splitPortRef(ref);
    if (!split) {
      return fail(
        part.id,
        ref,
        "Port",
        ref,
        "instance.port",
        "a wire end is instance.port"
      );
    }
    const instance = netlist.instances[split.inst];
    if (!instance) {
      return fail(
        split.inst,
        split.port,
        "Port",
        ref,
        "instance",
        `no instance "${split.inst}"`
      );
    }
    const ports = ctx.portsOf(instance.part);
    if (!ports) {
      return fail(
        split.inst,
        split.port,
        "Part",
        instance.part,
        "type",
        `part ${instance.part} is not in the library`
      );
    }
    if (!ports.includes(split.port)) {
      return fail(
        split.inst,
        split.port,
        "Port",
        "missing",
        ref,
        `port ${split.port} does not exist`
      );
    }
  }
  if (op.a === op.b) {
    return fail(
      part.id,
      op.a,
      "Port",
      op.a,
      op.b,
      `${op.a} cannot be wired to itself`
    );
  }
  const [domainA, domainB] = ends.map((ref) => {
    const split = splitPortRef(ref);
    const instance = split ? netlist.instances[split.inst] : undefined;
    return split && instance ? ctx.domainOf(instance.part, split.port) : null;
  });
  if (domainA && domainB && domainA !== domainB) {
    return fail(
      part.id,
      op.a,
      "Port",
      `${op.a} ${domainA}`,
      `${op.b} ${domainB}`,
      `${op.a} is ${domainA} and ${op.b} is ${domainB}; a wire joins ports of one domain`
    );
  }
  const pair: [PortRef, PortRef] = [op.a, op.b];
  if (netlist.wires.some((wire) => sameWire(wire, pair))) {
    return fail(
      part.id,
      op.a,
      "Port",
      op.a,
      op.b,
      `wire ${op.a} to ${op.b} already exists`
    );
  }
  const index = op.index ?? netlist.wires.length;
  netlist.wires.splice(index, 0, pair);
  return {
    inverse: { kind: "unwire", document: op.document, a: op.a, b: op.b },
  };
}

function applyUnwire(
  part: PartFile,
  op: Extract<EditOp, { kind: "unwire" }>
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const index = netlist.wires.findIndex((wire) => sameWire(wire, [op.a, op.b]));
  if (index < 0) {
    return fail(
      part.id,
      op.a,
      "Port",
      op.a,
      op.b,
      `no wire from ${op.a} to ${op.b}`
    );
  }
  const pair = netlist.wires[index] as [PortRef, PortRef];
  netlist.wires.splice(index, 1);
  return {
    inverse: {
      kind: "wire",
      document: op.document,
      a: pair[0],
      b: pair[1],
      index,
    },
  };
}

function applyRename(
  part: PartFile,
  op: Extract<EditOp, { kind: "rename-instance" }>
): { inverse: EditOp } | { error: EditFailure } {
  const netlist = needNetlist(part);
  if ("error" in netlist) return netlist;
  const idError = checkId(op.to);
  if (idError) return fail(op.to, "id", "Instance", op.to, "name", idError);
  if (!netlist.instances[op.id]) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      "present",
      `no instance "${op.id}"`
    );
  }
  if (op.to === op.id) {
    return fail(
      op.id,
      "id",
      "Instance",
      op.id,
      op.to,
      "rename leaves the name unchanged"
    );
  }
  if (netlist.instances[op.to]) {
    return fail(
      op.to,
      "id",
      "Instance",
      op.to,
      "free",
      `instance "${op.to}" already exists`
    );
  }
  netlist.instances = renameKey(netlist.instances, op.id, op.to);
  netlist.wires = netlist.wires.map(
    (pair) =>
      [renameRef(pair[0], op.id, op.to), renameRef(pair[1], op.id, op.to)] as [
        PortRef,
        PortRef,
      ]
  );
  netlist.expose = renameValues(netlist.expose, op.id, op.to);
  if (part.play?.levels.paths) {
    part.play.levels.paths = renameKeyPrefix(
      part.play.levels.paths,
      op.id,
      op.to
    );
  }
  return {
    inverse: {
      kind: "rename-instance",
      document: op.document,
      id: op.to,
      to: op.id,
    },
  };
}

function applyRenamePart(
  part: PartFile,
  op: Extract<EditOp, { kind: "rename-part" }>,
  ctx: EditContext
): { inverse: EditOp } | { error: EditFailure } {
  const parsed = parsePartRef(part.id);
  if (!parsed) {
    return fail(
      part.id,
      "id",
      "Part",
      part.id,
      "name",
      "this part has no name"
    );
  }
  const to = op.to.trim();
  if (!/^[a-z0-9-]+$/.test(to)) {
    return fail(
      part.id,
      "id",
      "Part",
      to,
      "name",
      "the name is not a part name"
    );
  }
  if (to === parsed.name) {
    return fail(
      part.id,
      "id",
      "Part",
      to,
      parsed.name,
      "the name is unchanged"
    );
  }
  const toId = `${parsed.publisher}/${to}@${parsed.version}`;
  if (ctx.partById(toId)) {
    return fail(part.id, "id", "Part", toId, "free", `${toId} already exists`);
  }
  part.id = toId;
  return {
    inverse: { kind: "rename-part", document: op.document, to: parsed.name },
  };
}

function containsRename(op: EditOp): boolean {
  if (op.kind === "rename-part") return true;
  if (op.kind === "batch") return op.ops.some(containsRename);
  return false;
}

function applyPlay(
  part: PartFile,
  op: Extract<EditOp, { kind: "set-play" }>
): { inverse: EditOp } | { error: EditFailure } {
  if (op.play) {
    part.play = structuredClone(op.play);
    return {
      inverse: { kind: "set-play", document: op.document, clear: true },
    };
  }
  if (op.clear) {
    const previous = part.play ? structuredClone(part.play) : undefined;
    delete part.play;
    return {
      inverse: previous
        ? { kind: "set-play", document: op.document, play: previous }
        : { kind: "set-play", document: op.document, clear: true },
    };
  }
  if (op.gravity) {
    if (!op.gravity.every((n) => Number.isFinite(n))) {
      return fail(
        part.id,
        "gravity",
        "Acceleration",
        "not finite",
        "m/s²",
        "gravity is not finite"
      );
    }
  }
  if (op.seed !== undefined && !Number.isFinite(op.seed)) {
    return fail(
      part.id,
      "seed",
      "Seed",
      String(op.seed),
      "number",
      "seed is not finite"
    );
  }
  if (op.timestep !== undefined && !(op.timestep > 0)) {
    return fail(
      part.id,
      "timestep",
      "Time",
      String(op.timestep),
      "s",
      "timestep must be greater than 0"
    );
  }
  if (
    op.gravity === undefined &&
    op.seed === undefined &&
    op.timestep === undefined
  ) {
    return fail(
      part.id,
      "play",
      "Play",
      "empty",
      "gravity, seed, timestep",
      "set-play changes nothing"
    );
  }
  const had = part.play;
  const previous = had
    ? {
        gravity: [...had.gravity] as [number, number, number],
        seed: had.seed,
        timestep: had.timestep,
      }
    : null;
  if (!part.play) {
    part.play = {
      gravity: op.gravity ? [...op.gravity] : [0, 0, -9.81],
      seed: op.seed ?? 1,
      timestep: op.timestep ?? DEFAULT_TIMESTEP_S,
      levels: { default: 1 },
    };
    return {
      inverse: { kind: "set-play", document: op.document, clear: true },
    };
  }
  if (op.gravity) part.play.gravity = [...op.gravity];
  if (op.seed !== undefined) part.play.seed = op.seed;
  if (op.timestep !== undefined) part.play.timestep = op.timestep;
  const inverse: Extract<EditOp, { kind: "set-play" }> = {
    kind: "set-play",
    document: op.document,
  };
  if (op.gravity && previous) inverse.gravity = previous.gravity;
  if (op.seed !== undefined && previous) inverse.seed = previous.seed;
  if (op.timestep !== undefined && previous)
    inverse.timestep = previous.timestep;
  return { inverse };
}

function variantKnown(
  part: PartFile,
  op: Extract<EditOp, { kind: "set-level" }>,
  ctx: EditContext
): { error: EditFailure } | null {
  if (!op.variant || !op.axis || op.class === null) return null;
  if (op.scope === "path") {
    if (!op.key) return null;
    const found = partAtPath(part, op.key, ctx);
    if ("error" in found) {
      return fail(op.key, op.axis, "Level", op.key, "instance", found.error);
    }
    return variantOn(found, op.axis, op.class, op.variant);
  }
  if (op.scope === "type") {
    if (!op.key) return null;
    const parts = partsOfType(part, op.key, ctx);
    if (parts.length === 0) {
      return fail(
        op.key,
        op.axis,
        "Level",
        op.variant,
        "no expanded part",
        `type ${op.key} has no expanded part, so variant ${op.variant} cannot be checked`
      );
    }
    for (const item of parts) {
      const miss = variantOn(item, op.axis, op.class, op.variant);
      if (miss) return miss;
    }
    return null;
  }
  for (const item of expandedParts(part, ctx)) {
    const miss = variantOn(item, op.axis, op.class, op.variant);
    if (miss) return miss;
  }
  return null;
}

function variantOn(
  part: PartFile,
  axis: AxisName,
  level: LevelClass,
  name: string
): { error: EditFailure } | null {
  const slot = part.axes?.[axis]?.[String(level) as "0"];
  const names = slot ? Object.keys(slot.variants) : [];
  if (names.includes(name)) return null;
  return fail(
    part.id,
    axis,
    "Level",
    name,
    names.join(",") || "none",
    `class ${level} variant ${name} is not on this part`
  );
}

/** The part a path rule names, after the loader's single-scene unwrap. */
function partAtPath(
  root: PartFile,
  path: string,
  ctx: EditContext
): PartFile | { error: string } {
  let current = scenePart(root, ctx);
  for (const seg of path.split(".")) {
    if (!seg) return { error: `no path "${path}"` };
    const netlist = documentNetlist(current);
    const inst = netlist?.instances[seg];
    if (!inst) return { error: `no path "${path}"` };
    const child = ctx.partById(inst.part);
    if (!child) return { error: `part ${inst.part} is not in the library` };
    current = child;
  }
  return current;
}

function partsOfType(
  root: PartFile,
  typeId: string,
  ctx: EditContext
): PartFile[] {
  return expandedParts(root, ctx).filter((part) => part.type === typeId);
}

function expandedParts(root: PartFile, ctx: EditContext): PartFile[] {
  const out: PartFile[] = [];
  const seen = new Set<string>();
  const walk = (part: PartFile) => {
    if (seen.has(part.id)) return;
    seen.add(part.id);
    out.push(part);
    const netlist = documentNetlist(part);
    if (!netlist) return;
    for (const inst of Object.values(netlist.instances)) {
      const child = ctx.partById(inst.part);
      if (child) walk(child);
    }
  };
  walk(scenePart(root, ctx));
  return out;
}

function scenePart(root: PartFile, ctx: EditContext): PartFile {
  const netlist = documentNetlist(root);
  if (!netlist) return root;
  const rest = Object.values(netlist.instances).filter((inst) => {
    const child = ctx.partById(inst.part);
    return !child || environmentKind(child) === "other";
  });
  if (rest.length !== 1) return root;
  return ctx.partById(rest[0]?.part ?? "") ?? root;
}

function levelLabel(op: Extract<EditOp, { kind: "set-level" }>): string {
  const where =
    op.scope === "default"
      ? "the default level"
      : `${op.scope} ${op.key ?? ""}`.trim();
  const axis = op.axis ? ` ${op.axis}` : "";
  if (op.class === null) return `cleared ${where}${axis}`;
  const named = op.variant ? ` variant ${op.variant}` : "";
  return `set ${where}${axis} to class ${op.class}${named}`;
}

function namesThis(
  op: EditOp,
  ctx: EditContext
): { error: EditFailure } | null {
  if (ctx.names.includes(op.document)) return null;
  return fail(
    op.document,
    "file",
    "Part",
    op.document,
    ctx.names[0] ?? "document",
    "an edit names a different document"
  );
}

function needNetlist(part: PartFile): Netlist | { error: EditFailure } {
  const netlist = documentNetlist(part);
  if (!netlist) {
    return fail(
      part.id,
      "netlist",
      "Part",
      "missing",
      "composite",
      "this part has no netlist"
    );
  }
  return netlist;
}

/** The composite the loader treats as this document's children. */
export function documentNetlist(part: PartFile): Netlist | null {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return null;
  const preferred = behaviour["2"] ? [behaviour["2"]] : [];
  const slots = [...preferred, ...Object.values(behaviour)];
  for (const slot of slots) {
    if (!slot) continue;
    const variant =
      slot.variants[slot.default] ?? Object.values(slot.variants)[0];
    if (variant?.kind === "composite") return variant.netlist;
  }
  return null;
}

export function quantityOn(
  part: PartFile,
  name: string
): Quantity | "text" | null {
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

function fail(
  path: string,
  port: string,
  quantity: string,
  left: string,
  right: string,
  detail: string
): { error: EditFailure } {
  return {
    error: {
      ...makeDiag({
        severity: "error",
        path,
        port,
        quantity,
        left,
        right,
        detail,
      }),
      detail,
    },
  };
}

function checkId(id: string): string | null {
  if (!INSTANCE_ID.test(id))
    return "an instance name is one word, without a dot";
  return null;
}

function checkPose(pose: Pose): string | null {
  if (!Array.isArray(pose.position) || pose.position.length !== 3)
    return "pose needs a position";
  if (!Array.isArray(pose.rotation) || pose.rotation.length !== 4)
    return "pose needs a rotation";
  const nums = [...pose.position, ...pose.rotation];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n)))
    return "pose is not finite";
  return null;
}

function readLevelSpec(
  value: unknown
): { level: LevelSpec } | { error: string } {
  const bad = { error: "add-instance level is not a class" };
  if (value === 0 || value === 1 || value === 2 || value === 3) {
    return { level: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 0) return bad;
  const spec: Partial<Record<AxisName, AxisLevel>> = {};
  for (const key of keys) {
    if (key !== "behaviour" && key !== "body" && key !== "visual") return bad;
    const axis = readAxisLevel(row[key]);
    if (!axis) return bad;
    spec[key] = axis;
  }
  return { level: spec };
}

function readAxisLevel(value: unknown): AxisLevel | null {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (!keys.includes("class")) return null;
  for (const key of keys) {
    if (key !== "class" && key !== "variant") return null;
  }
  if (
    row.class !== 0 &&
    row.class !== 1 &&
    row.class !== 2 &&
    row.class !== 3
  ) {
    return null;
  }
  if (row.variant === undefined) return row.class;
  if (typeof row.variant !== "string" || row.variant.length === 0) return null;
  return { class: row.class, variant: row.variant };
}

function isPose(value: unknown): value is Pose {
  if (!value || typeof value !== "object") return false;
  const pose = value as Pose;
  return Array.isArray(pose.position) && Array.isArray(pose.rotation);
}

function isParams(value: unknown): value is Params {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isParamValue);
}

function isParamValue(value: unknown): value is number | string | boolean {
  return (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  );
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number")
  );
}

function touches(ref: string, id: string): boolean {
  const split = splitPortRef(ref);
  if (!split) return false;
  return split.inst === id || split.inst.startsWith(`${id}.`);
}

function underId(key: string, id: string): boolean {
  return key === id || key.startsWith(`${id}.`);
}

function renamePath(key: string, id: string, to: string): string {
  if (key === id) return to;
  if (key.startsWith(`${id}.`)) return to + key.slice(id.length);
  return key;
}

function renameRef(ref: string, id: string, to: string): string {
  const split = splitPortRef(ref);
  if (!split) return ref;
  const inst = renamePath(split.inst, id, to);
  if (inst === split.inst) return ref;
  return `${inst}.${split.port}`;
}

function sameWire(wire: [string, string], pair: [string, string]): boolean {
  return (
    (wire[0] === pair[0] && wire[1] === pair[1]) ||
    (wire[0] === pair[1] && wire[1] === pair[0])
  );
}

function insertKey<T>(
  obj: Record<string, T>,
  index: number,
  key: string,
  value: T
): Record<string, T> {
  const pairs = Object.entries(obj);
  const at = Math.max(0, Math.min(index, pairs.length));
  pairs.splice(at, 0, [key, value]);
  return Object.fromEntries(pairs);
}

function insertEntries<T>(
  obj: Record<string, T>,
  rows: { index: number; key: string; ref: T }[]
): Record<string, T> {
  const pairs = Object.entries(obj);
  for (const row of [...rows].sort((a, b) => a.index - b.index)) {
    pairs.splice(row.index, 0, [row.key, row.ref]);
  }
  return Object.fromEntries(pairs);
}

function renameKey<T>(
  obj: Record<string, T>,
  from: string,
  to: string
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key === from ? to : key] = value;
  }
  return out;
}

function renameKeyPrefix<T>(
  obj: Record<string, T>,
  id: string,
  to: string
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[renamePath(key, id, to)] = value;
  }
  return out;
}

function renameValues(
  obj: Record<string, string>,
  id: string,
  to: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = renameRef(value, id, to);
  }
  return out;
}
