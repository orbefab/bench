# Bench — user manual (ideal)

**Audience:** someone using Bench (and implementers checking *what* the product does)  
**Status:** product draft from shaping (2026-09-27) · box only — not GitHub  
**Pair with:** `bench-architecture.md` (engines & contracts) · full lock scratch: `bench-world-builder-ux.md`

This reads as if the app already exists. It does not describe file schemas, solvers, or code layout.

---

## What Bench is

Bench is a **3D world builder for parts**. Everything you open, nest, wire, play, and capture is a **part**. There is no separate “world” or “group” kind of thing — a fixture, a robot, and a lone servo are the same kind of document at different depths.

You compose parts inside parts, connect their **ports**, **Play** to see behaviour, and **Capture** a part’s behaviour when you want a cheaper stand-in later. Same chrome everywhere, including Quest (tighter, not different).

---

## The screen

- **Left — tree:** quiet list of what’s in the open part (subparts and wires). Rows are mostly bare (name + indent) — no fidelity essays on every line. **One selection at a time** (v1). **No outliner search** in v1.
- **Center — stage:** the 3D view. Empty ports show as markers. A lonely part sits on a **visual grid only** — nothing invisible is holding it up or powering it.
- **Right — card:** the selected thing — ports, live signals (follow the playhead while scrubbing), params, behaviour level, warnings, Capture, Open part, Rename part file, level history.
- **Top — tabs + thin breadcrumb:** each open part file is a tab (CAD-style). Opening a child part opens/focuses its tab; the previous tab **parks**.
- **Under stage — timeline:** play, pause, scrub. **Always** there. Capture progress also uses this bar while a capture runs.

Quest uses this same full chrome, just tighter. No special agent play/pause controls and no stored “agent ran this” badge in the UI — conversation history is enough.

---

## Files

You work in **one kind of file**: a part. **New** always asks for a **name and location**; the usual default folder suggestion is under `parts/`.

There is no hidden environment. If the part needs 5 V, you **Add a power part** (or build a parent that contains this part plus that supply). Starter kits that drop a ready bench come **later**; v1 is library **Add** only.

---

## Naming (instance vs file vs ports)

Bench keeps three naming ideas separate on purpose.

### 1. Instance name (what you see in the tree)

- **Where:** the tree row (inline rename on the selected row).
- **What it renames:** only **this placement** inside the parent — the label in *this* assembly (“left-wheel-servo”), not the library asset on disk.
- **When:** anytime you’re organizing the tree. Other instances of the same part file keep their own names.
- **What it does *not* do:** it does not rename the part file, does not rename ports, and does not rename Capture history levels.

### 2. Part file name (the library / disk asset)

- **Where:** a deliberate action on the **card** (or ⋯) — **Rename part file**. Never the same gesture as tree rename.
- **What it renames:** the underlying part document (how it appears as an asset you Add later).
- **When:** only when you mean to change the shared definition’s identity on disk — not when you’re just clarifying a role in one parent.
- **Why split:** so a quick double-click in the tree can’t accidentally rename the library servo everyone else instances.

### 3. Ports

- Ports are **always listed** on the card and shown as markers in 3D when empty/free.
- On composites, free child connections **bubble up** as this part’s ports automatically — **one outer port per free net** (not every child pin on that net).
- Names come from **pin-derived naming plus a collision heuristic**. In v1 there is **no port rename** UI (avoids a third rename tangle). Star / pin-to-publish expose controls are deferred.

### 4. Capture level names

- Captures appear as **behaviour levels** on the part (history you can pick and delete).
- New level naming can start as a simple auto-name; you can rename on the card. That is separate from instance rename and file rename.

| Gesture | Renames | Does not rename |
|---------|---------|-----------------|
| Tree row | This instance’s label in the parent | Part file, ports, other instances |
| Card → Rename part file | The part document on disk | Tree instance labels elsewhere (until refreshed from file) |
| (v1) nothing | Ports | — use bubbled / pin-derived names |
| Card level | A Capture history entry’s label | Instance or file |

---

## Build

