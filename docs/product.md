# Product

Living plan for this repo. What the product does, screen by screen, is
[`manual.md`](manual.md). Architecture detail is
[`architecture.md`](architecture.md). Expensive calls are
[`decisions/`](decisions/). How to run it is [`user/`](user/).

The 2026-09-13 survey that produced the first direction is historical.
The world is [ADR 0009](decisions/0009-world-simulation.md); the part as
the only document is [ADR 0011](decisions/0011-one-document-kind.md), and
the layers are [ADR 0012](decisions/0012-layers-and-plugin-seams.md). The
2026-09-27 alignment with the manual is
[`notes/2026-09-27-bench-alignment.md`](notes/2026-09-27-bench-alignment.md).
**This file is the source of truth for what we are building next.**

## What this is

A robotics simulation platform: a 3D world builder for parts. Everything
you open, nest, wire, play, and capture is a part
([`manual.md`](manual.md)). You drive it with the editor's tools and with
chat, as peers: a tool, the agent, and a script make the same typed edits
to the same document, with one undo history per tab. Chat uses the AI
subscriptions already on the Mac (Codex, Claude Code, Cursor, Grok,
OpenCode). Cursor is listed but a Mac login is not visible to this app yet.
This app does not take API keys for chat. A world runs today from a root
part, `parts/<publisher>/<name>@<version>.json`. A `.world.json` still
opens as an import. The editor is A3b–A6 below.

The world is the view. CAD, firmware, electronics, and physics sit around
it. Reinforcement learning is later, and it runs outside this app. A STEP
still opens: tessellated package, tree, selection, measure, on the Mac and
on Quest.

Three jobs, kept separate:

| Job | Who |
| --- | --- |
| **Authoring** | Whatever produced the STEP, the URDF, and the firmware in the open folder (Jake cadgen, a CAD export, a toolchain, a human, or the agent running a tool there). Bench watches and reloads. For now this app does not author CAD and does not compile firmware; in-app part CAD and an MCU IDE are Later, after A6. |
| **World** | Building and running parts: the part document ([ADR 0011](decisions/0011-one-document-kind.md)), MuJoCo, a board, wires, the tools, and the viewer. The STEP viewer is how a part is inspected. This is the product. |
| **Agent host** | This Node process: open folder, harnesses, threads, and the tools that see and run the world. `get_viewer` / `show_artifact` stay. |

North star: global server → **open a folder** → **open a part** → build it
with tools or chat → **Play** → **Capture**.
A STEP still opens. Quest Browser joins over HTTPS. Recents and threads
are shared. A world's live run is shared per document; camera, selection,
lens, and scrub stay on the client
([ADR 0003](decisions/0003-library-not-viewport.md),
[ADR 0009](decisions/0009-world-simulation.md)).

The 2026-09-21 direction note (Bench is the browser) is superseded where
it ruled out a peripheral simulator. Part models are that layer. This app
still does not write a chip emulator, and it still does not learn which
tool wrote the file.

## Locked

Do not re-open these unless the human asks.

