# Testing

What "renders correctly" means here, and which parts of it are checked today.

Checks are plain top-level scripts named `*.selfcheck.ts`, run by `pnpm test`.
The desktop packager check is a `node` script next to `package.mjs`.
A check either prints `… ok` or throws, using `node:assert/strict`.
A check that tests one package lives in that package's `test/` folder and may
read files under `examples/`; checks that need the server or the catalog stay
in `apps/server/src`. Each package's `pnpm test` runs its list in one process:
`scripts/checks.mjs` hands the files to node's test runner
(`--test-isolation=none`) through `tsx`, or plain `node` when every file is
`.js` or `.mjs`.
The files run one after another in name order, each as one test. A failure
does not stop the files after it, and the run fails at the end. Because checks
share a process, a check restores what it changes (env, `console`) and reads a
process-wide counter as the change across its own run.

The log of two runs of one commit is byte-identical, so a line diff against the
previous head only shows real changes. Wall-clock lines (µs per step, real-time
factor, OCCT kernel times) print only with `BENCH_TIMINGS=1`. `CHECK_TIMES=<file>`
writes node's spec report, one line and duration per check, to that file.

The full suite is a local gate: run `pnpm test` before you land on a shared
branch. Pull requests and `main` run a light check on GitHub Actions:
`pnpm lint:check`, `pnpm typecheck`, and `pnpm test:smoke`. The smoke set is
a few fast checks that catch broken wiring: the layer boundaries, the engine
face, part loading, the CLI, degrade, a headless run, the arm baseline replay,
seams, the edit ops, the probe, and the web document path. It is not a physics proof. "Run workflow" on
the CI workflow runs the full suite by hand. CI does not package a `.app`.

## The ladder

"Correct" has several different reference points, and it is worth being
explicit about which one a given check is using. Each tier below has a
different **oracle** — the thing that knows the right answer.

| Tier | Oracle | Catches |
| --- | --- | --- |
| 0 Admissibility | the process | crashes, hangs, runaway memory, non-determinism |
| 1 Self-consistency | the package's own invariants | anything malformed, on **any** model |
| 2 Fidelity | the exact B-rep | dropped faces, reversed winding, wrong transforms, wrong units |
| 3 Metamorphic | a second run | regressions, without goldens |
| 4 Render | scene graph, then pixels | scale, up-axis, colour, pick refs |
| 5 VR | eye matrices, room scale | 1:1 size, spawn placement, stereo, frame budget |

The tiers that need no reference model are the valuable ones, because a
file nobody has ever looked at is still a test case for them. **A golden
package only tells you about the one model it was captured from, and goes
stale the moment the tessellator legitimately changes.** Prefer an
invariant to a golden every time one is available.

## Built

**Desktop — `package.selfcheck.mjs`.** Codex and OpenCode read lockfiles
out of `@ai-sdk/harness-*/dist/bridge`. electron-builder drops those from
`node_modules`, which is the ENOENT the `.app` used to show in chat.
The check confirms the npm packages still ship the files, that
`package.mjs` still copies them back, and — when `release/` has a
`.app` — that the packaged tree contains them. `package.mjs` itself
throws if a build would ship without them. Dock PATH (Homebrew,
`~/.opencode/bin`) is `config.selfcheck.ts` and `models.selfcheck.ts`.

**Tier 0–1 — `occt/invariants.ts`, run by `occt.corpus.selfcheck.ts`.**
`checkPackage(dir)` reads a built package back off disk and returns every
way it contradicts itself: a tree leaf with no occurrence, a component key
with no `.tess`, a `.tess` with no component, indices past the end of the
vertex array, non-unit normals, normals that disagree with their triangle's
winding, face ranges that do not tile the index buffer with dense 1-based
ordinals, a non-affine transform, a colour outside 0..1, a declared bbox
the geometry sticks out of. Determinism — the same STEP built twice in one
process giving a byte-identical package — is in `occt.selfcheck.ts`.

