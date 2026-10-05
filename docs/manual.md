# Bench — user manual (target)

**Audience:** someone using Bench, and implementers checking *what* the product does.
**Status:** accepted 2026-09-27; amended 2026-10-04 (looking at one part, the bench, capture runs, accuracy). This is the target product; it reads as if the app already exists. What runs today, and the order the rest gets built in, is [`product.md`](product.md) › Ranked next (A1–A6). How to install and open a folder today is [`user/`](user/).
**Pair with:** [`architecture.md`](architecture.md) (engines, layers, plugin seams), [ADR 0011](decisions/0011-one-document-kind.md) (one document kind), [ADR 0012](decisions/0012-layers-and-plugin-seams.md) (layers and plugin seams). The decisions behind this page are [`notes/2026-09-27-bench-alignment.md`](notes/2026-09-27-bench-alignment.md).

This page does not describe file schemas, solvers, or code layout.

---

## What Bench is

Bench is a **3D world builder for parts**. Everything you open, nest, wire, play, and capture is a **part**. There is no separate "world" or "group" kind of thing: a bench, a robot, and a lone servo are the same kind of document at different depths.

You compose parts inside parts, connect their **ports**, **Play** to see behaviour, and **Capture** a part's behaviour when you want a cheaper stand-in later. Same chrome everywhere, including Quest (tighter, not different).

You drive it two ways, and they are **peers**: the editor's tools, and chat with an agent. A tool, the agent, and a script all make the same kind of edit to the same open part, and every edit lands in that tab's one undo history. Whatever you can do with a tool, you can ask the agent to do, and the other way round.

---

## The screen

- **Left — tree:** quiet list of what's in the open part (subparts and wires). It holds the whole hierarchy: a row with parts inside it expands in place, down to leaf parts, like a CAD assembly tree. Rows are mostly bare (name + indent), with an **eye** and a small warning icon when something is wrong. **One selection at a time** (v1). **No outliner search** in v1.
- **Center — stage:** the 3D view. Empty ports show as markers. A lonely part sits on a **visual grid only**: nothing invisible is holding it up or powering it.
- **Right — card:** the selected thing: ports, live signals (they follow the playhead while scrubbing), params, one **level picker per axis** the part has, warnings, Capture, Open part, Rename part file, level history. With nothing selected, the card is the open part's own card, and it shows its **play settings** (gravity, seed, time step).
- **Right — chat:** a collapsible panel beside the card. The agent sees the open part and the selection and edits through the same edits as the tools.
- **Top — tabs + thin breadcrumb:** each open part file is a tab (CAD-style). Opening a child part opens or focuses its tab; the previous tab **parks**.
- **Under stage — timeline:** play, pause, scrub. **Always** there. Capture progress also uses this bar while a capture runs.

Quest uses this same full chrome, just tighter: the tree, card and timeline are panels in the room, and you point and click with the controller. Hide, Isolate and show inner parts work there exactly as on the Mac; there are no Quest-only gestures. No special agent play/pause controls and no stored "agent ran this" badge in the UI: conversation history is enough.

---

## Looking at one part

Zoom is the camera, as in any 3D viewer. It never changes what is simulated. To look at one part among many (one servo of six in a robot), you have two ways, and both keep the simulation as it is:

- **Isolate** (row ⋯): stay in the open part and hide everything else. The part keeps running in context: the robot's supply, firmware and load still drive it. **Show all** or **Esc** leaves; while a tool is in progress (a wire), Esc cancels the tool first.
- **Open part** (row ⋯, or the card): open that part's own file in a new tab, alone. Nothing powers or drives it there unless you add it (see Capture & levels).

**Hide and show.** The eye on a row hides or shows that instance in 3D. A hidden part keeps simulating; hiding is only what you see.

