# 2026-09-27 — Aligning Bench with the user manual and architecture note

Working note. The authoritative results are [`manual.md`](../manual.md),
[`architecture.md`](../architecture.md), [`product.md`](../product.md),
[ADR 0011](../decisions/0011-one-document-kind.md) and
[ADR 0012](../decisions/0012-layers-and-plugin-seams.md).

## Why

V11 and V12 landed on `world` (`6c19279`). PR #78 brought a user manual and
a lean architecture note, written against an older `main`. A review found the
simulation side already matched the note, and the product side (an editor)
did not exist. Every conflict was then settled with the owner, one decision
at a time.

## Conflicts found

| # | Conflict | Settled by |
| --- | --- | --- |
| C1 | `product.md`: chat is the main interface. Manual: no chat panel. | D1 |
| C2 | `product.md` and the manual: no authoring in the app. Owner: CAD and an MCU IDE belong in the vision. | D1b |
| C3 | ADR 0009: the `.world.json` is the document. Manual: one document kind. | D2 |
| C4 | Note: a capture is embedded in the part. Library parts are locked and versioned. | D3 |
| C5 | Manual: behaviour level only. V10 built body levels. | P4 |
| C6 | Manual: Play is always legal. Plan errors stop runs. | D5 |

## Decisions

- **D1 — editor and chat are peers.** Tools, the agent, and scripts emit the
  same typed edit operations into one document, with one undo history per
  tab. Chat is a collapsible panel beside the card.
- **D1b — authoring stays outside for now.** STEP, meshes, URDF, and
  firmware come from outside (a person, an external tool, or the agent
  running a tool in the folder); Bench watches and reloads. In-app part CAD
  and an MCU IDE are Later, after A6.
- **D2 — the part is the only document.** Ground becomes a ground part.
  Gravity, seed, and time step go in the part's `play` block, used only when
  that part is the root. `run.levels` becomes per-instance level choices,
  with default and type rules kept as `play.levels`. A one-time `.world.json`
  converter; one lock per root part ([ADR 0011](../decisions/0011-one-document-kind.md)).
- **D3 — a capture is a level in the UI and a sidecar on disk.** A
  `sfab.snapshot@1` file beside the part, referenced from its level list. A
  capture on a library part writes a project level overlay
  (`overlays/<pub>/<name>@<ver>.levels.json`).
- **D4 — ports bubble automatically, then become fixed** once a parent wire
  or a capture depends on them. Removing or renaming a fixed port asks
  (Stay / Break N) and lists its dependents. No port-rename UI in v1.
- **D5 — only an unreadable open document blocks Play.** Everything else
  degrades per part (nearest runnable level, idle, or a placeholder), with
  warnings on the tree row, as a 3D callout, and on the card.
- **P4 — one level picker per axis the part has** (behaviour, body, visual);
  missing axes hidden, unavailable levels grayed.
- **D6 — layer first:** A1 → A6. Each layering step keeps every printed
  self-check line.
- **D7 — compile-time plugin seams:** forms, tools, importers, engines
  ([ADR 0012](../decisions/0012-layers-and-plugin-seams.md)). Runtime
  third-party plugins are Later.
- **D8 — build and debug tools first.** A5: move/rotate/snap, mount, wire,
  probe. A6: the fixture tool, with Capture. Later: joints, measure, targets
  and paths, sensor frames, clips.
- **D9 — land it on `world`** with ADRs 0011 and 0012; close PR #78 as
  superseded.

## Simulation gaps against the note

- **G1 — no fixture supply inside a snapshot.** The Nano's class-1 board used
  a `feed` snapshot (`sfab/nano-usb-5v`) that carried the USB port's `Rs` and
  `Ilimit` and replaced the supply at run time. The Nano's class 1 becomes
  the V9 `sfab/nano-power-input@1.0.0` branch snapshot plus the board load,
  behind whatever supply part is in the scene, and the `feed` use is retired.
- **G1b — supplies are parts, with levels.** Generic presets on
  `thevenin-limit@1` (USB 2.0 and USB 3 host ports, a 1 A charger, a 2 A
  bench supply) and a generic `battery@1` form (open-circuit voltage against
  state of charge, internal resistance, capacity). Real supply models
  (a port's current-limit switch, measured chargers) are Later.
- **G1c — what is on the real board is in the board group.** The owner's
  rule: "If a normal Arduino nano has that power supply in the board, then in
  the board group we should have that power supply." The Nano's VIN → AMS1117
  and the Uno's VIN → NCP1117 with its source-select comparator become parts
  of their power-input groups, on a new `ldo-regulator@1` form.
- **G2 — energy residuals at the seams**, right after A2: joules per seam in
  the run report, flagged when they grow.
- **G3 — dirtying upward**, in A3: an inner edit marks every capture above
  it stale.

## Order

DOC (this change) → G1, G1b → G1c → A1 → A2 → G2 → A3 → A4 → A5 → A6.
Rows and proofs are in [`product.md`](../product.md) › Ranked next.

## Not now

In-app part CAD or an MCU IDE; runtime third-party plugins; a port-rename
UI; multiplayer cursors.