The `.tess` reader in `invariants.ts` is a deliberate second implementation
of the one in `apps/web/src/cad/decodeTess.ts`. An encoder checked by its
own inverse agrees with itself no matter what it writes.

Tessellation runs on a worker thread, so these checks exercise the same
path the server does, including the job timeout and the heap-watermark
retirement. Both of those were mutation-tested by shrinking their
constants until they fired.

**Tier 2 — `occt/solid.ts`.** `solidProps` measures volume, area, centre of
mass and bounding box from the exact B-rep; `meshProps` measures the same
four from the triangles, by the divergence theorem. The corpus check
compares them per solid.

This is the strongest geometric oracle available, because it needs no
reference file and no second kernel:

- a face dropped or a seam left open → mesh volume falls short
- winding reversed → **signed** mesh volume comes back negative
- a transform applied twice or not at all → the box moves
- a unit misread → everything is out by 25.4 or 1000

Tolerances are 2% on volume and area: tessellation is a chord
approximation so the numbers never match exactly, but a real defect misses
by tens of percent, never by tenths.

That measures each leaf solid **in its own frame**, so a second comparison
runs on the document as a whole: every occurrence's triangles placed by its
own transform, against `solidProps` of the free label's shape, which carries
its components' locations and is therefore OCCT's own answer for the
assembled result.

It closes the one gap the rest of the file could not see. `checkPackage`
confirms the declared bbox holds the geometry, but that bbox is computed by
the same code that did the placing, so it only ever agrees with itself. A
placement composed in the wrong order, applied at the wrong level of the
tree, or dropped entirely produces a package that passes everything else.
Centre of mass is the sensitive term: one instance in the wrong place barely
moves a bounding box and does not change the volume at all.

**Tier 4a — `cad/scene.selfcheck.ts`.** Everything after the package is
`buildScene` in `cad/loadStepPackage.ts`, which was split out of
`loadStepPackage` so it could be run without a browser: the fetching stayed
behind, the assembling is pure. It builds every fixture, decodes the `.tess`
files with the web decoder, and assembles the scene the viewer renders —
three.js in plain Node, no GPU, no canvas, no jsdom.

What it pins:

- **metres and up-axis.** `inch_block` has to come out 0.0508 x 0.0127 x 0.0254 m, with the 12.7mm CAD Z as the model's *height*. Get the rotation wrong and every number is still present, just on the wrong axis — which reads as the model lying down, or in VR as a wall.
- **the floor.** `sitHeight` must never leave a model sunk into the ground, and must leave one already clear of it alone. `curved_solids` and `bare_solids` dip below Z=0 and so exercise the lift; `deep_nest` sits above it and exercises the restraint.
- **refs.** Every part's `cadRef` is unique and names something the package contains.
- **faces.** A box has six faces, so six rays return six *different* ordinals drawn from exactly 1..6, and four points on one face all return the same one. A ref that means "wherever the mouse was" cannot be handed to an assistant.
- **the same file twice.** Rebuild and re-assemble, and the same ray returns the same ref. Package determinism is checked server-side; this is the other half.
- **winding, without pixels.** three derives `hit.face.normal` from the triangle's winding, not from the normal attribute, so a picked face whose normal points *away* from the ray is an inside-out solid. Dropping the `REVERSED` flip in `occt/mesh.ts` fails here as well as in the corpus check.
- **colour and name on the material.** Read back off `MeshStandardMaterial` and compared to the package. A swapped channel, or the `#9ca3af` default quietly standing in for a colour that was there all along, passes every check on the JSON and looks entirely plausible on screen.
- **one geometry per component.** `many_instances` is 120 placements of one solid and must produce one `BufferGeometry`. Cloning per occurrence runs a real assembly out of memory, and nothing else would notice until it did.
- **what `get_viewer` hands over.** `viewerSnapshot()` reaches its tree through `treeTops`, a different walk from the one that fills `parts`. A node dropped or regrouped there shows up as an assistant confidently discussing a part that is not in the file.

