# sfab-bench

A robotics simulation platform on your Mac: parts, boards, firmware and
physics in one world. Talk to it with the AI you already pay for.

Open a folder, open a STEP, talk with Codex, Claude Code, Grok, or OpenCode
already on the machine. This app does not take API keys for chat. Quest
Browser on the same Wi-Fi joins that process.

[bench.sfab.ai](https://bench.sfab.ai) · [Download](https://github.com/sfab-oss/sfab-bench/releases)

## Install

Unzip `sfab-bench-<version>-arm64.app.zip` from
[Releases](https://github.com/sfab-oss/sfab-bench/releases), drag it to
Applications, then **System Settings → Privacy & Security → Open Anyway**.
Ad-hoc signed, not notarised yet.

From a clone (Node 22.5+, [pnpm](https://pnpm.io)):

```bash
pnpm install
pnpm desktop
```

Quest: same Wi-Fi, Quest Browser, pair once. Details:
[`docs/user/`](docs/user/).

## After you install

Open a folder, open a STEP or GLB, then talk. This app does not author CAD.

- Already have parts: **Open folder** and pick that directory.
- Starting from scratch: clone
  [sfab-bench-starter](https://github.com/sfab-oss/sfab-bench-starter), Open
  that folder, pick `cad/block.step`. The starter already has Jake's
  [CAD skill](https://github.com/earthtojake/text-to-cad) and a Bench
  skill. Ask in chat for another part.

Do not open this app repo as a CAD project. It has no parts.

## Layout

```text
apps/desktop    Electron shell (folder dialog, starts the server)
apps/web        Mac and Quest client
apps/server     API, pairing, STEP loader, harness agents
apps/docs       Product home
```

MIT. See [`LICENSE`](LICENSE).