1. **New** a part (or open one) — name + location dialog as above.
2. **Add** subparts from **one library picker** (leaves and composites). Soft filters later. They appear at a **default pose, selected** — drag to move; no special place-mode.
3. **Wire** with the wire tool (**W**): click **port → port in 3D** (card wiring is backup). **Esc** or **click empty** cancels. Wires are parts too: they show as **instance rows** in the tree; endpoints on the card / hover; **select → Delete/Backspace** to remove. Wires are **not** added from the library picker.
4. Bubbled outer ports appear as you leave free nets (see Naming).

**Duplicate** is a shortcut. There is **no** separate palette in v1, and **no** “New file with this selection” shortcut — New + Add is enough.

Meshes and similar are made **outside** Bench; Bench is assemble / simulate, not a full part-CAD suite.

---

## Play

Press **Play** (Space) anytime. The timeline runs.

What you get is whatever you composed. No power part in the tree means Play still works — nothing is powered, live signals stay idle. Bench does not invent a supply, and it does not block Play with an empty-state lecture. Same chrome for a lonely leaf: time can advance; there’s just little or nothing to solve.

**Live signals** on the card follow the **playhead** while you scrub (revisit if that gets heavy).

**Params** edit inline on the card. If an edit would stop a run, Bench **asks first**.

Parking a tab (switching away) **drops the live run** (file + view/selection stay; mid-sim does not resume cold). Mid-run or mid-capture, switching or other stop-inducing actions **block with confirm** (Stay / Stop and continue). Plain edits **autosave**; closing a tab doesn’t nag unless a run or capture is in flight. **Undo / redo** are **per open file/tab**.

---

## Capture & levels

**Capture** freezes the **selected part’s** behaviour at its ports — a behaviour **level** on **that part’s definition**, not a new kind of document and not something owned by the fixture parent.

- You usually Capture from a fixture (a parent that may include supplies). The supply stays in the fixture; it is **not** baked into the capture. Later parents bring their own power. Outside the capture regime, you get **envelope** warnings.
- You do **not** have to Open the child first — Capture works from the current playable document on the **selection**.
- Captures **stack as history** on that part. Pick among levels on the card (**Live** when available, plus captures; unavailable options grayed). **Delete** old history entries from the card.
- Progress on the **under-stage bar** (Abort). Success: **toast + card**. Failure: **error toast + block on the card**.
- After edits to the part / subtree, expect a **stale** warning (broad dirtying to start). You can usually still run; only **critical** problems (missing pieces, broken/incompatible ports, etc.) hard-block.
- Capture is **recipe-guided** when a recipe exists for that part type (still being refined). Visual “capture the mesh” is not a main verb — renderer LOD handles heavy viz.

Behaviour **level** is the fidelity control on the card. Body-level fidelity can wait; visual detail is mostly viewer LOD.

---

## Warnings

Problems show **three ways**: a small icon on the tree row (hover for a short why), a callout in 3D, and full text on the card.

---

## Hotkeys (v1)

| Key | Action |
|-----|--------|
| Space | Play / pause |
| Delete / Backspace | Delete selection (e.g. wire) |
| Esc | Cancel (e.g. in-progress wire) |
| W | Wire tool |
| ⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z | Undo / redo |

---

## Bringing assets in

On the card, **contextual import** per category — not one mega Import menu. Bench keeps one preferred form per category (pretty visuals, body shape, robot description, board image). Other formats convert or copy into that; originals that don’t match aren’t kept as a second source of truth.

---

## Mental model (short)

| You want… | You do… |
|-----------|---------|
| Test a servo with power | Parent part = servo + PSU (+ wires); Play |
| Reuse cheap behaviour | Select the servo → Capture → pick that level later |
| Edit the servo’s insides | Open part (new tab) |
| Call it “left servo” in this robot only | Rename the **tree instance** |
| Rename the library servo file | Card → **Rename part file** |
| Rename a bubbled port | Not in v1 — names are pin-derived |

---

## Still soft

- Exact Capture recipes per part type  
- Exact port-name collision heuristic when many free nets bubble up  
- Whether multiplayer cursors ever matter here  
