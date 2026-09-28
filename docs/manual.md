# Bench — user manual (target)

**Audience:** someone using Bench, and implementers checking *what* the product does.
**Status:** accepted 2026-09-27. This is the target product; it reads as if the app already exists. What runs today, and the order the rest gets built in, is [`product.md`](product.md) › Ranked next (A1–A6). How to install and open a folder today is [`user/`](user/).
**Pair with:** [`architecture.md`](architecture.md) (engines, layers, plugin seams), [ADR 0011](decisions/0011-one-document-kind.md) (one document kind), [ADR 0012](decisions/0012-layers-and-plugin-seams.md) (layers and plugin seams). The decisions behind this page are [`notes/2026-09-27-bench-alignment.md`](notes/2026-09-27-bench-alignment.md).

This page does not describe file schemas, solvers, or code layout.

---

## What Bench is

Bench is a **3D world builder for parts**. Everything you open, nest, wire, play, and capture is a **part**. There is no separate "world" or "group" kind of thing: a fixture, a robot, and a lone servo are the same kind of document at different depths.

You compose parts inside parts, connect their **ports**, **Play** to see behaviour, and **Capture** a part's behaviour when you want a cheaper stand-in later. Same chrome everywhere, including Quest (tighter, not different).

You drive it two ways, and they are **peers**: the editor's tools, and chat with an agent. A tool, the agent, and a script all make the same kind of edit to the same open part, and every edit lands in that tab's one undo history. Whatever you can do with a tool, you can ask the agent to do, and the other way round.

---

## The screen

- **Left — tree:** quiet list of what's in the open part (subparts and wires). Rows are mostly bare (name + indent), with a small warning icon when something is wrong. **One selection at a time** (v1). **No outliner search** in v1.
- **Center — stage:** the 3D view. Empty ports show as markers. A lonely part sits on a **visual grid only**: nothing invisible is holding it up or powering it.
- **Right — card:** the selected thing: ports, live signals (they follow the playhead while scrubbing), params, one **level picker per axis** the part has, warnings, Capture, Open part, Rename part file, level history. With nothing selected, the card is the open part's own card, and it shows its **play settings** (gravity, seed, time step).
- **Right — chat:** a collapsible panel beside the card. The agent sees the open part and the selection and edits through the same edits as the tools.
- **Top — tabs + thin breadcrumb:** each open part file is a tab (CAD-style). Opening a child part opens or focuses its tab; the previous tab **parks**.
- **Under stage — timeline:** play, pause, scrub. **Always** there. Capture progress also uses this bar while a capture runs.

Quest uses this same full chrome, just tighter. No special agent play/pause controls and no stored "agent ran this" badge in the UI: conversation history is enough.

---

## Files

You work in **one kind of file**: a part. **New** always asks for a **name and location**; the usual default folder suggestion is under `parts/`.

There is no hidden environment. If the part needs 5 V, you **Add a power part** (or build a parent that contains this part plus that supply). If it should stand on something, you Add a **ground part**. Starter kits that drop a ready bench come **later**; v1 is library **Add** only.

Gravity, the random seed, and the time step belong to the part you press Play on. They are that part's **play settings**, shown on its card when it is the open, top-level part, and ignored when the same part sits inside another one. Two gravities cannot happen: only the part you play decides.

Which level each child runs at is a choice on that child, saved in the open part. The open part can also hold defaults ("every servo at level 1").

A world file from before this change (`.world.json`) converts once into a part: its ground becomes a ground part, its gravity and seed become play settings, and its level rules become level choices and defaults.

Authoring stays **outside** Bench for now. Meshes, STEP, URDF, and firmware come from a CAD tool, a toolchain, a person, or the agent running a tool in the folder. Bench watches those files and reloads when they change. Part CAD and a microcontroller IDE inside Bench are later.

---

## Naming (instance vs file vs ports)

Bench keeps these naming ideas separate on purpose.

