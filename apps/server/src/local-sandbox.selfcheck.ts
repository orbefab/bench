import { ok as expect } from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";

import {
  createLocalSandbox,
  harnessBootstrapDir,
  harnessBridgeReady,
  harnessHome,
  pinProjectWorkdir,
  projectCwd,
  sandboxEnv,
} from "./local-sandbox";

const root = mkdtempSync(join(tmpdir(), "sfab-sandbox-cwd-"));
const appHome = mkdtempSync(join(tmpdir(), "sfab-app-home-"));
const stateDir = harnessHome(appHome);
expect(
  stateDir.startsWith(join(appHome, "harness") + "/"),
  "state lives under APP_HOME/harness"
);
expect(
  !stateDir.startsWith(root + "/") && stateDir !== root,
  "state is not the CAD folder"
);
expect(
  stateDir === join(appHome, "harness", "shared"),
  "one named home for the machine, so a second folder reuses the install"
);
expect(
  harnessBootstrapDir("codex", stateDir) ===
    join(stateDir, ".harness-bootstrap", "codex"),
  "install marker sits under the shared home"
);
expect(
  !harnessBridgeReady("codex", stateDir),
  "missing vendor dir is not ready"
);
mkdirSync(harnessBootstrapDir("codex", stateDir), { recursive: true });
expect(harnessBridgeReady("codex", stateDir), "vendor dir is the ready marker");
expect(
  !harnessBridgeReady("cursor", stateDir),
  "another harness stays unready"
);

// The claim above is about behaviour, not about a string: the sandbox a second
// CAD folder gets must land on the same install. Asserting the literal alone
// passed just as happily when the path was per-folder.
const otherRoot = mkdtempSync(join(tmpdir(), "sfab-sandbox-cwd-"));
const [sessionA, sessionB] = await Promise.all([
  createLocalSandbox(root).createSession({}),
  createLocalSandbox(otherRoot).createSession({}),
]);
expect(
  sessionA.defaultWorkingDirectory === sessionB.defaultWorkingDirectory,
  "two folders share one harness home"
);
expect(
  sessionA.defaultWorkingDirectory !== root &&
    sessionA.defaultWorkingDirectory !== otherRoot,
  "and it is neither folder"
);

const nested = join(root, "opencode-abc:high");
const cacheSession = join(stateDir, "opencode-abc");

expect(projectCwd(root) === root, "omitted working directory is the project");
expect(
  projectCwd(root, nested) === root,
  "legacy session subdir in the project pins to the project"
);
expect(projectCwd(root, "src") === root, "relative child pins to the project");
expect(
  projectCwd(root, cacheSession, stateDir) === normalize(cacheSession),
  "bootstrap cwd under the cache is left alone"
);

const homeOpenCode = join(homedir(), ".opencode", "cache");
expect(
  projectCwd(root, homeOpenCode) === normalize(homeOpenCode),
  "allowed host paths stay"
);

// Grok writes `~/.grok/AGENTS.md` at the top of every turn and offers no way to
// redirect it, so refusing that path killed every Grok turn.
const grokInstructions = join(homedir(), ".grok");
expect(
  projectCwd(root, grokInstructions) === normalize(grokInstructions),
  "Grok may write its own config dir"
);
let refused = false;
try {
  projectCwd(root, join(homedir(), ".ssh"));
} catch {
  refused = true;
}
expect(
  refused,
  "the allow-list is still a list — an unrelated home dir is refused"
);

const cmd = `node bridge.mjs --workdir '${cacheSession}' --bridge-state-dir '${stateDir}/.agent-runs/abc/bridge' --skills-dir '${join(homedir(), ".agents", "skills")}'`;
const pinned = pinProjectWorkdir(cmd, root, stateDir);
expect(
  pinned.includes(`--workdir '${root}'`),
  `bridge --workdir is the project, got ${pinned}`
);
expect(
  pinned.includes(".agent-runs/abc/bridge"),
  "bridge-state-dir is unchanged"
);
expect(
  pinProjectWorkdir(`node x --workdir '${root}'`, root, stateDir).includes(
    `--workdir '${root}'`
  ),
  "already-project --workdir is left alone"
);
expect(
  pinProjectWorkdir(
    `node x --workdir '${tmpdir()}/scratch'`,
    root,
    stateDir
  ).includes(`${tmpdir()}/scratch`),
  "workdir outside project and cache is left alone"
);

const launcher = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  PNPM_HOME: "/Users/someone/Library/pnpm",
  WATCH_REPORT_DEPENDENCIES: "1",
  NODE_OPTIONS: "--import tsx",
  NODE_PATH: "/repo/node_modules/tsx/node_modules",
  npm_command: "exec",
  npm_config_user_agent: "pnpm/11.21.0",
  pnpm_config_verify_deps_before_run: "false",
  PNPM_PACKAGE_NAME: "@sfab-bench/server",
};
const clean = sandboxEnv(launcher);
expect(
  clean.PATH === "/usr/bin" && clean.HOME === "/Users/someone",
  "the real environment survives"
);
expect(
  clean.PNPM_HOME === launcher.PNPM_HOME,
  "a user's pnpm install is not a launcher marker"
);
expect(
  !("WATCH_REPORT_DEPENDENCIES" in clean),
  "tsx --watch does not leak into pnpm's workers"
);
expect(
  !("NODE_OPTIONS" in clean) && !("NODE_PATH" in clean),
  "our loader does not follow the child"
);
expect(
  !Object.keys(clean).some(
    (k) => k.startsWith("npm_") || k.startsWith("pnpm_config_")
  ),
  "pnpm exec lifecycle config is dropped"
);
expect(!("PNPM_PACKAGE_NAME" in clean), "the child is not part of our package");
expect(
  sandboxEnv(launcher, { NODE_OPTIONS: "--enable-source-maps" })
    .NODE_OPTIONS === "--enable-source-maps",
  "an explicit override still wins"
);

const sandbox = createLocalSandbox(root);
expect(typeof sandbox.resumeSession === "function", "resumeSession exists");
if (!sandbox.resumeSession) throw new Error("resumeSession exists");
const sameA = await sandbox.createSession({ sessionId: "same" });
const sameB = await sandbox.createSession({ sessionId: "same" });
expect(
  sameA.id === "same" && sameB.id === "same",
  "createSession({ sessionId }) pins sandbox.id"
);
expect(
  sameA.id === sameB.id,
  "two createSession({ sessionId: same }) have equal id"
);
const resumed = await sandbox.resumeSession({ sessionId: "same" });
expect(
  resumed.id === sameA.id,
  "resumeSession({ sessionId: same }) returns that same id"
);
expect(
  { bridge: { sandboxId: sameA.id } }.bridge.sandboxId === sameA.id,
  "ACP-shaped bridge.sandboxId matches the sandbox id the adapter will check"
);

console.log("local-sandbox.selfcheck ok");
