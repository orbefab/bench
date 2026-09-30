/**
 * `{ "$param": name }` in a netlist child: resolution one and two levels
 * down, a missing name, lint, and an edit round trip that keeps the ref.
 * A scratch project under the temp dir; the catalog and examples stay put.
 */
import { ok as expect } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Diagnostic,
  type EditOp,
  isParamRef,
  type NetlistInstance,
  type PartFile,
} from "@sfab-bench/contract";
import {
  applyEdit,
  declaredQuantity,
  documentNetlist,
  formatPart,
  loadWorldV2,
  partStyle,
} from "@sfab-bench/parts";

import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const NANO = "sfab/nano-ch340@1.0.0";
const dir = mkdtempSync(join(tmpdir(), "sfab-param-ref-"));
mkdirSync(join(dir, "parts/sfab"), { recursive: true });

function composite(
  id: string,
  instances: Record<string, NetlistInstance>
): PartFile {
  return {
    format: "sfab.part@1",
    id,
    type: "assembly",
    foreign: false,
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["test composite"],
              netlist: { instances, wires: [], expose: {} },
            },
          },
        },
      },
    },
  } as PartFile;
}

function write(part: PartFile): string {
  const name = part.id.split("/")[1] ?? part.id;
  const file = join(dir, "parts/sfab", `${name}.json`);
  writeFileSync(file, `${JSON.stringify(part, null, 2)}\n`);
  return file;
}

/** A world whose stage is `outer`, given these instance params. */
function world(
  id: string,
  outerParams: Record<string, string> | undefined
): string {
  const scene = composite(`sfab/${id}@1.0.0`, {
    outer: {
      part: "sfab/pr-outer@1.0.0",
      ...(outerParams ? { params: outerParams } : {}),
    },
  });
  return write({
    ...scene,
    play: {
      gravity: [0, 0, -9.81],
      seed: 1,
      levels: { default: 2 },
    },
  } as PartFile);
}

// The nano takes `firmware` and `source`. `mid` forwards them under other
// names, and `outer` forwards `mid`'s from its own.
const mid = composite("sfab/pr-mid@1.0.0", {
  board: {
    part: NANO,
    params: { firmware: { $param: "image" }, source: { $param: "sketch" } },
  },
});
const outer = composite("sfab/pr-outer@1.0.0", {
  mid: {
    part: "sfab/pr-mid@1.0.0",
    params: { image: { $param: "hex" }, sketch: "own.ino" },
  },
});
write(mid);
write(outer);

function load(file: string): {
  resolved: ReturnType<typeof loadWorldV2>["resolved"];
  errors: Diagnostic[];
} {
  const loaded = loadWorldV2(file, {
    store: nodeStore,
    catalogDir: catalogRoot(),
    assetRoot: dir,
  });
  return {
    resolved: loaded.resolved,
    errors: loaded.diagnostics.filter((diag) => diag.severity === "error"),
  };
}

// One level: `mid.board` sees the value `mid` was given, under the child's name.
// Two levels: that value came from `outer`'s `hex`.
{
  const good = load(world("pr-good", { hex: "firmware/a.hex" }));
  // A scene with one child runs that child as the stage, so `outer` is the
  // root path and its children are `mid` and `mid.board`.
  const board = good.resolved.find((inst) => inst.path === "mid.board");
  expect(
    board,
    `the nested board resolves: ${good.resolved.map((i) => i.path).join(",")}`
  );
  expect(
    board?.params.firmware === "firmware/a.hex",
    `two levels down: firmware is ${String(board?.params.firmware)}`
  );
  expect(board?.params.source === "own.ino", "a plain value passes through");
  const midInst = good.resolved.find((inst) => inst.path === "mid");
  expect(midInst?.params.image === "firmware/a.hex", "one level down");
  expect(
    good.resolved.every((inst) =>
      Object.values(inst.params).every((value) => !isParamRef(value))
    ),
    "no resolved instance carries a ref"
  );
  expect(
    good.errors.every((diag) => !/\$param/.test(diag.message)),
    "a satisfied ref raises no $param error"
  );
}

// The outer instance does not set `hex`: both forwards lose their value,
// and each says so. `firmware` is left out, never undefined.
{
  const bad = load(world("pr-missing", undefined));
  const board = bad.resolved.find((inst) => inst.path === "mid.board");
  expect(
    board && !("firmware" in board.params),
    "a missing forward leaves the key out"
  );
  const refs = bad.errors.filter((diag) => /\$param/.test(diag.message));
  expect(
    refs.some((diag) => diag.path === "mid" && diag.left === "hex"),
    `mid names hex: ${refs.map((diag) => diag.message).join(" | ")}`
  );
  expect(
    refs.some((diag) => diag.path === "mid.board"),
    "the board's own forward is reported too"
  );
}

