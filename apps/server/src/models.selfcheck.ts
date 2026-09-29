import { ok as expect } from "node:assert/strict";
import { join } from "node:path";

import { harnessHome } from "./local-sandbox";
import { opencodeBinCandidates } from "./models";

const otherHome = "/tmp/sfab-other-home";
const withProject = opencodeBinCandidates("/tmp/cad", otherHome);
expect(
  withProject[0] ===
    join(
      harnessHome(join(otherHome, ".sfab-bench")),
      ".harness-bootstrap/opencode/node_modules/.bin/opencode"
    ),
  "cache bootstrap is first"
);
expect(
  withProject.includes(
    "/tmp/cad/.harness-bootstrap/opencode/node_modules/.bin/opencode"
  ),
  "leftover project bootstrap is still a candidate"
);
expect(
  withProject.includes(join(otherHome, ".opencode/bin/opencode")),
  "OpenCode under that user's home"
);
expect(withProject.includes("/opt/homebrew/bin/opencode"), "Homebrew opencode");
expect(
  withProject.includes("/usr/local/bin/opencode"),
  "Intel Homebrew / usr/local"
);

const shared = join(
  harnessHome(join(otherHome, ".sfab-bench")),
  ".harness-bootstrap/opencode/node_modules/.bin/opencode"
);
const withoutProject = opencodeBinCandidates(null, otherHome);
expect(
  withoutProject.includes(shared),
  "the shared bootstrap is found without a project"
);
expect(
  withoutProject.filter((p) => p.includes(".harness-bootstrap")).length === 1,
  "no project means no project-relative bootstrap path"
);

console.log("models.selfcheck ok");
