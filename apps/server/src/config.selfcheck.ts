import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyEnvFile,
  homeEnvPath,
  loginLikePath,
  loginPathExtras,
  parseEnvFile,
} from "./config";

const otherHome = "/tmp/sfab-other-home";
const extras = loginPathExtras(otherHome);
expect(extras.includes("/opt/homebrew/bin"), "Homebrew bin");
expect(extras.includes("/usr/local/bin"), "usr/local bin");
expect(
  extras.includes(join(otherHome, ".opencode/bin")),
  "~/.opencode/bin under that home"
);
expect(
  extras.includes(join(otherHome, "Library/pnpm")),
  "pnpm home under that home"
);

const current = "/usr/bin:/bin:/usr/sbin:/sbin";
const next = loginLikePath(current);
expect(next.includes("/usr/bin"), "keeps /usr/bin");
expect(next.includes("/bin"), "keeps /bin");
const parts = next.split(":");
expect(parts.filter((p) => p === "/usr/bin").length === 1, "dedupes /usr/bin");
if (parts.includes("/opt/homebrew/bin")) {
  expect(
    parts.indexOf("/opt/homebrew/bin") < parts.indexOf("/usr/bin"),
    "Homebrew precedes system PATH"
  );
}

const again = loginLikePath(`${next}:/usr/bin`);
expect(
  again.split(":").filter((p) => p === "/usr/bin").length === 1,
  "dedupes when extras already on PATH"
);

const listen = readFileSync(new URL("./listen.ts", import.meta.url), "utf8");
expect(listen.includes("ensureLoginLikePath()"), "API boot patches PATH");
expect(listen.includes("loadHomeEnv()"), "API boot loads ~/.sfab-bench/.env");

const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
expect(cli.includes("loadHomeEnv()"), "CLI loads home env before open/serve");
expect(
  cli.indexOf("loadHomeEnv()") < cli.indexOf("SFAB_BENCH_PROJECT"),
  "home env loads before cli open overrides the project"
);

expect(
  homeEnvPath("/tmp/sfab-other-home") ===
    join("/tmp/sfab-other-home", ".sfab-bench", ".env"),
  "home env path sits next to state.sqlite"
);

const parsed = parseEnvFile(`
# comment
STT_AI_GATEWAY_API_KEY=from-file
export SFAB_BENCH_PROJECT="/tmp/cad"
EMPTY=
not a line
BAD KEY=no
`);
expect(parsed.STT_AI_GATEWAY_API_KEY === "from-file", "parses unquoted");
expect(parsed.SFAB_BENCH_PROJECT === "/tmp/cad", "parses export and quotes");
expect(!("EMPTY" in parsed), "skips empty values");
expect(!("BAD KEY" in parsed), "skips invalid keys");

const env: NodeJS.ProcessEnv = { STT_AI_GATEWAY_API_KEY: "from-shell" };
applyEnvFile(parsed, env);
expect(env.STT_AI_GATEWAY_API_KEY === "from-shell", "shell wins");
expect(env.SFAB_BENCH_PROJECT === "/tmp/cad", "fills unset keys");

console.log("config.selfcheck ok");
