import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveArtifact, shownUrl } from "./cad-pkg";

/**
 * `resolveArtifact` is where a string becomes a file read.
 *
 * The string can come from an assistant calling `show_artifact`, or from a `?file=`
 * in a URL, so "is this inside the open project" is the only thing standing between
 * a chat message and the filesystem. That deserves to be stated as a table rather
 * than read and trusted.
 *
 * The other half is just as load-bearing and much easier to miss: the `rel` it
 * hands back is the viewer's fetch URL, the value returned to the assistant, and
 * the recents entry, and it comes straight back in on the next request. A `rel`
 * that does not resolve is a file that opens once and never again.
 *
 * Note that escaping the project is guarded twice over: the `..` check on the way
 * in, and the realpath containment test on the way out. Removing either one alone
 * still refuses every case below, which is the point of having both.
 */

const failures: string[] = [];
const note = (why: string) => {
  failures.push(why);
  console.error(`  ✗ ${why}`);
};

const root = mkdtempSync(join(tmpdir(), "sfab-project-"));
const outside = mkdtempSync(join(tmpdir(), "sfab-outside-"));
try {
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "part.step"), "x");
  writeFileSync(join(root, "sub", "deep.stp"), "x");
  writeFileSync(join(root, "model.glb"), "x");
  writeFileSync(join(root, "notes.txt"), "x");
  writeFileSync(join(outside, "secret.step"), "x");
  // A directory that looks like a document. macOS bundles make this less silly
  // than it sounds, and `createReadStream` on one fails in a much worse place.
  mkdirSync(join(root, "folder.step"));
  symlinkSync(join(outside, "secret.step"), join(root, "escape.step"));

  /** Values that must resolve, and the project-relative path each must resolve to. */
  const allowed: [string, string][] = [
    ["part.step", "part.step"],
    ["./part.step", "part.step"],
    ["/part.step", "part.step"],
    ["sub/deep.stp", "sub/deep.stp"],
    // Windows separators: the desktop shell can hand these over.
    ["sub\\deep.stp", "sub/deep.stp"],
    // A cache-busting query is not part of the name.
    ["part.step?v=2", "part.step"],
    ["model.glb", "model.glb"],
    [`file://${realpathSync(root)}/part.step`, "part.step"],
  ];
  for (const [input, expected] of allowed) {
    const got = resolveArtifact(input, root);
    if ("error" in got)
      note(`${JSON.stringify(input)} was refused: ${got.error}`);
    else if (got.rel !== expected)
      note(
        `${JSON.stringify(input)} resolved to ${got.rel}, expected ${expected}`
      );
  }

  /** Values that must not resolve, whatever else happens. */
  const refused = [
    "../../../etc/passwd",
    "sub/../../secret.step",
    join(outside, "secret.step"),
    `file://${join(outside, "secret.step")}`,
    // A symlink inside the project pointing out of it. `realpath` is what catches
    // this one, and nothing else would.
    "escape.step",
    "folder.step",
    "https://example.com/a.step",
    "notes.txt",
    "",
    "   ",
  ];
  for (const input of refused) {
    const got = resolveArtifact(input, root);
    if (!("error" in got))
      note(
        `${JSON.stringify(input)} resolved to ${got.rel} — it should not have`
      );
  }

  /**
   * And the round trip, which is the part that actually broke. `mkdtemp` lands
   * under a symlink on macOS (`/var` → `/private/var`), so the project root here is
   * not its own realpath — exactly the case a user hits opening anything under
   * /tmp, a symlinked home, or a mounted volume.
   */
  const opened = resolveArtifact("part.step", root);
  if ("error" in opened) note(`opening part.step failed: ${opened.error}`);
  else {
    const url = shownUrl(opened);
    const back = resolveArtifact(url, root);
    if ("error" in back) {
      note(
        `the path handed to the viewer (${url}) is refused when it comes back: ${back.error}`
      );
    } else if (back.rel !== opened.rel) {
      note(`re-opening ${url} gave ${back.rel}, not ${opened.rel}`);
    }
  }

  const otherRoot = mkdtempSync(join(tmpdir(), "sfab-project-b-"));
  writeFileSync(join(otherRoot, "other.step"), "x");
  const fromOther = resolveArtifact("other.step", root);
  if (!("error" in fromOther))
    note("other.step resolved inside the first root — it should not have");
  const inOther = resolveArtifact("other.step", otherRoot);
  if ("error" in inOther)
    note(`other.step refused in its own root: ${inOther.error}`);
  rmSync(otherRoot, { recursive: true, force: true });
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

if (failures.length) {
  throw new Error(`${failures.length} cad-pkg failure(s)`);
}
console.log("cad-pkg.selfcheck ok");
