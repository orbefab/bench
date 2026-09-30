# Decisions (ADRs)

Architecture Decision Records for choices that are expensive to reverse.
Use [`template.md`](template.md) (SFab 4-digit). Prefer a short note in
`docs/notes/` until a decision needs this permanence.

| ADR | Call |
| --- | --- |
| [0001-new-private-repo](0001-new-private-repo.md) | New private repo; do not merge sfab-cad |
| [0002-step-loader-occt](0002-step-loader-occt.md) | Destination STEP loader is our own OpenCascade WASM tessellator |
| [0003-library-not-viewport](0003-library-not-viewport.md) | Share recents and thread history; a STEP or GLB viewport stays per client; a world's run is shared (0009) |
| [0004-occt-via-opencascade-js](0004-occt-via-opencascade-js.md) | The OCCT kernel is prebuilt opencascade.js; the tessellator is ours |
| [0005-electron-shell](0005-electron-shell.md) | Electron is a shell around the same server and the same page |
| [0006-folder-is-a-tab](0006-folder-is-a-tab.md) | The folder is a tab's choice, not the process's |
| [0007-harness-chat-fill](0007-harness-chat-fill.md) | Chat continue is fill vs prompt from the live session, not the UI-tool helper |
| [0009-world-simulation](0009-world-simulation.md) | A world is the document; MuJoCo and an avr8js board; one shared run |
| [0010-layered-simulation](0010-layered-simulation.md) | Parts run at levels on three axes and contribute equations to shared engines; own MNA circuit engine; types v1 |
| [0011-one-document-kind](0011-one-document-kind.md) | The part is the only document; captures are project snapshots and overlays; ports fix once used; only an unreadable document blocks Play |
| [0012-layers-and-plugin-seams](0012-layers-and-plugin-seams.md) | Seven layers that import only downward; edits through typed operations; compile-time form, tool, importer and engine registries |