// Lint: a name the parent cannot declare, and a malformed ref.
{
  const badParent = composite("sfab/pr-bad@1.0.0", {
    board: { part: NANO, params: { nope: { $param: "nope" } } },
  });
  write(badParent);
  const malformed = composite("sfab/pr-malformed@1.0.0", {
    board: { part: NANO, params: { firmware: { $param: 5 } } },
  } as unknown as Record<string, NetlistInstance>);
  write(malformed);
  const scene = composite("sfab/pr-lint@1.0.0", {
    a: { part: "sfab/pr-bad@1.0.0" },
    b: { part: "sfab/pr-malformed@1.0.0" },
    c: { part: "sfab/pr-mid@1.0.0", params: { image: "x.hex", sketch: "y" } },
  });
  const file = write({
    ...scene,
    play: { gravity: [0, 0, -9.81], seed: 1, levels: { default: 2 } },
  } as PartFile);
  const lint = load(file).errors;
  expect(
    lint.some(
      (diag) => diag.path === "a" && /does not declare/.test(diag.message)
    ),
    `an undeclared name lints on its instance: ${lint.map((diag) => `${diag.path}: ${diag.message}`).join(" | ")}`
  );
  expect(
    lint.some(
      (diag) => diag.path === "b" && /is not \{ "\$param"/.test(diag.message)
    ),
    "an object that is not a ref lints"
  );
  expect(
    !lint.some(
      (diag) =>
        (diag.path === "c" || diag.path.startsWith("c.")) &&
        /\$param|does not declare/.test(diag.message)
    ),
    "a declared forward does not lint"
  );
}

// A composite declares what it forwards, with the child's quantity.
const nano = JSON.parse(
  readFileSync(join(catalogRoot(), "parts/sfab/nano-ch340@1.0.0.json"), "utf8")
) as PartFile;
const byId = new Map<string, PartFile>([
  [NANO, nano],
  [mid.id, mid],
  [outer.id, outer],
]);
const partById = (id: string) => byId.get(id) ?? null;

{
  expect(
    declaredQuantity(mid, "image", partById) === "text",
    "mid declares image, as the nano's firmware image"
  );
  expect(
    declaredQuantity(outer, "hex", partById) === "text",
    "outer declares hex two levels up"
  );
  expect(
    declaredQuantity(mid, "firmware", partById) === null,
    "the child's own name is not the parent's"
  );
}

// Edits keep the ref: rename, set-param over it and back, remove and undo.
{
  const ctx = {
    names: ["doc"],
    partById,
    portsOf: () => null,
    domainOf: () => null,
    quantityOf: (id: string, name: string) => {
      const part = partById(id);
      return part ? declaredQuantity(part, name, partById) : null;
    },
  };
  const start = structuredClone(mid);
  const refOf = (part: PartFile) =>
    documentNetlist(part)?.instances.board?.params?.firmware;
  expect(isParamRef(refOf(start)), "the start has a ref");

  const renamed = applyEdit(
    start,
    { kind: "rename-instance", document: "doc", id: "board", to: "mcu" },
    ctx
  );
  expect("part" in renamed, "rename works");
  if (!("part" in renamed)) throw new Error("rename refused");
  expect(
    isParamRef(documentNetlist(renamed.part)?.instances.mcu?.params?.firmware),
    "rename keeps the ref"
  );
  const renamedBack = applyEdit(renamed.part, renamed.inverse, ctx);
  expect("part" in renamedBack, "rename undoes");
  if ("part" in renamedBack) {
    expect(
      JSON.stringify(renamedBack.part) === JSON.stringify(start),
      "rename then undo is byte-identical"
    );
  }

  const over = applyEdit(
    start,
    {
      kind: "set-param",
      document: "doc",
      id: "board",
      name: "firmware",
      value: "firmware/b.hex",
    },
    ctx
  );
  expect("part" in over, "set-param over a ref works");
  if (!("part" in over)) throw new Error("set-param refused");
  expect(
    documentNetlist(over.part)?.instances.board?.params?.firmware ===
      "firmware/b.hex",
    "the override is a plain value"
  );
  expect(
    isParamRef((over.inverse as Extract<EditOp, { kind: "set-param" }>).value),
    "the inverse carries the ref"
  );
  const undone = applyEdit(over.part, over.inverse, ctx);
  expect("part" in undone, "the override undoes");
  if ("part" in undone) {
    expect(
      JSON.stringify(undone.part) === JSON.stringify(start),
      "set-param then undo restores the ref byte for byte"
    );
  }

  // A ref can be written by set-param, and add-instance carries it.
  const back = applyEdit(
    over.part,
    {
      kind: "set-param",
      document: "doc",
      id: "board",
      name: "firmware",
      value: { $param: "image" },
    },
    ctx
  );
  expect(
    "part" in back &&
      isParamRef(documentNetlist(back.part)?.instances.board?.params?.firmware),
    "set-param accepts a ref"
  );

  const removed = applyEdit(
    start,
    { kind: "remove-instance", document: "doc", id: "board" },
    ctx
  );
  expect("part" in removed, "remove works");
  if ("part" in removed) {
    const restored = applyEdit(removed.part, removed.inverse, ctx);
    expect("part" in restored, "remove undoes");
    if ("part" in restored) {
      expect(
        JSON.stringify(restored.part) === JSON.stringify(start),
        "remove then undo restores the ref"
      );
    }
  }

  const added = applyEdit(
    start,
    {
      kind: "add-instance",
      document: "doc",
      id: "second",
      part: NANO,
      params: { firmware: { $param: "image" } },
    },
    ctx
  );
  expect(
    "part" in added &&
      isParamRef(
        documentNetlist(added.part)?.instances.second?.params?.firmware
      ),
    "add-instance carries a ref"
  );

  // The file writer keeps the object.
  const text = formatPart(start, partStyle(JSON.stringify(start, null, 2)));
  expect(
    text.includes('"$param": "image"') || text.includes('"$param":"image"'),
    "the formatted file still has the ref"
  );
}

rmSync(dir, { recursive: true, force: true });
console.log("param-ref: forwards resolve, lint, and survive edits");
