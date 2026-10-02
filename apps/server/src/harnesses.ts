import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_IDS,
  HARNESS_LABEL,
  type HarnessId,
  type HarnessInfo,
  type HarnessModel,
  type HarnessStatus,
  STATIC_HARNESS_MODELS,
} from "@sfab-bench/contract";
import { harnessBridgeReady } from "./local-sandbox";
import { listOpenCodeModels } from "./models";

type ProbedHarness = Omit<HarnessInfo, "bridgeReady">;

function envSet(name: string) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function cursorLoggedIn() {
  // The Cursor adapter installs with privateHome, so the CLI's HOME is the
  // bootstrap dir. A Mac `agent login` (keychain + ~/.cursor) is invisible
  // to that process. The only credential the adapter forwards is CURSOR_API_KEY.
  return envSet("CURSOR_API_KEY");
}

function grokLoggedIn() {
  if (envSet("XAI_API_KEY")) return true;
  const auth = readJson(join(homedir(), ".grok", "auth.json"));
  if (!auth || typeof auth !== "object") return false;
  return Object.values(auth as Record<string, unknown>).some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const rec = entry as {
      key?: unknown;
      refresh_token?: unknown;
      auth_mode?: unknown;
    };
    return Boolean(rec.key || rec.refresh_token || rec.auth_mode);
  });
}

function staticModels(id: Exclude<HarnessId, "opencode">): HarnessModel[] {
  return STATIC_HARNESS_MODELS[id].map((m) => ({ ...m, slug: m.id }));
}

async function probeOpenCode(root?: string | null): Promise<ProbedHarness> {
  const catalog = await listOpenCodeModels(root);
  const models: HarnessModel[] = catalog.providers.flatMap((p) =>
    p.models.map((m) => ({
      id: m.slug,
      name: m.name,
      slug: m.slug,
      group: p.name,
    }))
  );
  if (!catalog.connected) {
    return {
      id: "opencode",
      label: HARNESS_LABEL.opencode,
      status: "missing-cli",
      detail: "OpenCode is not connected. Install the CLI.",
      defaultModel: DEFAULT_HARNESS_MODEL.opencode,
      models,
    };
  }
  return {
    id: "opencode",
    label: HARNESS_LABEL.opencode,
    status: "ready",
    defaultModel: DEFAULT_HARNESS_MODEL.opencode,
    models,
  };
}

function probeCodex(): ProbedHarness {
  const authed =
    envSet("OPENAI_API_KEY") ||
    envSet("CODEX_API_KEY") ||
    existsSync(join(homedir(), ".codex"));
  return {
    id: "codex",
    label: HARNESS_LABEL.codex,
    status: authed ? "ready" : "needs-auth",
    detail: authed
      ? undefined
      : "Run `codex login` on the Mac, or set OPENAI_API_KEY.",
    defaultModel: DEFAULT_HARNESS_MODEL.codex,
    models: staticModels("codex"),
  };
}

function probeCursor(): ProbedHarness {
  const authed = cursorLoggedIn();
  return {
    id: "cursor",
    label: HARNESS_LABEL.cursor,
    status: authed ? "ready" : "needs-auth",
    detail: authed
      ? undefined
      : "A Mac Cursor login is not visible to this app.",
    defaultModel: DEFAULT_HARNESS_MODEL.cursor,
    models: staticModels("cursor"),
  };
}

function probeGrok(): ProbedHarness {
  const authed = grokLoggedIn();
  return {
    id: "grok-build",
    label: HARNESS_LABEL["grok-build"],
    status: authed ? "ready" : "needs-auth",
    detail: authed
      ? undefined
      : "Run `grok login` on the Mac, or set XAI_API_KEY.",
    defaultModel: DEFAULT_HARNESS_MODEL["grok-build"],
    models: staticModels("grok-build"),
  };
}

export async function listHarnesses(
  root?: string | null
): Promise<{ harnesses: HarnessInfo[] }> {
  const opencode = await probeOpenCode(root);
  return {
    harnesses: HARNESS_IDS.map((id) => {
      const info =
        id === "opencode"
          ? opencode
          : id === "codex"
            ? probeCodex()
            : id === "cursor"
              ? probeCursor()
              : probeGrok();
      return { ...info, bridgeReady: harnessBridgeReady(info.id) };
    }),
  };
}
