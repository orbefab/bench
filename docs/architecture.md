# Architecture

One Node process owns the STEP loader, the harness agents, and the
sqlite store under `~/.sfab-bench/`. The folder a request is about is
`?project=` ([ADR 0006](decisions/0006-folder-is-a-tab.md)). The Mac
browser tab and Quest Browser are both HTTPS clients of that process.
Product calls and ranked next: [`product.md`](product.md). What the
product does, screen by screen: [`manual.md`](manual.md).

## Model

- **Server** is global. It does not live inside a CAD repo.
- **Project** = a directory on the Mac (git or not). Recorded as
  `{ path, lastFile, openedAt }`.
- **Document** = a STEP or GLB inside that directory. Recursive walk,
  skipping `node_modules`, `.git`, and cache dirs.
- **Agent cwd** = the project directory. Skills and kernels belong to
  the folder, not to this app. Harness adapters keep `.harness-bootstrap`
  and session dirs under `~/.sfab-bench/harness/`, not in that folder.
- **Library** is shared: file recents, folder recents, thread list,
  messages at rest. The folder a tab is in is the tab's
  ([ADR 0006](decisions/0006-folder-is-a-tab.md),
  [ADR 0003](decisions/0003-library-not-viewport.md)).
- **Viewport is per browser:** loaded file, selection, camera, XR, which
  chat is open, live stream. `show_artifact` moves only the asking client
  and appends recents.

Chat turns are **prompt**, **fill**, or **idle** ([ADR 0007](decisions/0007-harness-chat-fill.md)).
A fill is a client tool result (`get_viewer`, `askUserQuestions`) into a
live unfinished harness session. `show_artifact` runs on the server in the
prompt stream and does not fill.

Auth: loopback is trusted. Anything else on `/api` needs a paired device
token. Accounts and a public tunnel are later `principal.kind`s, not a
rewrite.

## Tree

`apps/server` is the process. `apps/web` is the Vite + R3F client.
`packages/contract` is the shared TypeScript for library snapshot, harness, and
viewer snapshot types.

Presence (the tessellated `assembly.json` + `.tess` package, the tree,
selection, measure, Quest world) is the product's identity relative to
a code workbench. Authoring is whatever produced the STEP.

## Loader

STEP → view package is a **loader**, not a project adapter. It is
OpenCascade compiled to WASM: `apps/server/src/occt/` reads the STEP into
an XCAF document, walks the assembly for names, placements and colours,
tessellates each distinct solid once, and writes `assembly.json` +
`components/<hash>.tess` into `~/.sfab-bench/cache/`. No Python, no
subprocess ([ADR 0002](decisions/0002-step-loader-occt.md),
[ADR 0004](decisions/0004-occt-via-opencascade-js.md)).

It runs on a **worker thread**, not the API's. Reading and meshing are
long synchronous runs inside wasm — 25 seconds for a 26 MB assembly — and
on the server's own thread that is 25 seconds in which nothing else is
answered, including a paired headset's websocket. `occt/build.ts` owns the
worker and serialises jobs onto it; `occt/worker.ts` is the thread.

Two things follow from the thread rather than being arranged separately.
A file that sends the mesher into a pathological loop is killed on a
timeout instead of wedging the process for good. And the wasm heap, which
only ever grows, goes back to the OS when the thread ends — so recycling
above a watermark is just "start a new worker".

Components are keyed by **mesh content hash**, so the same solid placed
forty times is downloaded and uploaded once. Occurrences carry world
transforms; the tree carries the structure.

`source.json` records the source file's stamp and the package format
version. Occurrence ids and face ordinals are refs that leave the server,
so a cache from an older format is rebuilt rather than served with refs
that no longer mean what they did.

## World runtime (ADR 0009)

[ADR 0009](decisions/0009-world-simulation.md) adds a server-side runtime,
one per open document. The document is a root part; a `.world.json` is a
World v2 import (one root part, the environment, and the run settings,
[formats](formats.md) §4). A file with `"version": 1` does not load.
The runtime steps MuJoCo and an avr8js
board and streams one shared run — play state, sim time, poses, signals —
to every client of that document. Camera, selection, lens, and timeline
scrub stay per client. That amends the per-browser viewport rule above
for worlds only. A STEP or GLB viewport stays per browser, as the Model
section says. Bench still does not author the CAD or compile the firmware.
rp2040js, `micro-emulator`, 3MF/GLB meshes, `package://`, RL export, and
a lone STEP or URDF opening as a world are later. Sensors and ground
contact are demo 2, later.

The document is a root part ([ADR 0011](decisions/0011-one-document-kind.md)):
`parts/<publisher>/<name>@<version>.json`, with a `play` block for gravity,
seed, and time step. A `.world.json` still opens as an import. Edit
operations and fixed ports are A3b and A3c in [`product.md`](product.md).
A tool (Select, Move, Rotate) is a mode of the stage that commits ordinary
edit operations, so undo, the agent, and scripts see what a drag did.

## Simulation principles (ADR 0010)

