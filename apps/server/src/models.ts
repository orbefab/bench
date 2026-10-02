import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { APP_HOME } from "./config";
import { harnessHome } from "./local-sandbox";

const execFileAsync = promisify(execFile);

export type OpenCodeModel = {
  id: string;
  name: string;
  slug: string;
};

export type OpenCodeProvider = {
  id: string;
  name: string;
  models: OpenCodeModel[];
};

export type ModelsResponse = {
  connected: boolean;
  providers: OpenCodeProvider[];
};

const SLUG_LINE = /^(\S+\/\S+)\s*$/;

function parseModelsCli(stdout: string): OpenCodeProvider[] {
  const byId = new Map<string, OpenCodeProvider>();
  const lines = stdout.split("\n");
  let slug: string | null = null;
  const jsonLines: string[] = [];

  const flush = () => {
    if (slug === null || jsonLines.length === 0) {
      slug = null;
      jsonLines.length = 0;
      return;
    }
    const raw = jsonLines.join("\n").trim();
    jsonLines.length = 0;
    const sep = slug.indexOf("/");
    const providerId = sep > 0 ? slug.slice(0, sep) : "";
    const modelId = sep > 0 ? slug.slice(sep + 1) : "";
    const currentSlug = slug;
    slug = null;
    if (!providerId || !modelId || !raw) return;
    try {
      const parsed = JSON.parse(raw) as { id?: string; name?: string };
      const name =
        typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name.trim()
          : modelId;
      const id =
        typeof parsed.id === "string" && parsed.id.trim()
          ? parsed.id.trim()
          : modelId;
      let provider = byId.get(providerId);
      if (!provider) {
        provider = { id: providerId, name: providerId, models: [] };
        byId.set(providerId, provider);
      }
      provider.models.push({ id, name, slug: currentSlug });
    } catch {
      /* skip unparseable model JSON */
    }
  };

  for (const line of lines) {
    const slugMatch = line.trimStart().startsWith("{")
      ? null
      : SLUG_LINE.exec(line);
    if (slugMatch) {
      flush();
      slug = slugMatch[1]!;
    } else if (slug !== null) {
      jsonLines.push(line);
    }
  }
  flush();
  return [...byId.values()].map((p) => ({
    ...p,
    models: p.models.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function opencodeBinCandidates(
  root?: string | null,
  home = homedir()
): string[] {
  const candidates: string[] = [];
  candidates.push(
    join(
      harnessHome(join(home, ".sfab-bench")),
      ".harness-bootstrap/opencode/node_modules/.bin/opencode"
    )
  );
  if (root)
    candidates.push(
      join(root, ".harness-bootstrap/opencode/node_modules/.bin/opencode")
    );
  candidates.push(
    join(home, ".sfab-bench/tools/opencode/node_modules/.bin/opencode")
  );
  candidates.push(join(home, ".opencode/bin/opencode"));
  candidates.push("/opt/homebrew/bin/opencode");
  candidates.push("/usr/local/bin/opencode");
  return candidates;
}

function opencodeBin(root?: string | null): string {
  for (const candidate of opencodeBinCandidates(root)) {
    if (existsSync(candidate)) return candidate;
  }
  return "opencode";
}

function modelsCwd(root?: string | null): string {
  return root || APP_HOME;
}

let cached: { root: string; at: number; value: ModelsResponse } | null = null;
const CACHE_MS = 10_000;

export async function listOpenCodeModels(
  root?: string | null
): Promise<ModelsResponse> {
  const key = root ?? "";
  if (cached && cached.root === key && Date.now() - cached.at < CACHE_MS)
    return cached.value;
  const empty: ModelsResponse = { connected: false, providers: [] };
  const bin = opencodeBin(root);
  if (bin !== "opencode" && !existsSync(bin)) {
    cached = { root: key, at: Date.now(), value: empty };
    return empty;
  }
  try {
    const { stdout } = await execFileAsync(bin, ["models", "--verbose"], {
      cwd: modelsCwd(root),
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 25_000,
    });
    const providers = parseModelsCli(stdout);
    const value: ModelsResponse = {
      connected: providers.length > 0,
      providers,
    };
    cached = { root: key, at: Date.now(), value };
    return value;
  } catch (err) {
    console.error(
      "[api] opencode models failed",
      err instanceof Error ? err.message : err
    );
    cached = { root: key, at: Date.now(), value: empty };
    return empty;
  }
}
