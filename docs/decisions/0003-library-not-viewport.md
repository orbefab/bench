# ADR-0003: Share the library, not the viewport

**Status:** Accepted. Amended by [0009](0009-world-simulation.md) for worlds
**Date:** 2026-09-14
**Deciders:** Alwurts

## Context

Mac (loopback browser) and Quest (paired LAN browser) are both clients of
one process. An earlier session model treated the loaded STEP, selection,
active thread, and live assistant stream as one shared `ProjectSession`
and fanned them out over `/api/session/live`. Opening a file on the Mac
yanked the Quest onto that file. That is the wrong unit of sharing for
two people (or two eyes) looking at the same project.

## Decision

**Share the library. Keep the viewport per browser.**

Synced (server, every client may read):

- Recently opened **files** and recent **folders**
- Thread **list** and messages **at rest**
- Pairing / auth

The folder a tab is in is the tab's (`?project=`), like `?file=` among the
catalog ([ADR 0006](0006-folder-is-a-tab.md)). Recents for that folder stay
shared.

Not synced (per tab):

- Currently viewed file, selection, camera, XR placement
- Which chat is open, the live stream, harness/model/effort while typing

`show_artifact` changes only the **asking client** (a `data-viewer` part
on that request's stream) and appends the path to shared recents. It
does not set a process-wide current file. `?file=` is a deep link for
that tab, not session state.

The live WebSocket still exists, but it only pushes **library** events
(project path, file recents, catalog revision) so a param-less client can
refresh when the process fallback changes. A tab that names `?project=` is
not moved by someone else's tessellation ([ADR 0006](0006-folder-is-a-tab.md)).

## Consequences

### Positive
- Quest can see what Mac opened recently and pick one, without being
  forced onto it.
- Selection and chat stay local, so the prompt stamp (`[viewer]`) is
  what that client is actually looking at.

### Negative
- Two clients can be looking at different STEPs and different threads.
  That is intended.
- One agent run at a time remains a **per-workspace** lock (409) so two
  composers cannot stream into the same harness session at once.

### Mitigations
- Recents and the thread list are the way to join another client's
  work after the fact.
- Re-call `show_artifact` after rebuilding a STEP so the asking client
  reloads; other clients pick it up from Recents if they want.

## Implementation notes

- File recents: `file_recents` sqlite table, `POST /api/recents`, catalog
  / session snapshot include the list.
- Chat: `GET/POST /api/threads`, prefs on `PUT /api/threads/:id/prefs`.
  Active thread id is `localStorage` per project path.
- Dropped: `POST /api/session/doc`, `/selection`, `/thread`, `/prefs`,
  and live `doc` / `thread` / `prefs` WebSocket events.

## Related

- [0001](0001-new-private-repo.md) — this repo
- [0002](0002-step-loader-occt.md) — loader; independent of this split
- [0006](0006-folder-is-a-tab.md) — the folder is a tab's choice