- **No adapters.** Project = a directory. A STEP or GLB in it is a document. A world is a root part, `parts/<publisher>/<name>@<version>.json`, the only document kind ([ADR 0011](decisions/0011-one-document-kind.md)). A `.world.json` is a legacy import. Agent cwd = that directory. Skills live in the project if the user put them there. This app does not learn which tool wrote the STEP, the URDF, or the firmware.
- **Tessellation is a loader**, not an adapter. OpenCascade WASM in the API process, and the only one, producing `assembly.json` + `.tess` + `#o…` ([ADR 0002](decisions/0002-step-loader-occt.md), [ADR 0004](decisions/0004-occt-via-opencascade-js.md)). The Python stopgap it replaced is gone.
- **One process, two HTTPS clients.** Mac tab (loopback trusted) and Quest Browser (paired). No Unity, no APK.
- **Share the library.** Recents, thread list, messages at rest, pairing. The folder a tab is in stays the tab's (`?project=`, [ADR 0006](decisions/0006-folder-is-a-tab.md)). For a STEP or GLB the viewport stays per client: loaded file, selection, camera, XR, which chat is open, live stream. `show_artifact` moves only the asking client ([ADR 0003](decisions/0003-library-not-viewport.md)). For a world, the run is shared per document — play state, sim time, poses, signals — and the last play or pause shows who sent it. Camera, selection, lens, and scrub stay per client ([ADR 0009](decisions/0009-world-simulation.md)).
- **This app runs the world.** Physics is MuJoCo. The board is avr8js. Wires are pin-to-pin, plus a power budget. SPICE/analog, heat, wire resistance, a breadboard view, and KiCad import are out of the format for now and can be added later without breaking it. Milestone 1 link meshes are STL or OBJ. Firmware is a `.hex` built outside; this app watches it and restarts the board; source is read-only. rp2040js, `micro-emulator`, 3MF/GLB, `package://`, and RL export are later ([ADR 0009](decisions/0009-world-simulation.md)).
- **Desktop composer stays TipTap** for `#` chips (parts, faces, `#o…`). Quest stays plain input + voice.
- **Electron is a shell, not a client.** It starts the same server and loads the same `https://127.0.0.1:7322` page, and adds exactly one thing a browser cannot do: a native folder dialog ([ADR 0005](decisions/0005-electron-shell.md)). The browser path stays first-class — Quest depends on it.
- **Ship is a `.app` from GitHub Releases plus `serve`.** No npm until the repo is public. No cask, no auto-update until a notarised `.app` is in a public release.
- **Auth now is pairing.** Accounts are a later `principal.kind`. Never hold provider credentials; show the login command in the UI.
- **Do not merge** [`sfab-oss/sfab-cad`](https://github.com/sfab-oss/sfab-cad) ([ADR 0001](decisions/0001-new-private-repo.md)).
- Sphere-robot is a **folder you open**, not the app.

## Ranked next

Each row is one PR-sized unit. Update status here when it ships.
Shipped rows stay. Next is the world.

| # | Status | Item |
| --- | --- | --- |
| 1 | **done** | Pairing: loopback trusted, LAN needs a device token |
| 2 | **done** | Standalone Node server; Vite proxies `/api` in dev |
| 3 | **done** | Project folder + STEP loader + recents |
| 4 | **done** | Library, not viewport ([ADR 0003](decisions/0003-library-not-viewport.md)) |
| 5 | **done** | This repo; sphere-robot `xr-viewer/` deleted |
| 6 | **done** | Desktop layout (files left, model tree on canvas, chat right, provider status). TipTap `#` mentions from parts / faces / `#o…`; chips flatten to those refs; click a ref in the transcript selects on this tab |
| 7 | **partial** | Local CLI (`pnpm cli serve` / `dev` / `open`) prints URL, QR, pairing code. **`npx sfab-bench`: not until the repo is public** |
| 8 | later | `--tunnel` (pairing already required for non-loopback). Do not start until someone needs Quest off this LAN |
| 9 | **done** | Marketing site (`apps/docs`) on [bench.sfab.ai](https://bench.sfab.ai). Linking the real `apps/web` client (and XR in that preview): later. |
| 10 | **done** | Electron shell: native folder dialog, server starts with the app, keep-alive ([ADR 0005](decisions/0005-electron-shell.md)). `pnpm desktop:package` writes the `.app` and a `ditto` zip; signs with `CSC_NAME` when present, otherwise ad-hoc. Notarisation: gated on an Apple identity on the packaging Mac. |
| 11 | later | Account `principal.kind`. Only when 8 is used by more than one person |
| 12 | **done** | OCCT WASM loader. STEP opens with no Python ([ADR 0004](decisions/0004-occt-via-opencascade-js.md)) |
| 13 | **done** | sessions-01 — project is a request parameter, per-workspace `409` ([ADR 0006](decisions/0006-folder-is-a-tab.md)). Server and contract; web unchanged. |
| 14 | **done** | sessions-02 — `?project=` as tab state, switcher sets the tab instead of `POST /api/project`, paired clients pick from recents, ⌘O targets the window's tab. Welcome is `/`; a folder with no `?file=` is an empty scene. |
| 15 | **done** | ship-01 — tag `v0.1.0`: `bin` field, Releases zip via `ditto`, signing auto-detect with today's ad-hoc fallback, `install.md` recipe "now". `v0.1.1` restores Codex/OpenCode in the packaged app. `v0.2.0` is the desktop UX + harness + sessions cut. `v0.2.1` is the zip after MIT / public-ready README and the loopback-dev IWER inject gate. `v0.2.2` is chat follow + stop looping a finished turn, Quest card still while streaming, first-time provider setup line, and first-run pointing at the starter. |
| 16 | later | ship-02 — `sfab-bench app [dir]`, binary inside the `.app`, "Open at login". Not until the `.app` sits in `/Applications` and launches from the Dock |
| 17 | later | IWER in the packaged `.app`: confirm the zip does not ship or inject IWER; a future marketing-demo force-install must not leak into Quest LAN or the `.app`. |
| 18 | **done** | First-run: README + Welcome + user doc point at [sfab-bench-starter](https://github.com/sfab-oss/sfab-bench-starter), which vendors Jake `$cad` and a project Bench skill. No in-app clone. |
| 19 | **next** | The world ([ADR 0009](decisions/0009-world-simulation.md)). Demo 1: an unmodified `Servo.h` sweep moves a one-joint arm in a `.world.json` on the Mac; the timeline scrubs; the agent can run it and read pulse widths; Quest watches that run and can play or pause. Demo 2 (sensor, ground contact, wheeled robot) is later, as are a lone STEP or URDF opening as a world, rp2040js, `micro-emulator`, 3MF/GLB meshes, `package://`, and RL export. |
| 20 | **next** | G1 — the Nano's class 1 keeps the supply outside: the `sfab/nano-power-input@1.0.0` branch snapshot plus the board load, behind whatever supply part is in the scene. The `feed` snapshot use is retired (with `sfab/nano-usb-5v`, its bounds gating, and its plan error). Proof: every other printed line unchanged; class-1 lines before and after (about 1–2 mV). |
| 21 | **next** | G1b — supplies are parts with levels: generic presets on `thevenin-limit@1` (USB 2.0 and USB 3 host ports, 1 A charger, 2 A bench supply) and a `battery@1` form (OCV vs state of charge, internal resistance, capacity). Proof: closed-form checks; no existing line moves. |
| 22 | planned | G1c — what is on the real board is in the board group: an `ldo-regulator@1` form; Nano VIN → AMS1117 and Uno VIN → NCP1117 plus its source-select comparator inside the power-input groups. Proof: USB-only lines unchanged; 9 V on VIN against the datasheets; a battery on VIN runs a Nano. |
| 23 | planned | A1 — `packages/parts` (loader, resolver, levels, nets, lint, lock, `Store`) and `packages/engine-circuit`; a lint rule against upward imports ([ADR 0012](decisions/0012-layers-and-plugin-seams.md)). Proof: no printed line changes. |
| 24 | planned | A2 — `packages/sim` (plan, form adapters as the form registry, orchestrator, recorder, capture runner); `worker.ts` a thin Node host; `bench run`; one rail path (a single board is the N = 1 case); only an unreadable document blocks Play. Proof: no line changes; `bench run` prints the gauge's serial lines with no server. |
| 25 | planned | G2 — energy residual per seam in the run report, flagged when it grows. Proof: new report lines only. |
| 26a | **done** | A3a — the part is the only document: the `play` block, ground and target parts, the converter, and one lock per root part ([ADR 0011](decisions/0011-one-document-kind.md)). Proof: converted examples replay their recordings identically. |
| 26b | **done** | A3b — typed edit operations with undo in `packages/parts`; agent tools on them. |
| 26c | planned | A3c — fixed ports (D4) and dirtying upward (G3). |
| 27 | planned | A4 — editor shell: tabs, tree, stage, card with one level picker per axis, timeline, chat panel, warnings three ways ([`manual.md`](manual.md)). Proof: browser QA. |
| 28 | planned | A5 — tool framework plus move/rotate/snap, mount, wire, probe. Proof: browser QA; edit-operation undo tests. |
| 29 | planned | A6 — Capture from the card: sidecar snapshots and project level overlays, the fixture tool, progress and abort. Proof: a UI capture matches the CLI capture. |

## Do not build

Sign-in, a relay, a component registry, a mobile app, a
background service (Login Items is not one), thread-scoped cwd or a
thread sidebar as primary navigation, a diff or terminal panel, a
second tessellator, Tailscale integration, Fusion / CAD-tool integration,
Windows anything, merging sfab-cad, merging the `mcu` branch.

This app does not compile firmware, ship an in-app code editor, or bundle
a toolchain, for now. Part CAD and an MCU IDE in the app are Later, after
A6 (2026-09-27 alignment, D1b). The editor and chat are peers on one
document.
ADR 0008 (second domain) lived only on `mcu`, and it is void
([ADR 0009](decisions/0009-world-simulation.md)).

Electron came off this list on 2026-09-14 by direct ask, as a shell only
([ADR 0005](decisions/0005-electron-shell.md)). A second UI inside it is
still not a thing we build.

`apps/docs` came off the “do not build a docs site” line on 2026-09-17 by
direct ask. It is a marketing worker (home page), not a second CAD UI
and not a second runbook. User steps stay in `docs/user/`. The hero
workbench is a desktop placeholder until we link `apps/web`.

## How to run

```bash
pnpm dev                      # server + Vite, use a browser
pnpm desktop                  # the same thing in an Electron window
pnpm cli open /abs/path --dev
```

Mac: `https://127.0.0.1:7322`. Quest: LAN host on port **7322**, pair
once. [`user/install.md`](user/install.md).