**Show inner parts.** The eye on the rows inside a part made of parts shows those parts in place (a servo's motor, gears, pot and control board). This is a view choice, separate from the **level** the part runs at: a servo can show its inner parts while it runs as a snapshot, and the other way round.

Hide, Isolate and show inner parts are your view, like the camera and the selection: they are kept per screen, not saved in the part, so the Quest can isolate one servo while the Mac shows the whole robot.

---

## Files

You work in **one kind of file**: a part. **New** always asks for a **name and location**; the usual default folder suggestion is under `parts/`.

There is no hidden environment. If the part needs 5 V, you **Add a power part** (or build a parent that contains this part plus that supply). If it should stand on something, you Add a **ground part**. Starter kits that drop a ready bench come **later**; v1 is library **Add** only.

Gravity, the random seed, and the time step belong to the part you press Play on. They are that part's **play settings**, shown on its card when it is the open, top-level part, and ignored when the same part sits inside another one. Two gravities cannot happen: only the part you play decides.

Which level each child runs at is a choice on that child, saved in the open part. The open part can also hold defaults ("every servo at level 1").

A world file from before this change (`.world.json`) converts once into a part: its ground becomes a ground part, its gravity and seed become play settings, and its level rules become level choices and defaults.

Authoring stays **outside** Bench for now. Meshes, STEP, URDF, and firmware come from a CAD tool, a toolchain, a person, or the agent running a tool in the folder. Bench watches those files and reloads when they change. Part CAD and a microcontroller IDE inside Bench are later.

The library includes the Arduino Nano, the Arduino Uno, and the SparkFun Pro Micro (5 V, 16 MHz, ATmega32U4). On the Pro Micro, timer 4 PWM and the USB serial port are not simulated. The board card names each of those once when the board runs. Prints from that board come from `Serial1`, the hardware UART.

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
- On composites, free child connections **bubble up** as this part's ports automatically: **one outer port per free net** (not every child pin on that net). The name is the smallest pin name on that net. Nets are named in lexicographic order; a collision becomes `<instance>_<pin>`, then `_2`, `_3`. A dot in a name becomes an underscore.
- A port stays automatic only until something depends on it: a wire in a parent, or a capture of this part. From then on it is **fixed**. It keeps its name while you rewire the inside.
- An edit that would remove or rename a fixed port **asks first**. The prompt lists what depends on it and offers **Stay** (undo the edit) or **Break N** (make the edit and break those N wires or captures, each with a warning).
- In v1 there is **no port rename** UI. Star / pin-to-publish controls are deferred.

### 4. Capture level names

- Captures appear as **levels** on the part (history you can pick and delete).
- A new level is auto-named `capture-<n>`, and its snapshot file `<name>-<axis>-<n>`. The number counts up per part and axis, and a deleted capture's number is not reused.
- **Renaming a level is deferred.** For now a level keeps its auto-name; delete it and capture again if you need a fresh one. Level rename, when it lands, stays separate from instance rename and file rename.

| Gesture | Renames | Does not rename |
|---------|---------|-----------------|
| Tree row | This instance's label in the parent | Part file, ports, other instances |
| Card → Rename part file | The part document on disk | Tree instance labels elsewhere (until refreshed from file) |
| (v1) nothing | Ports | — use bubbled / pin-derived names |
| (later) Card level | A Capture history entry's label | Instance or file |

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
| **Probe** | Pick a port while playing and watch its quantities (volts, amps, torque, angle) as a trace on the timeline. A board pin with a circuit on its net shows its solved node: each frame's mean, with a faint band from its lowest to its highest step (a PWM pin's square wave, an RC node's ripple). A pin with no circuit shows its logic level times the board node. |

A **bench** is not a tool: it is a part you make with New and Add (the part under test, a supply, a signal source, a load, wired). This is where you usually Capture from (see Capture & levels).

Later tools: joints between bodies, measure (distance, angle, clearance), targets and scripted paths, sensor frames, clips from the timeline.

---

## Play

Press **Play** (Space) anytime. The timeline runs.

What you get is whatever you composed. No power part in the tree means Play still works: nothing is powered, live signals stay idle. Bench does not invent a supply, and it does not block Play with an empty-state lecture. Same chrome for a lonely leaf: time can advance; there's just little or nothing to solve.

**Only one thing stops Play:** the open world or part file cannot be read as a document. It is missing, it is not JSON, it is not a document, or it is a version-1 world. Everything else **degrades per part** and says so:

- a part whose chosen level cannot run falls back to the nearest level that can, or sits idle;
- a part with no power, or a layout that level does not support, sits idle;
- a missing file or bad params shows a **placeholder** in its place, which sits idle.

Each of these is a warning (see Warnings), never a blocked Play.

**Live signals** on the card follow the **playhead** while you scrub.

**Params** edit inline on the card. If an edit would stop a run, Bench **asks first**.

Parking a tab (switching away) **drops the live run** (file and view/selection stay; mid-sim does not resume cold). The last recording is kept, so the timeline can still scrub it. Mid-run or mid-capture, switching or other stop-inducing actions **block with confirm** (Stay / Stop and continue). Plain edits **autosave**; closing a tab doesn't nag unless a run or capture is in flight. **Undo / redo** are **per open file/tab**, and they cover edits made by tools and by chat alike.

---

## Capture & levels

**Capture** freezes the **selected part's** behaviour at its ports into a **level** on **that part**, not into a new kind of document and not into the bench.

- **The bench is the parent.** Capture runs on the selected part inside whatever part holds it, powers it and drives it: a robot, or a **bench** you made for capturing. A bench is an ordinary part: the part under test, plus instruments you Add, place and wire like anything else. The supply, signal source and load stay in the bench; they are **not** baked into the capture. Later parents bring their own power. Outside the range the bench drove it through, you get **envelope** warnings.
- **Instruments.** A **signal source** and a **load** (a dynamometer for a shaft) play a **program**: a short list of segments (hold, step, ramp, chirp, PRBS), each with a time and a level, edited on the instrument's card or by the agent. Something a real rig would swap between runs, such as a flywheel, is a bench param with several values; Capture runs the bench once per value. A bench can also hold a board with firmware, and a robot is a bench whose program is its firmware.
- **A capture is its own run.** Capture runs the open part from t = 0 in the background, for as long as its programs last, and records the selected part's ports at every step. The live run you are watching is not touched, and nothing of the capture run is shared or shown until it finishes: the document still has one live run. The same bench, programs and seed give the same capture, so when the part changes and its capture goes stale, Bench can run the capture again and show how far it moved. There is no capture from what you just played.
- **Nothing to capture.** A servo opened alone has no power. Capture still runs; when the part saw no power or no drive at its ports, the result says so, and suggests a new part around it: Add a power source, place it, wire it (or ask the agent to). Bench does not build the bench for you.
- **Where it came from.** Each captured level records the bench it was captured on, and covers what that bench drove it through: a capture on a robot covers only what that robot did. The level keeps its auto-name (see Naming); the bench is part of its source.
- **Ready-made benches.** A library part can come with benches made for capturing it. They are ordinary parts: Open one, or Add it, and change it like any other.
- You do **not** have to Open the child first: Capture works from the current playable document on the **selection**.
- Captures **stack as history** on that part. Pick among levels on the card (**Live** when available, plus captures; unavailable options grayed). **Delete** old history entries from the card.
- **The Capture button.** Each axis that can capture has its own **Capture** button, under that axis's picker. When it can't run, it is disabled and the card says why beside it, in the server's words: "<part> has no behaviour level that holds a snapshot", or "<part> has no behaviour level <n> to capture into". It is also disabled while another capture is running in this world ("a capture is running"). Pressing it captures the selected instance's part on that axis.
- **Progress** shows on the **under-stage bar**: what the capture is doing, `done / total`, a bar, and **Abort**. The play controls stay as they are, and the run is not touched. Abort writes nothing.
- **When it finishes.** A toast says **"Captured <name>: use it?"** with a **Use it** button, and stays for 12 seconds. The part **stays on its current level** until you press it. **Use it** switches the axis to the new level, as one undoable edit. The new level is in the picker either way. Failure: **error toast + block on the card** (until your next capture or selection change). An abort is quiet: no block.
- **Sources.** Each level in the picker says where it comes from: **part** (defined in the part file), **snapshot** (a captured snapshot), or **overlay** (added by this project's level overlay). A **stale** mark, with its reason on hover, shows on the level the run is using, and only there: the run checks only the snapshots it loaded, so a level you are not using is never marked. It says the part changed after the capture.
- **Delete** shows on captures only: an overlay level, or a level of a project part whose snapshot is in the project's `snapshots/`. It never shows on a level the part file defines. If a parent's level rule selects the capture, Delete **asks first**. The dialog names the capture and the rules that use it: **Stay** (nothing changes) or **Break N** (delete it and send those parts back to the level's **default**, not to the level they had before you used the capture).
- **Undo / redo** (⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z) cover capture, **Use it**, and Delete. Undoing a capture removes the level and its snapshot file.
- After edits inside a part, the capture the run is using is marked **stale**, and the card says so. You can still run it.
- What a capture runs is its bench; how it fits is the part's form. Visual "capture the mesh" is not a main verb: renderer LOD handles heavy visuals.

**Where a capture lives.** On screen it is a level on the part. On disk it is a snapshot file in the project's `snapshots/` folder, named `<name>-<axis>-<n>`, and the part's level list points at it by id. So a table of numbers does not bloat the part.

**Capturing a library part** (one you Added from a library, not one you made) never touches the library file. Bench writes a **level overlay** into your project (`overlays/<publisher>/<name>@<version>.levels.json`). Every instance of that part in the project gets the new level; other projects don't.

**Levels are per axis.** A part can have up to three: **behaviour** (how it acts at its ports), **body** (how it moves: masses, joints, gears), and **visual** (how detailed it looks). The card shows **one picker for each axis the part has** and hides the axes it lacks; levels that cannot run here are grayed out.

---

## Warnings

Problems show **three ways**: a small icon on the tree row (hover for a short why), a callout in 3D, and full text on the card. A fallback level, an idle part, a placeholder, an envelope excursion, a stale capture, a broken port, and a gap over its resolution (see Accuracy) each show there.

## Accuracy

A part running on a snapshot says how true it is. An assembly's check runs it twice on its own bench, once with its parts detailed and once with some of them on snapshots, and keeps both. When the run you are looking at is that run (this assembly, these parts replaced, these settings), each replaced part's card lists, for each port it is checked at, the **gap** between the two runs and the **resolution** it is judged against: the smallest difference that a part on that port can tell apart or hold to, as its datasheet states it. The open assembly's card sums it up, for example "1 within, 3 no resolution".

A resolution is judged only where it means something. A servo's dead band is judged on its own shaft angle while the shaft is settled: samples where it is still moving, or too close to the start or end of the run, are left out, and the card shows how many were kept and why the rest were not. The card names that rule `steady@1`, with its window. A chip's ADC step is judged at the instants it converts. The worst kept sample counts; the average (RMS) gap is shown beside it.

- **Within:** the gap is at most the resolution. It shows on the card only.
- **Over by x:** the gap is larger, by x. It shows amber on the card and as a warning, with the margin. It is a known limit of that snapshot, stated, not hidden.
- **No verdict:** no sample qualified, so there is nothing to judge, and the card says why.
- A quantity no resolution covers (the current a servo draws, for example) shows its gap with no verdict.

A verdict is marked **out of domain** when the check's own run took a snapshot outside its valid range, ran one stale, unchecked or degraded (the card says which), or when a snapshot this run loads is stale or unchecked. It still shows, with that beside it.

On any other run (other levels, a part edited since, a rebuilt firmware image, an edited robot, other play settings) the check does not apply. The assembly's card names it and says it is not this run's; no part shows a verdict, and none moves to the nearest part.

The **ghost** (a toggle on the card) runs the other level beside the live one, drawn translucent, so the gap is visible as motion.

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
| Reuse cheap behaviour | Put the servo on a bench (supply + signal source + load) → select it → Capture → pick that level later |
| Look at one servo inside a robot | Row ⋯ → Isolate (it keeps running in the robot) |
| See inside the servo | Show its inner rows (the eye); its level is unchanged |
| Edit the servo's insides | Open part (new tab) |
| Know how true a snapshot is | Its card: gap, resolution, within / over |
| Call it "left servo" in this robot only | Rename the **tree instance** |
| Rename the library servo file | Card → **Rename part file** |
| Rename a bubbled port | Not in v1: names are pin-derived, and fixed once used |
| Change gravity | Open part's card → play settings |
| Have the agent do any of the above | Ask in chat; undo works the same |

---

## Still soft

- Which ready-made benches each library part comes with
- Whether multiplayer cursors ever matter here
