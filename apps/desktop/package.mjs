#!/usr/bin/env node
/**
 * Stages a self-contained app directory, then packages it with electron-builder.
 *
 * The staging step exists because pnpm's node_modules is a tree of symlinks into
 * a content-addressed store, and electron-builder wants a plain directory it can
 * copy. `app/` gets its own package.json with only the dependencies the bundled
 * server still loads at runtime, installed flat with npm.
 *
 * Signing is auto-detected from the environment: omitting secrets only makes
 * the artefact unsigned. `CSC_NAME` or `CSC_LINK` → electron-builder
 * signs. Notary env (`APPLE_ID` + app-specific password + `APPLE_TEAM_ID`, or an
 * API key) → notarize. Otherwise: identity null, then ad-hoc `codesign -`, then
 * `ditto --keepParent` so the zip keeps that signature.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertHarnessBridgeAssets } from "./harness-bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const stage = join(here, "app");
// Staged beside the real thing and moved into place at the end, so a run that
// fails half way through leaves the last good app/ — and its node_modules —
// exactly where it was.
const next = join(here, "app.next");
const previous = join(here, "app.prev");

const serverPkg = JSON.parse(
  readFileSync(join(here, "..", "server", "package.json"), "utf8")
);
const desktopPkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

const runtimeDeps = Object.fromEntries(
  Object.entries(serverPkg.dependencies).filter(
    ([name]) => !name.startsWith("@sfab-bench/")
  )
);

const canSign = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);
const canNotarise = Boolean(
  (process.env.APPLE_ID &&
    (process.env.APPLE_APP_SPECIFIC_PASSWORD ||
      process.env.APPLE_ID_PASSWORD) &&
    process.env.APPLE_TEAM_ID) ||
    (process.env.APPLE_API_KEY &&
      process.env.APPLE_API_KEY_ID &&
      process.env.APPLE_API_ISSUER)
);

const run = (cmd, args, cwd) => {
  const env = { ...process.env };
  // Empty is not enough: Electron treats a present ELECTRON_RUN_AS_NODE as
  // "run this file as Node", and then `app` is undefined.
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(cmd, args, { cwd, stdio: "inherit", env });
};

console.log("[package] building bundles");
run("node", [join(here, "build.mjs")], here);

if (!existsSync(join(root, "apps", "web", "dist", "index.html"))) {
  throw new Error(
    "apps/web/dist is missing — run `pnpm --filter @sfab-bench/web build` first"
  );
}

console.log("[package] staging app/");
rmSync(next, { recursive: true, force: true });
mkdirSync(next, { recursive: true });
// Carried over so npm has something to work from; it prunes and adds as needed.
if (existsSync(join(stage, "node_modules"))) {
  cpSync(join(stage, "node_modules"), join(next, "node_modules"), {
    recursive: true,
  });
}
writeFileSync(
  join(next, "package.json"),
  `${JSON.stringify(
    {
      name: "sfab-bench",
      productName: "sfab-bench",
      version: desktopPkg.version,
      description: desktopPkg.description,
      author: desktopPkg.author,
      homepage: desktopPkg.homepage,
      private: true,
      main: "main.cjs",
      dependencies: runtimeDeps,
    },
    null,
    2
  )}\n`
);
for (const file of ["main.cjs", "preload.cjs"]) {
  cpSync(join(here, "dist", file), join(next, file));
}
for (const file of ["api.mjs", "occt-worker.mjs", "world-worker.mjs"]) {
  cpSync(join(here, "..", "server", "dist", file), join(next, file));
}
cpSync(join(root, "apps", "web", "dist"), join(next, "web"), {
  recursive: true,
});

console.log("[package] installing runtime dependencies (npm, flat)");
run(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
  next
);

rmSync(previous, { recursive: true, force: true });
if (existsSync(stage)) renameSync(stage, previous);
renameSync(next, stage);
rmSync(previous, { recursive: true, force: true });

const builderArgs = ["--config", join(here, "electron-builder.yml")];
if (!canSign) {
  // Force unsigned even if a random identity sits in the keychain.
  builderArgs.push("-c.mac.identity=null");
}
if (canSign && canNotarise) {
  builderArgs.push("-c.mac.notarize=true");
}
console.log(
  `[package] electron-builder (${canSign ? "signed" : "unsigned"}${canSign && canNotarise ? ", notarize" : ""})`
);
assertHarnessBridgeAssets(stage, "staged app/");
run(join(here, "node_modules", ".bin", "electron-builder"), builderArgs, here);

/**
 * electron-builder always excludes pnpm-lock.yaml (and similar lockfiles)
 * after the files glob, so each @ai-sdk harness dist/bridge loses the files
 * Codex and OpenCode read via import.meta.url. Copy them back from the
 * staged app/ before signing — adding files after codesign invalidates it.
 */