**Tier 5a — `scene/placement.selfcheck.ts`.** `placeAtGaze` and `faceToward`
are the whole of VR spawn placement and are pure functions of a camera pose,
so they need no headset. Both failure modes are invisible on a monitor: a
model that creeps closer as the wearer looks down (projecting the gaze
instead of flattening it), and a model that inherits the head's roll. The
second is the one that makes people take the headset off — the horizon of
the thing you are looking at is the only fixed reference the inner ear has.

Writing it turned up a real one. Looking straight up or down leaves the gaze
with no floor direction at all, and the old guard fell back to world north,
so a wearer facing any other way had the model jump behind them on the last
degree of head tilt. It now falls back to the head's own up vector — where
the forehead points — which is continuous with the gaze as it goes vertical,
and the check asserts that continuity rather than either branch's output.

## The corpus

`apps/server/fixtures/*.step`, written by
`node apps/server/scripts/make_fixtures.mjs`. **Generated, not collected**,
and deliberately not pointed at anyone's CAD folder — the checks have to
pass on a clean clone.

Generated beats collected here for two reasons. A real export mostly
exercises the happy path, whereas a file built to be awkward is where bugs
are. And a file we wrote is one we can state the right answer for.

Every fixture exists because some invariant would otherwise be untested:

| Fixture | Covers |
| --- | --- |
| `bracket_assembly` | a sub-assembly, shared geometry, a colour on an instance beating the product's |
| `curved_solids` | a sphere's degenerate poles, a torus's seam, a cone's apex |
| `cut_solid` | a boolean result, whose inner faces are `REVERSED` |
| `deep_nest` | five levels of placement, two of them rotations |
| `bare_solids` | no names, no colours — every fallback path |
| `many_instances` | one solid placed 120 times, so content-hash dedup has to hold |
| `inch_block` | a file whose declared length unit is not millimetres |

Adding a STEP to `fixtures/` adds a test: the corpus check sweeps the
directory.

`cut_solid` is there because of a mutation test. Every other fixture is a
`BRepPrimAPI` primitive, and those come out with every face `FORWARD`,
which left the branch in `mesh.ts` that flips a `REVERSED` face's winding
entirely untested — deleting it changed nothing. With a boolean cut in the
corpus, deleting it fails by 19.2%.

`inch_block` settles a question rather than guarding a known behaviour.
`loadStepPackage.ts` scales by a hardcoded `0.001` and never reads the
package's `units`, which is only correct if OCCT converts non-millimetre
files on the way in. It does: a 2 x 1 x 0.5 **inch** block reads back as
50.8 x 25.4 x 12.7 mm. That conversion is now load-bearing and asserted,
because without it every inch-authored STEP would draw 25.4x too small.

The fixture is written in millimetres and then has its unit declaration
rewritten as text, because this OCCT build does not expose the
`write.step.unit` static — `SetCVal` returns false and the writer emits
millimetres regardless.

**If you add a check, mutate the code it covers and confirm it fails.** A
check that passes against a broken tessellator is worse than no check,
because it is also a claim.

## Not built yet, and mostly not planned

**Tier 4b — pixels. Decided against.** It is not unheard of: three.js runs
screenshot E2E tests with a tolerance, and Google's model-viewer does render
fidelity comparison. Both are large projects funding a permanent harness. Here
it means standing up a GL context — headless Chrome over CDP, or a Node WebGL
binding — and then tuning tolerances until driver variation stops causing false
failures, all before the first assertion. The defect it was going to catch that
nothing else could, inside-out solids, is caught by the ray-normal check in
Tier 4a instead; colour and material state turned out to be readable straight
off the scene graph. What is genuinely left is only *layout* — coverage
fraction and screen-space centroid — and that is not worth a renderer.