### 1. Instance name (what you see in the tree)

- **Where:** the tree row (inline rename on the selected row).
- **What it renames:** only **this placement** inside the parent: the label in *this* assembly ("left-wheel-servo"), not the library part on disk.
- **When:** anytime you're organizing the tree. Other instances of the same part file keep their own names.
- **What it does *not* do:** it does not rename the part file, does not rename ports, and does not rename Capture history levels.

### 2. Part file name (the library / disk asset)

- **Where:** a deliberate action on the **card** (or ⋯): **Rename part file**. Never the same gesture as tree rename.
- **What it renames:** the underlying part document (how it appears as an asset you Add later).
- **When:** only when you mean to change the shared definition's identity on disk, not when you're just clarifying a role in one parent.
- **Why split:** so a quick double-click in the tree can't accidentally rename the library servo everyone else instances.

### 3. Ports

- Ports are **always listed** on the card and shown as markers in 3D when empty or free.
- On composites, free child connections **bubble up** as this part's ports automatically: **one outer port per free net** (not every child pin on that net). Names come from **pin-derived naming plus a collision heuristic**.
- A port stays automatic only until something depends on it: a wire in a parent, or a capture of this part. From then on it is **fixed**. It keeps its name while you rewire the inside.
- An edit that would remove or rename a fixed port **asks first**. The prompt lists what depends on it and offers **Stay** (undo the edit) or **Break N** (make the edit and break those N wires or captures, each with a warning).
- In v1 there is **no port rename** UI. Star / pin-to-publish controls are deferred.

### 4. Capture level names

- Captures appear as **levels** on the part (history you can pick and delete).
- A new level gets a simple auto-name; you can rename it on the card. That is separate from instance rename and file rename.

| Gesture | Renames | Does not rename |
|---------|---------|-----------------|
| Tree row | This instance's label in the parent | Part file, ports, other instances |
| Card → Rename part file | The part document on disk | Tree instance labels elsewhere (until refreshed from file) |
| (v1) nothing | Ports | — use bubbled / pin-derived names |
| Card level | A Capture history entry's label | Instance or file |

---

## Build

1. **New** a part (or open one): name + location dialog as above.
2. **Add** subparts from **one library picker** (leaves and composites). Soft filters later. They appear at a **default pose, selected**.
3. Use the **tools** below to place, mount, and wire them.
4. Bubbled outer ports appear as you leave free nets (see Naming).

**Duplicate** is a shortcut. There is **no** separate palette in v1, and **no** "New file with this selection" shortcut: New + Add is enough.

### Tools

Each tool is a mode on the stage. A tool makes ordinary edits, so undo, the agent, and scripts all see the same thing.

| Tool | What it does |
|------|--------------|
| **Move / rotate** | Drag to move, rotate on handles, **snap** to faces, edges, and ports. Also the default: dragging a selected part moves it. |
| **Mount** | Attach a part to a body (a servo onto a bracket, a sensor onto a link), so it moves with it. |
| **Wire** (**W**) | Click **port → port in 3D** (card wiring is backup). **Esc** or **click empty** cancels. Wires are parts too: they show as **instance rows** in the tree, endpoints on the card or on hover; **select → Delete/Backspace** removes one. Wires are **not** added from the library picker. |
| **Probe** | Pick a port while playing and watch its quantities (volts, amps, torque, angle) as a trace on the timeline. |
| **Fixture** | Build a test bench around the selected part: a supply, a load, a scripted input. This is where you Capture from (see below). |

Later tools: joints between bodies, measure (distance, angle, clearance), targets and scripted paths, sensor frames, clips from the timeline.

---

## Play

Press **Play** (Space) anytime. The timeline runs.

What you get is whatever you composed. No power part in the tree means Play still works: nothing is powered, live signals stay idle. Bench does not invent a supply, and it does not block Play with an empty-state lecture. Same chrome for a lonely leaf: time can advance; there's just little or nothing to solve.

