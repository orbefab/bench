# Bench — architecture notes (lean)

**Audience:** developing agents / engineers  
**Status:** consolidated feedback + thin recommendations implied by the product manual  
**Pair with:** `bench-user-manual.md` (product truth — review that first)  
**Scratch (not this handoff):** `bench-world-builder-ux.md`, `bench-part-schema-sketch.md`, `bench-world-builder-ux-log.md`

Keep this document short. Prefer invariants over schemas. Field-level shapes live in code or in the optional schema scratch — not here.

---

## 1. Original design feedback (spine)

Bench’s world sim is **multiphysics with specialized engines**, not one mega-solver:

- **MuJoCo** (and similar) for bodies / contact / mechanics  
- **MNA** (and similar) for circuits  
- **avr8js** (and similar) for MCU firmware  
- **Part models** / glue where a domain doesn’t deserve its own engine  

**Orchestration**

- One **orchestrator** owns time: a **master clock**, stepping and exchanging at **port seams**.  
- Tight numerical loops stay **inside** one engine. Do not flatten everything into a single global matrix “for simplicity.”  
- **Ports are runtime law.** Prefer **energy-style** ports (effort/flow style thinking) so different domains can meet without lying.  
- **Energy residuals at seams** are the honesty signal when coupling is imperfect — surface them; don’t paper over them.  
- Stay out of **magnetics / FEM** on the realtime path.

**Fidelity**

- **Levels / snapshots** are the fidelity dial: same **exposed ports**, either live (engines) or snapped (cheap stand-in).  
- Snapshot **container** is universal: ports + typed **form** + envelope + error + provenance.  
- **Forms stay typed** (e.g. table-like vs motor-like) — **not** one mega universal table for all domains. Multi-domain port sets on a part/composite snapshot are allowed.  
- Grouping + capture is an **optimization**: promote a subgroup when its ports behave; climb the tree with **speed / envelope / cost** warnings for uncaptured depth.  
- **Do not bake test-fixture supplies** into reusable snapshots; parents bring their own power.  
- Inner edits **dirty upward**; stale snapped levels warn rather than silently lying. Prefer meaningful axes of capture over one opaque blob when the domain needs it.

**Product-shaped consequence (unchanged intent)**

- Hierarchical parts with clear ports; navigate/edit the owning definition; live and snapped share the port face.

---

## 2. Thin recommendations (from the locked product)

These are **implementation leans** so architecture doesn’t fight the manual. They are not a full file format spec.

1. **One document kind** for user-facing projects — a part document (no parallel “world” document with a hidden environment). Composition *is* environment.  
2. **No phantom env object** in the runtime: gravity plates, PSUs, grounds exist only as parts in the tree (or not at all).  
3. **Play** is always legal on an open part; missing drivers ⇒ idle / unpowered behaviour, not a hard gate.  
4. **Capture** writes an embedded **snapshot-form level** onto the **selected part’s definition** (history, deletable). Not a separate user-facing snapshot document for v1. Reuse the universal snapshot shell + typed forms from §1.  
5. **Imports:** one canonical payload per category (e.g. glTF visual, STL body for sim, URDF as the robot carry, Intel HEX for board images); convert or copy in; don’t retain non-matching originals as a second source of truth.  
6. **Agent UI state:** don’t invent stored agent play/pause chrome; ordinary logs / chat suffice.

Exact JSON, port-name collision heuristics, and per-type Capture recipes are **open** — resolve in code against the manual, not by thickening this file.

---

## 3. Out of scope here

- Button layout, hotkeys, tab parking chrome → user manual  
- Illustrative JSON trees / run-blob field lists → optional `bench-part-schema-sketch.md` only  
- FMU / standards export paths → later  

---

## 4. How to use these two handoffs

1. Read **user manual** — product behaviour.  
2. Read **this file** — engine/port/snapshot invariants + the few product-aligned leans.  
3. Implement; if schema detail is needed, treat the schema scratch as hints, not law.