**Tier 3 — metamorphic. Deferred.** Build at two deflections, check the coarser
mesh stays inside the finer one's bounds and keeps the same face ordinals. The
idea is good and it would catch a mesher upgrade silently renumbering faces,
which would break every `#o….fN` in a saved thread. But `LINEAR_DEFLECTION` is
a module constant in `occt/mesh.ts`, and changing a signature to make a test
possible is its own kind of cost. Worth doing when there is a second reason to
parameterise it.

**Tier 5b — stereo and budget.** Render from both eye matrices and check a part
appears in both with horizontal disparity of the right sign for its depth;
inverted eyes are nauseating and completely invisible on a monitor. Assert draw
calls and triangle counts in CI; record real frame times on-device as a tracked
number rather than a pass/fail. Wants a headset in the loop to earn its keep.

## Known gaps

Things the checks deliberately do not cover, written down so they are not
mistaken for coverage.

- **Transparency is unreachable from a STEP.** `labelColor` in `occt/document.ts` reads a `Quantity_Color` and hardcodes alpha to 1, so `occ.color[3]` is always 1 and the viewer's `transparent` / `depthWrite` branches never run. The material check asserts them, but only ever against the opaque case.
- **`namedKids`' filter is a GLB-path guard.** Every group `buildScene` makes is either a listed part or has children, so removing the filter changes nothing for a STEP package. It is not dead — `loadCadReview` needs it — just untested from here.
- **`loadStepPackage`'s flat fallback** for a package with no `assembly.root` is never exercised; nothing the loader writes today omits it.
- **`group.userData.cadRef`** is written and read by nothing.

**`cad-pkg.selfcheck.ts`** covers the other end of the loop: `resolveArtifact`,
where a string from an assistant's `show_artifact` or a `?file=` becomes a file
read. A table of what must resolve and what must not — `..`, a symlink inside the
project pointing out of it, an absolute path outside, `file://` outside, a
directory named like a document — and the round trip, which is the part that
actually broke. Escaping is guarded twice, by the `..` check on the way in and the
realpath containment test on the way out; removing either alone still refuses
every case, which is why both are there.

## On external models

Free-to-download is not free-to-redistribute. GrabCAD, TraceParts,
McMaster-Carr, SnapEDA and most vendor part libraries let you download and
use a model without granting you the right to ship it in a repo, and on
user-upload sites the provenance is unreliable besides. Autodesk's Fusion 360
Gallery dataset is research-use only. The ABC dataset is MIT on the packaging,
but its million models are Onshape public documents whose copyright stays with
their authors, described as free for *research* — fine to fetch, not to commit.

So nothing is committed. `fixtures/external.manifest.json` records where each
model came from, what it is licensed under, and the sha256 its bytes must have;
`pnpm corpus:fetch` downloads them into `fixtures/external/`, which is
gitignored. What is committed is the manifest and the expectations.

Three sources, each with terms read rather than assumed:

| Source | Terms | What it adds |
| --- | --- | --- |
| NIST MBE PMI, 33 files | Public domain, 17 U.S.C. §105 — NIST states the models "can be used without any restrictions" | AP203 and AP242 written by four different CAD systems, vendor identification stripped. Its own README says they are **not** error-free files, which is the point |
| OCCT `screw.step` | LGPL-2.1, part of OCCT | Helical surfaces, far more faces per millimetre than anything generated |
| OCCT `linkrods.step` | LGPL-2.1, part of OCCT | A real 1.8MB assembly, from the test data of the kernel we tessellate with |

The two I previously listed without checking are gone. CAx-IF publishes its
interoperability models for exactly this use but I could find no explicit
redistribution grant, so its terms are unread. KiCad's `packages3D` is
CC-BY-SA 4.0: redistributing the library files carries share-alike, which is
not something to attach to a product repo, and they are electronic component
models rather than mechanical assemblies.

