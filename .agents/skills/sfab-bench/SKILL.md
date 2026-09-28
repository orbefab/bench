---
name: sfab-bench
description: >
  Start and use sfab-bench (Vite + React + R3F, Quest Browser). Use when
  reviewing a STEP, GLB, or world on the headset or LAN page, running a
  world and reading pulse widths, showing an artifact in the in-app
  assistant, or when the user says sfab-bench, WebXR, Quest, or world.
---

# sfab-bench

This is the app in this repo. Product home: https://bench.sfab.ai.
Living plan: `docs/product.md`. Human runbook: `docs/user/`.

## Start

```bash
pnpm dev          # browser
pnpm desktop      # the same app in an Electron window
```

`pnpm dev` starts the loopback API (`http://127.0.0.1:8787`) and Vite
HTTPS (`:7322`, proxies `/api`). Vite prints a LAN `https://<host>:7322/`
URL (self-signed). Quest needs that LAN host, not `127.0.0.1`. Confirm
with `curl -k https://127.0.0.1:7322/api/me` (loopback principal).
Production: `pnpm build && pnpm serve`.

Open a folder from the Mac tab (Welcome recents or **Open folder**),
`pnpm cli open /abs/path --dev`, or `SFAB_BENCH_PROJECT=/abs/path pnpm dev`.
The folder is the tab's (`?project=`). This repo has no STEP files; point
it at a CAD directory, or at
[sfab-bench-starter](https://github.com/sfab-oss/sfab-bench-starter).

`pnpm dev` / `pnpm serve` print the Mac URL, Quest pair URL, pairing code, and QR.

## Load an artifact

No `?file=` → empty scene (pick a recent STEP, or one from Files). Recents
on the server list files anyone opened in this folder (Quest can pick one;
it is not yanked onto Mac's view). `/` with no `?project=` is Welcome.

Query string, relative to **this tab's project folder**:

- Folder: `?project=/abs/path/to/folder`
- STEP: `?file=cad/STEP/envelopes/box_envelope.step` (tessellated on demand)
- GLB: `?file=part.glb` anywhere in the project

In the in-app assistant (cwd is the open project):

- `get_viewer` — `{ file, empty, selected, selectedName, tree, partCount }`. Paths are project-relative.
- `show_artifact` — pass a STEP or GLB in the project. Loads it on **this
  client only** and adds it to shared recents. Re-call after rebuilding
  the same STEP so this client reloads.

OpenCode already loads `AGENTS.md` and `.agents/skills` from the **open
folder**. The harness `instructions` are only the workbench identity
line — do not add a CAD system prompt here. The
[starter](https://github.com/sfab-oss/sfab-bench-starter) vendors Jake
`$cad` plus a project-facing copy of this skill. cadgen is `$cad`'s
pip runtime, not a second skill.

## Worlds

A world is a root part, `parts/<publisher>/<name>@<version>.json`, in the
open folder. A `.world.json` still opens as an import. Bench runs one
shared sim for that file. How to write one, build firmware outside Bench,
and read the run: [world.md](world.md).

GitHub Releases of the `.app` zip: [`.agents/skills/release/`](../release/).

## Do not

- Edit Jake `$cad` / `$cad-viewer` / `$step-parts` from this repo.
- Default-open this repo as the CAD project.
- Add accounts, a tunnel, or a second tessellator without an ADR.
- Give the Electron shell (`pnpm desktop`) any UI of its own — it wraps the
  same page ([ADR 0005](../../../docs/decisions/0005-electron-shell.md)).