The simulation is **specialized engines on one clock**, not one solver:
MuJoCo for bodies and contact, our MNA engine for circuits, avr8js for
firmware, and part models where a domain does not need its own engine.

- **One orchestrator owns time.** A master step of 1 ms, or 1 ms / k when
  the run names one; engines exchange port quantities at seams. Tight loops (servo current against rail voltage)
  stay inside one engine; nothing is flattened into one global matrix.
- **One rail path.** A power island is one circuit. N = 1 is the
  single-board rail: the same element ids and node names. Pin edges
  inside a master step are split on every N. An algebraic rail takes one
  substep; inductance or capacitance takes ten.
- **Ports are runtime law.** Typed ports with quantities; nets are built
  from port declarations. Prefer effort/flow pairs so domains can meet.
- **Energy residuals at seams** are the honesty signal when coupling is
  imperfect. They are reported, not hidden (G2). The run report's `seams`
  field is joules at each circuit/body cut: energy sent, energy received,
  the loss the model declares, and the residual. The residual is the
  coupling lag of one body step, not a conservation check of the run. A
  seam is flagged when it grows.
- **Levels and snapshots are the fidelity dial.** The same exposed ports,
  run live or from a snapshot. The snapshot container is universal (ports,
  a typed form, an envelope, error, provenance); forms stay typed, never
  one table for every domain.
- **A snapshot never carries its fixture's supply.** Parents bring their
  own power (G1).
- **Inner edits dirty upward.** A stale capture warns rather than lies.
- No magnetics or FEM on the realtime path.

## Layers (ADR 0012)

[ADR 0012](decisions/0012-layers-and-plugin-seams.md) splits the code so
each layer imports only from the layers below it. A lint rule enforces it.

| Layer | Package | Contents |
| --- | --- | --- |
| L0 | `packages/contract` | Types, formats, protocol messages |
| L1 | `packages/parts` | Document model and typed edit operations with undo; loader, resolver, levels, nets, lint, lock; a `Store` interface instead of `node:fs` |
| L2 | `packages/engine-*` | One engine each behind an `Engine` interface; no IO |
| L3 | `packages/sim` | Plan, form adapters, orchestrator, recorder, capture runner |
| L4 | hosts | Node worker host, `bench` CLI, later a browser-worker host |
| L5 | `apps/server` | Projects and files, live socket, agent tools |
| L6 | `apps/web` | Editor shell and tool framework; speaks the protocol only |

Tools, the agent, and scripts all change a document through L1's edit
operations, so one undo history covers them. An edit is applied in
`packages/parts` (`EditSession`): in memory, checked by loading the new
text through an overlay store, then the part and the lock are written
together. A nested edit re-pins that part's row in every project root
that uses it, in the same step. Rename part file is one edit operation
that writes every affected project file as one atomic step. The server keeps one undo history per
open part and restarts the run from that write. A browser tab is one project
folder (`?project=`, [ADR 0006](decisions/0006-folder-is-a-tab.md)); part tabs
are the open part files inside it, and only the focused part tab is in
`?world=`. One client keeps one live run socket, on the focused part tab.
A parked part tab holds no socket; the server's idle timer stops that
document's worker. The web editor reads
`WorldView.tree` for the part tree, the card, and warning markers. L1 bubbles a composite's
free nets into ports. L3, at plan time, recomputes a running capture's
`from.hash` with the capture runner's own signature and marks it stale
(or unchecked, with why) without changing its frames.

**Plugin seams** are compile-time registries of in-repo packages:

1. **Forms**: param schema, lint rules, run adapter, capture recipe, card renderer.
2. **Tools**: a mode, a hotkey, a 3D interaction that emits edit operations.
3. **Importers**: one per asset category, converting to its canonical form.
4. **Engines**: behind the L2 interface.

Third-party plugins loaded at run time wait for the part registry and
signing.

L1 is `packages/parts`, including level edits. The circuit engine (L2)
is `packages/engine-circuit`, the MCU engine is `packages/engine-mcu`,
and the body engine is `packages/engine-body`. Each implements the
`Engine` face in the contract (init, advance to a master time, read
and write port quantities). The Node `Store` is
`apps/server/src/world/node-store.ts`.

L3 is `packages/sim`. It holds the plan, wiring, circuit stamps, the
form registry, the `Sim` orchestrator, the recorder, and the capture
runner. The plan reads a run root from the open part — play, the stage,
ground, and targets. A `.world.json` reaches it only as an import. It
does not read files or the clock. The host passes a `Store`, absolute
paths, package versions, and `now`. `apps/server/src/world/`
binds it to the Node host (`plan.ts`, `plan-host.ts` and `circuit-stamp.ts`
pass the file store and the catalog) and holds the test references (Uno,
Nano). Other code imports `@sfab-bench/sim` directly. The worker
(`apps/server/src/world/worker.ts`) is the Node host: thread messages,
the play timer, and file reads around `Sim`. `host.ts` and `live.ts`
stay in the server and talk to that worker. `sfab-bench run` builds
`Sim` in process and prints each board's serial lines.
