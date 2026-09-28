# ADR-0011: One document kind — the part

**Status:** Accepted. Supersedes the world file of [ADR 0009](0009-world-simulation.md).
**Date:** 2026-09-27
**Deciders:** Alwurts

## Context

[ADR 0009](0009-world-simulation.md) made the world the document: a
`<name>.world.json` file holding one root part, an environment (ground
plane, gravity), and run settings (seed, time step, level rules). World v2
already puts the whole scene inside the root `assembly` part, so the world
file is a thin wrapper around a part.

The user manual ([`manual.md`](../manual.md), from PR #78) says there is one
kind of document, a part, and no hidden environment. It also says a capture
is a level on the captured part. Part files in a library are versioned and
locked (`sfab/sg90@1.0.0`, with lock hashes), so a capture cannot rewrite
them. The decisions were settled one at a time on 2026-09-27
([note](../notes/2026-09-27-bench-alignment.md), D2–D5).

## Decision

### The part is the only document

Play runs the open part. What the world wrapper held moves into parts:

- **Ground** is a ground part in the tree, like a supply or a fixture.
- **Gravity, seed, and time step** are the part's `play` block. It is read
  only when that part is the root of a run and shown on the root card. A
  part nested inside another keeps its `play` block, and it is ignored.
- **Level choices** are per instance, saved in the parent part. The
  default and type rules that `run.levels` held today stay as
  `play.levels` defaults.
- **The lock** is one file per root part.

A one-time converter turns a `.world.json` into a part with those fields.
Until the converter lands (A3 in [`product.md`](../product.md)), a world is
still a `.world.json` and ADR 0009's format stays in force.

### A capture is a level in the UI and a sidecar file on disk

Each capture is a `sfab.snapshot@1` file beside the part, and the part's
level list points at it. A capture on a library part writes a project
**level overlay**, `overlays/<pub>/<name>@<ver>.levels.json`, that adds
levels to every instance of that part in the project. The library file is
never written.

### Ports bubble, then become fixed

A composite's free nets bubble up as ports automatically, with
pin-derived names, until a parent wire or a capture depends on the port.
From then on the port is fixed. An edit that would remove or rename it
asks first (Stay / Break N) and lists its dependents. There is no port
rename UI in v1.

### Only an unreadable open document blocks Play

Everything else degrades per part: fall back to the nearest runnable level,
sit idle (unpowered, unsupported layout), or show a placeholder that sits
idle (missing file, bad params). Plan errors become `degraded` diagnostics,
shown on the tree row, as a 3D callout, and on the card.

## Consequences

### Positive
- One document kind, one open/save/undo path, one thing for the agent to edit.
- No invisible environment: everything that acts on a part is in the tree.
- Library parts and their lock hashes stay untouched by captures.
- Parents and captures keep working while a part's insides are rewired.
- Play never lectures; a broken child does not stop the rest of the run.

### Negative
- A format change: every example world converts, and every lock is rewritten.
- A capture is two files (part + sidecar), and an overlay is a third place a
  level can come from.
- A degraded run can hide a mistake that a hard error would have made obvious.

### Mitigations
- The converter is one-time, and a converted example must replay its old
  recording identically (the A3 proof).
- The card names each level's source (part, sidecar, or overlay).
- Every degradation is a warning shown three ways, and the run report lists them.

## Implementation notes

- The document model, typed edit operations, undo, the converter, the `play`
  block, fixed ports, and dirtying upward are A3, in `packages/parts`
  ([ADR 0012](0012-layers-and-plugin-seams.md)).
- D5 degradation moves plan errors into diagnostics in A2 (`packages/sim`).
- Sidecar and overlay writing is A6 (Capture from the card).
- [`formats.md`](../formats.md) changes with A3, not before.

## Related

- Supersedes the world file of [ADR 0009](0009-world-simulation.md); its run
  model (one shared run per document) stands.
- [ADR 0010](0010-layered-simulation.md): levels, snapshots, and types v1 stand.
- [ADR 0012](0012-layers-and-plugin-seams.md): where the document model lives.
- [`manual.md`](../manual.md), [`notes/2026-09-27-bench-alignment.md`](../notes/2026-09-27-bench-alignment.md).
