import { ok } from "node:assert/strict";
import { createMeshCache, meshCacheKey } from "./world-assets";

// No narrowing: the checks below compare the same values again after they change.
const expect: (cond: unknown, label: string) => void = ok;

const loads: string[] = [];
const disposed: number[] = [];
let next = 0;
const cache = createMeshCache(
  async (rel: string) => {
    loads.push(rel);
    next += 1;
    return next;
  },
  (value) => {
    disposed.push(value);
  }
);

const first = await cache.acquire("meshes/base.stl", 0);
const again = await cache.acquire("meshes/base.stl", 0);
expect(first === again && first === 1, "same revision reuses the loaded mesh");
expect(loads.length === 1, "same revision loads once");

const reloaded = await cache.acquire("meshes/base.stl", 1);
expect(reloaded === 2, "a new revision loads again");
expect(loads.length === 2, "reload does not reuse the old bytes");
expect(disposed.length === 0, "the old mesh stays until its keys are released");

const oldKey = meshCacheKey("meshes/base.stl", 0);
cache.release(oldKey);
expect(disposed.length === 0, "one of two refs still holds the old mesh");
cache.release(oldKey);
await Promise.resolve();
expect(
  disposed.length === 1 && disposed[0] === first,
  "releasing the old revision disposes only that mesh"
);
expect(!disposed.includes(reloaded), "the reloaded mesh is still held");

cache.release(meshCacheKey("meshes/base.stl", 1));
await Promise.resolve();
expect(disposed.includes(reloaded), "the new mesh disposes on its own release");

console.log("world-assets.selfcheck ok");
