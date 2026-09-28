# AGENTS.md

Tier-1 entry point for anyone — human or AI agent — working in this repo.
Follow the links for detail.

## Project

**sfab-bench** — a robotics simulation platform: global server, open a
folder, open a world, talk. CAD, firmware, and electronics sit around
that one view. Quest Browser joins the same Mac process and shares the
library. A world's live run is shared per document.
[sfab-oss/sfab-bench](https://github.com/sfab-oss/sfab-bench).
Site: [bench.sfab.ai](https://bench.sfab.ai).

Living plan: [`docs/product.md`](docs/product.md). World direction:
[ADR 0009](docs/decisions/0009-world-simulation.md). Do not add accounts,
a tunnel, or a second tessellator in this tree without an ADR. The
Electron shell is [ADR 0005](docs/decisions/0005-electron-shell.md)
— it wraps the server and the same page, and gains no UI of its own.

## Commands

Run from the **monorepo root**:

| Task | Command |
| --- | --- |
| Dev (API + Vite HTTPS) | `pnpm dev` |
| Desktop app (Electron) | `pnpm desktop` |
| Package a `.app` + Releases zip | `pnpm desktop:package` |
| Cut a GitHub Release | [`.agents/skills/release/`](.agents/skills/release/) |
| Open a folder then serve | `pnpm cli open /abs/path` |
| Open a folder then Vite | `pnpm cli open /abs/path --dev` |
| Run a world headless | `pnpm cli run /abs/path <world> [--ms N]` |
| Type check | `pnpm typecheck` |
| Marketing site (local) | `pnpm --filter @sfab-bench/docs dev` |
| Format + lint (fix) | `pnpm lint:fix` |
| Lint (check only) | `pnpm lint:check` |
| Self-checks | `pnpm test` |
| Production build | `pnpm build` |
| Serve dist + API | `pnpm serve` |

PRs and `main` run `lint:check`, `typecheck`, and `test` on GitHub Actions.
Do not wait on a desktop `.app` or `pnpm build` there.

Mac tab: `https://127.0.0.1:7322`. Quest needs the LAN host, not loopback.

## Where things live

- **User runbook** → [`docs/user/`](docs/user/)
- **Product plan** → [`docs/product.md`](docs/product.md)
- **Product manual (target UX)** → [`docs/manual.md`](docs/manual.md)
- **Architecture** → [`docs/architecture.md`](docs/architecture.md)
- **Testing criteria** → [`docs/testing.md`](docs/testing.md)
- **ADRs** → [`docs/decisions/`](docs/decisions/)
- **Working notes** → [`docs/notes/`](docs/notes/)
- **Server** → `apps/server/src/`
- **Web client** → `apps/web/src/`
- **Desktop shell** → `apps/desktop/src/`
- **Shared types** → `packages/contract/`
- **Parts (L1)** → `packages/parts/`
- **Circuit engine (L2)** → `packages/engine-circuit/`
- **MCU engine (L2)** → `packages/engine-mcu/`
- **Body engine (L2)** → `packages/engine-body/`
- **Simulation (L3)** → `packages/sim/` (`Sim`, form adapters, capture)
- **Headless run** → `sfab-bench run <projectDir> <world> [--ms N]` (`apps/server/src/run.ts`)
- **Marketing site** → `apps/docs/` (manifesto home; local `:7323`)
- **How agents use the viewer** → [`.agents/skills/sfab-bench/`](.agents/skills/sfab-bench/)
- **How to cut a GitHub Release** → [`.agents/skills/release/`](.agents/skills/release/)

`.claude/CLAUDE.md` is a copy of this file. `.claude/skills/sfab-bench`
and `.claude/skills/release` symlink the skills above.

## Conventions

- Project = a directory. A STEP or GLB in it is a document. A world is `<name>.world.json` ([ADR 0009](docs/decisions/0009-world-simulation.md)). Agent cwd = that directory. Bench does not author the CAD or compile the firmware.
- Tessellation is a loader, not a project adapter. It is OCCT WASM in the API process, and the only one ([ADR 0002](docs/decisions/0002-step-loader-occt.md), [ADR 0004](docs/decisions/0004-occt-via-opencascade-js.md)).
- Loopback is trusted. Anything else on `/api` needs pairing.
- Electron is a shell: same server, same `https://127.0.0.1:7322` page, plus a native folder dialog. `apps/web` never imports from it ([ADR 0005](docs/decisions/0005-electron-shell.md)).
- Mac and Quest share recents and thread history. The folder is the tab's (`?project=`). Each client keeps its own STEP or GLB file, selection, and live chat ([ADR 0003](docs/decisions/0003-library-not-viewport.md), [ADR 0006](docs/decisions/0006-folder-is-a-tab.md)). A world's run is shared per document; camera, selection, lens, and scrub stay per client ([ADR 0009](docs/decisions/0009-world-simulation.md)).
- Do not merge `sfab-oss/sfab-cad` (cloud + Godot). That choice is [ADR 0001](docs/decisions/0001-new-private-repo.md).
- Do not commit machine-specific home paths or usernames. CLI examples use `/abs/path`.
