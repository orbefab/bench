/** Small shared helpers in parts: union-find and port-ref splitting. */
import { ok as expect } from "node:assert/strict";

import { splitPortRef, UnionFind } from "@sfab-bench/parts";

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

console.log("parts-core.selfcheck ok");
