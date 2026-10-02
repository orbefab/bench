/** Small shared helpers in parts: union-find, port-ref splitting, param merge. */
import { ok as expect } from "node:assert/strict";

import type { FormParam } from "@sfab-bench/contract";
import { mergeFormParams, splitPortRef, UnionFind } from "@sfab-bench/parts";

{
  const uf = new UnionFind();
  uf.add("b");
  uf.add("a");
  uf.add("c");
  expect(uf.find("a") === "a" && uf.find("b") === "b");
  uf.union("c", "b");
  expect(uf.find("c") === "b", "the smaller id is the root");
  uf.union("c", "a");
  expect(uf.find("b") === "a" && uf.find("c") === "a");
  uf.union("x.p", "x.q");
  expect(uf.has("x.p") && uf.find("x.q") === "x.p", "union adds unseen ids");
  expect(uf.find("x.p") !== uf.find("a"), "separate sets stay apart");
  expect(uf.ids().sort().join(",") === "a,b,c,x.p,x.q");
  let threw = false;
  try {
    uf.find("nope");
  } catch {
    threw = true;
  }
  expect(threw, "find throws on an id that was never added");
}

{
  const split = splitPortRef("servo.V+");
  expect(split?.inst === "servo" && split.port === "V+");
  const nested = splitPortRef("uno.reg.OUT");
  expect(nested?.inst === "uno.reg" && nested.port === "OUT", "last dot");
  const root = splitPortRef("$root.PORT");
  expect(root?.inst === "$root" && root.port === "PORT");
  expect(splitPortRef("$root") === null, "a bare $root has no port");
  expect(splitPortRef("servo") === null);
  expect(splitPortRef(".V+") === null);
  expect(splitPortRef("servo.") === null);
}

{
  const variant: Record<string, FormParam> = {
    R: 10,
    C: { v: 1e-6, q: "Capacitance", d: { kg: -1, m: -2, s: 4, A: 2 } },
    table: [
      [0, 1],
      [1, 2],
    ],
  };
  const same = mergeFormParams(variant, {});
  expect(same.R === 10 && Object.keys(same).join(",") === "R,C");
  expect(
    JSON.stringify(same.C) === JSON.stringify(variant.C),
    "the variant's tag survives"
  );

  const over = mergeFormParams(variant, { R: 22, C: 2e-6, table: 5, X: 1 });
  expect(over.R === 22, "the instance wins over the variant");
  expect(over.C === 2e-6, "an instance number replaces a tagged value");
  expect(!("table" in over), "a table is never listed or overridden");
  expect(!("X" in over), "the instance cannot add a key the variant lacks");

  const skip = mergeFormParams(variant, { R: "22", C: true });
  expect(skip.R === 10, "only a number overrides");
  expect(JSON.stringify(skip.C) === JSON.stringify(variant.C));

  const known = { R: "Resistance", esr: "Resistance" };
  const narrowed = mergeFormParams(variant, { esr: 0.1, R: 3, Z: 4 }, known);
  expect(
    Object.keys(narrowed).sort().join(",") === "R,esr",
    "known narrows the variant and lets the instance set an optional key"
  );
  expect(narrowed.R === 3 && narrowed.esr === 0.1);
}

console.log("parts-core.selfcheck ok");