function restoreHarnessBridgeAssets(appPath) {
  const stagedAi = join(stage, "node_modules", "@ai-sdk");
  const packedAi = join(
    appPath,
    "Contents",
    "Resources",
    "app",
    "node_modules",
    "@ai-sdk"
  );
  if (!existsSync(stagedAi) || !existsSync(packedAi)) {
    throw new Error(
      `harness bridge restore: missing @ai-sdk in stage or ${appPath}`
    );
  }
  let restored = 0;
  for (const pkg of readdirSync(stagedAi, { withFileTypes: true })) {
    if (!pkg.isDirectory() || !pkg.name.startsWith("harness-")) continue;
    const stagedBridge = join(stagedAi, pkg.name, "dist", "bridge");
    if (!existsSync(stagedBridge)) continue;
    const packedBridge = join(packedAi, pkg.name, "dist", "bridge");
    mkdirSync(packedBridge, { recursive: true });
    for (const name of readdirSync(stagedBridge)) {
      const from = join(stagedBridge, name);
      if (!statSync(from).isFile()) continue;
      cpSync(from, join(packedBridge, name));
      restored += 1;
    }
  }
  console.log(
    `[package] restored ${restored} harness bridge files into ${appPath}`
  );
  assertHarnessBridgeAssets(
    join(appPath, "Contents", "Resources", "app"),
    "packaged app"
  );
}

/**
 * Without a developer identity, electron-builder leaves the .app carrying
 * Electron's own signature over contents we then replaced. On Apple silicon an
 * invalid signature is worse than none: the kernel refuses to launch the binary
 * at all, with nothing in the UI to say why. An ad-hoc signature (`-`) is not a
 * developer identity and does not notarise, but it is valid, and the app starts
 * after System Settings → Privacy & Security → Open Anyway.
 */
const release = join(here, "release");
const apps = readdirSync(release, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(release, entry.name, "sfab-bench.app"))
  .filter((path) => existsSync(path));
if (process.platform === "darwin") {
  if (!apps.length) throw new Error(`no sfab-bench.app under ${release}`);
  for (const app of apps) {
    restoreHarnessBridgeAssets(app);
    if (canSign && process.env.CSC_NAME) {
      console.log(`[package] re-signing ${app}`);
      run(
        "codesign",
        [
          "--force",
          "--deep",
          "--options",
          "runtime",
          "--sign",
          process.env.CSC_NAME,
          app,
        ],
        here
      );
      run("codesign", ["--verify", "--deep", "--strict", app], here);
    } else if (!canSign) {
      console.log(`[package] ad-hoc signing ${app}`);
      run("codesign", ["--force", "--deep", "--sign", "-", app], here);
      run("codesign", ["--verify", "--deep", "--strict", app], here);
    } else {
      console.warn(
        "[package] CSC_LINK signing: restore happened after electron-builder; re-sign before distributing"
      );
    }
  }
  const arch = process.arch === "arm64" ? "arm64" : process.arch;
  const zipPath = join(
    release,
    `sfab-bench-${desktopPkg.version}-${arch}.app.zip`
  );
  rmSync(zipPath, { force: true });
  for (const app of apps) {
    console.log(`[package] ditto ${zipPath}`);
    run("ditto", ["-c", "-k", "--keepParent", app, zipPath], here);
  }
  console.log(`[package] done: ${apps.join(", ")} → ${zipPath}`);
} else {
  console.log(`[package] done: ${apps.join(", ")}`);
}