**Only one thing stops Play:** the open part's file cannot be read at all. Everything else **degrades per part** and says so:

- a part whose chosen level cannot run falls back to the nearest level that can, or sits idle;
- a part with no power, or a layout that level does not support, sits idle;
- a missing file or bad params shows a **placeholder** in its place, which sits idle.

Each of these is a warning (see Warnings), never a blocked Play.

**Live signals** on the card follow the **playhead** while you scrub.

**Params** edit inline on the card. If an edit would stop a run, Bench **asks first**.

Parking a tab (switching away) **drops the live run** (file and view/selection stay; mid-sim does not resume cold). The last recording is kept, so the timeline can still scrub it. Mid-run or mid-capture, switching or other stop-inducing actions **block with confirm** (Stay / Stop and continue). Plain edits **autosave**; closing a tab doesn't nag unless a run or capture is in flight. **Undo / redo** are **per open file/tab**, and they cover edits made by tools and by chat alike.

---

## Capture & levels

**Capture** freezes the **selected part's** behaviour at its ports into a **level** on **that part**, not into a new kind of document and not into the fixture parent.

- You usually Capture from a fixture (a parent that may include supplies). The supply stays in the fixture; it is **not** baked into the capture. Later parents bring their own power. Outside the capture regime, you get **envelope** warnings.
- You do **not** have to Open the child first: Capture works from the current playable document on the **selection**.
- Captures **stack as history** on that part. Pick among levels on the card (**Live** when available, plus captures; unavailable options grayed). **Delete** old history entries from the card.
- Progress on the **under-stage bar** (Abort). Success: **toast + card**. Failure: **error toast + block on the card**.
- After edits inside a part, every capture above that edit is marked **stale**, and the card says so. You can still run it.
- Capture is **recipe-guided** when a recipe exists for that part type (still being refined). Visual "capture the mesh" is not a main verb: renderer LOD handles heavy visuals.

**Where a capture lives.** On screen it is a level on the part. On disk it is its own snapshot file beside the part, and the part's level list points at it. So a capture never rewrites the part, and a table of numbers does not bloat it.

**Capturing a library part** (one you Added from a library, not one you made) never touches the library file. Bench writes a **level overlay** into your project (`overlays/<publisher>/<name>@<version>.levels.json`). Every instance of that part in the project gets the new level; other projects don't.

**Levels are per axis.** A part can have up to three: **behaviour** (how it acts at its ports), **body** (how it moves: masses, joints, gears), and **visual** (how detailed it looks). The card shows **one picker for each axis the part has** and hides the axes it lacks; levels that cannot run here are grayed out.

---

## Warnings

Problems show **three ways**: a small icon on the tree row (hover for a short why), a callout in 3D, and full text on the card. A fallback level, an idle part, a placeholder, an envelope excursion, a stale capture, and a broken port each show there.

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

On the card, **contextual import** per category, not one mega Import menu. Bench keeps one preferred form per category (pretty visuals, body shape, robot description, board image). Other formats convert or copy into that; originals that don't match aren't kept as a second source of truth.

---

## Mental model (short)

| You want… | You do… |
|-----------|---------|
| Test a servo with power | Parent part = servo + supply (+ wires); Play |
| Reuse cheap behaviour | Select the servo → Capture → pick that level later |
| Edit the servo's insides | Open part (new tab) |
| Call it "left servo" in this robot only | Rename the **tree instance** |
| Rename the library servo file | Card → **Rename part file** |
| Rename a bubbled port | Not in v1: names are pin-derived, and fixed once used |
| Change gravity | Open part's card → play settings |
| Have the agent do any of the above | Ask in chat; undo works the same |

---

## Still soft

- Exact Capture recipes per part type
- Exact port-name collision heuristic when many free nets bubble up
- Whether multiplayer cursors ever matter here