### What the fetcher guarantees

- **https only, to hosts the manifest names** — and the host is checked again *after* redirects, so a redirect cannot walk the download somewhere else
- **sha256 verified before anything lands.** A mismatch writes nothing and says so. Pinned by content, not by branch: the OCCT URLs name a commit, so "the file changed" is impossible to miss
- **archives unpack with paths junked**, so no entry can write outside its directory however it is named inside the zip
- **nothing downloaded is executed**, only parsed as STEP
- **no licence, no download.** An entry without `licence` and `licenceUrl` is refused

Both guards are verified by breaking them: a wrong hash and an off-list host
each abort the fetch.

### Running it

`pnpm corpus:external`, after `pnpm corpus:fetch`. It is **not** part of
`pnpm test`, and on a clean clone it prints "skipped" and passes — the suite
must never depend on someone else's server being up.

What it asserts is narrower than the generated corpus, deliberately. Tiers 0
and 1 apply to any file at all and are hard failures. Tier 2 is **reported and
not enforced**: the divergence theorem needs a closed, consistently wound
surface, and open shells, surface bodies and tessellated geometry are all
legitimate STEP. Failing on those would train everyone to ignore the check.

### What the first run found, and what came of it

35 models, 26 failures, and none of them the tessellator being wrong: every
closed solid matched its B-rep volume. The corpus was right about geometry and
wrong about everything around it. All 26 are now fixed or explained.

**22 × a tree leaf with no occurrence.** One bug. A STEP product can carry no
surfaces — a datum axis, a centreline, a branch of annotation — and the loader
left every one in the tree with nothing behind it: a row that cannot be picked
or coloured, answering to a `#o1.2` an assistant could be handed and act on.
`prune` in `occt/package.ts` now drops them, and an assembly whose children all
go, goes too. `annotation_only.step` reproduces all four cases.

**1 × a zero-length normal.** `mesh.ts` builds a vertex normal by summing the
triangles around it, and `|| 1` turned a zero sum into `(0, 0, 0)` — not a
normal, and black under any light. It really happens: NIST's ctc_05 has a vertex
belonging to exactly one zero-area sliver, so there is no direction to be had
from the triangles at all. It now falls back to the face's own average, which is
exactly right for the planar faces where this is likeliest.

No generated fixture reproduces this one. Cones with true apexes, tiny top radii,
sphere poles, torus seams, knife-edge wedges, tangent holes, kissing holes and
grazing slabs were all tried; none produce a sliver. It needs a real mesher
artefact on a real face, so the NIST file is the reproduction and
`pnpm corpus:external` is where it is pinned. Mutating the fallback back out
fails there, which is the proof that would otherwise have come from a fixture.

**3 × the kernel refusing the file.** opencascade.js 1.1.1 exports none of
`wasmTable`, `__cxa_can_catch` or `__cxa_is_pointer_type`, so when OCCT raises a
C++ exception emscripten's dispatch reaches for something that is not there and
it surfaces as a TypeError about its own internals. Nothing here can fix that.
What was fixed is the report: `briefError` now says the kernel rejected the file
and cannot say why, instead of `wasmTable.get(...) is not a function`. The kernel
survives it — the next file builds correctly, which was checked — so these are
counted as unopenable rather than thrown, and the count is printed so it is
visible if it grows.

**1 × a 23.1% volume gap that was not a gap.** `VolumeProperties` is asked for
closed shapes only, so a free-standing surface contributes nothing to it, while
the mesh tessellates every face there is. stc_08 is one closed solid beside an
open shell of 271 faces: both sides right, measuring different things. 9 of the
35 models turn out to be like this, which is worth knowing about real CAD. The
check now says "closed solid beside an open shell — not comparable" rather than
printing a percentage that reads as a defect.

This is the argument for the fetch corpus in one paragraph: eight fixtures
written to be awkward found none of this, because they were written by someone
who already knew what the loader did.
