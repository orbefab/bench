# ADR-0012: Layers and plugin seams

**Status:** Accepted
**Date:** 2026-09-27
**Deciders:** Alwurts

## Context

The simulation already runs as specialized engines on one master clock
([ADR 0010](0010-layered-simulation.md)): an MNA circuit engine, avr8js, and
MuJoCo, with typed snapshot forms. All of it lives in `apps/server/src/world/`,
beside `node:fs`, worker threads, and `ws`. One `worker.ts` of about 2,200 lines
is the orchestrator plus every form adapter. The engines are TypeScript or WASM,
so nothing stops them from running headless in Node, in a browser worker, or
in CI, except where the code sits.

(That was the tree on 2026-09-27. Since the split this ADR decided,
`packages/sim` owns the run and `worker.ts` is a host of about 50 lines.)

The owner asked for the code to decouple into levels, with the engine apart
from the UI, perhaps with plugins, and noted that the wire tool is only one of
many tools a robotics world simulator needs. The editor and chat are peers
that make the same edits ([note](../notes/2026-09-27-bench-alignment.md), D1).

## Decision

### Layers

Each layer imports only from layers below it. A lint rule fails any upward
import.

| Layer | Package | Contents | May not import |
| --- | --- | --- | --- |
| L0 | `packages/contract` | Types, formats, protocol messages | anything |
| L1 | `packages/parts` | Document model: part documents, typed edit operations with undo, loader, resolver, levels, nets, lint, lock. File access through a `Store` interface | engines, sim, server, UI, `node:fs` |
| L2 | `packages/engine-circuit`, `engine-mcu`, `engine-body` | One engine each behind an `Engine` interface (init, advance to t, read and write port quantities). No IO | parts, sim, server, UI |
| L3 | `packages/sim` | Plan (flatten, dispatch by form), form adapters, orchestrator (master clock, seams, energy residuals), recorder, capture runner | server, UI |
| L4 | hosts | Node worker host, CLI (`bench run`, `bench capture`, `bench lint`), later a browser-worker host | UI |
| L5 | `apps/server` | Projects and files (the `Store`), live socket, agent tools as the same edit operations plus run control | UI |
| L6 | `apps/web` | Editor shell (tabs, tree, stage, card, timeline, chat) and the tool framework | engines, sim internals (it speaks the protocol) |

### Edits

Tools, the agent, and scripts change a document only through L1's typed edit
operations (add, remove, wire, set param, set level, rename, …). There is one
undo history per open document. Nothing above L1 writes a part file directly.

**Maintenance exception (run 7, 2026-10-04).** `sfab-bench repin`
(`apps/server/src/repin.ts`) rewrites hash fields outside the edit path:
lock rows, and an assembly check's `fixture.lock` and `children[].hash`.
It writes the hash the loader already computes for each file as it is now,
replacing hex in place, so the diff is hash lines only. It changes no
document's meaning, no measurement, and no capture signature. A change that
is more than a pin (an id set, a document an assembly check measured) is
refused. Writes are staged through a journal and are recoverable, not
atomic as a set. Nothing else above L1 may use this exception.

### Plugin seams

Four compile-time registries of in-repo packages, each with a written
interface:

1. **Forms.** A form id, its param schema, lint rules, a run adapter (stamp
   into an engine, or run alone), a capture recipe, and a card renderer.
   The capture recipe lives on the part document (its `capture` field),
   else in the catalog's `capture.config.json`. Either way it is keyed by
   part id, not by type: `nano-power-input` and `uno-power-input` share a
   type and have their own recipes. The card reaches it through the world
   view (`capture` on each level axis), not by importing the lookup.
2. **Tools.** A mode, a hotkey, and a 3D interaction that emits edit
   operations.
3. **Importers.** One per asset category, converting to that category's
   canonical form.
4. **Engines.** Behind the L2 interface, so a second body engine or MCU core
   can be added.

Loading third-party plugins at run time is Later: it waits for the part
registry with publishing and signing, because it is a security surface.

## Consequences

### Positive
- The simulation runs headless (`bench run`) with no server, so CI and
  scripts use it directly. RL can build on it; it has no reset, observe
  or act API yet.
- The web client depends on the protocol, not on server code.
- A new form, tool, importer, or engine is one package in one registry.
- Undo, the agent, and scripts share one edit path.

### Negative
- A large move of code out of `apps/server` before any visible feature.
- More packages to build, version, and keep in step.

### Mitigations
- Layering goes first (A1, A2) and moves no printed self-check line; the
  line-diff of the full test log is the safety net.
- The lint boundary rule lands with A1, so drift fails early.

## Implementation notes

- A1: `packages/parts` and `packages/engine-circuit`, the `Store` interface,
  the lint rule.
- A2: `packages/sim`, `worker.ts` as a thin Node host, `bench run`, one rail
  path (a single board is the N = 1 case of the shared rail), D5 degradation.
- G2 (right after A2): energy residual per seam in the run report.
- A3 edit operations, A4 editor shell, A5 tool framework (move/rotate/snap,
  mount, wire, probe), A6 Capture from the card (fixture tool). Order and
  proofs: [`product.md`](../product.md) › Ranked next.
- Decoupled when: `bench run` prints the gauge's serial lines with no server;
  `apps/web` builds importing only the contract; the lint rule fails an
  upward import.

## Related

- [ADR 0010](0010-layered-simulation.md): the engines and forms this layers.
- [ADR 0011](0011-one-document-kind.md): the document model in L1.
- [`architecture.md`](../architecture.md), [`notes/2026-09-27-bench-alignment.md`](../notes/2026-09-27-bench-alignment.md).
