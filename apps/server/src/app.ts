import type { HttpBindings } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_MODEL,
  isChatEffort,
  isHarnessId,
} from "@sfab-bench/contract";
import type { UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import {
  handleCadPkg,
  handleProjectFile,
  resolveArtifact,
  shownUrl,
} from "./cad-pkg";
import { handleChat } from "./chat";
import { listHarnesses } from "./harnesses";
import { listOpenCodeModels } from "./models";
import {
  ensureOffer,
  joinInfo,
  labelFromUserAgent,
  mintOffer,
  redeemCode,
  redeemFragment,
} from "./pairing";
import {
  type ClientPrincipal,
  publicPrincipal,
  resolvePrincipal,
  runWithPrincipal,
} from "./principal";
import {
  catalogRevision,
  currentProject,
  listBrowse,
  listFileRecents,
  listProjectFiles,
  listRecents,
  openProject,
  projectRow,
  resolveRequestRoot,
} from "./projects";
import { rememberOpenedFile, snapshotFor, stopSessionRun } from "./session";
import { setStoredSttApiKey, sttApiKey } from "./stt";
import {
  createThread,
  getThread,
  listThreads,
  saveMessages,
  saveThreadPrefs,
} from "./threads-db";
import { handleTranscribe } from "./transcribe";
import { planWorld, WORLD_V1_MESSAGE } from "./world/plan";
import { viewOf } from "./world/view";

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: { principal: ClientPrincipal; projectRoot?: string };
};

const pairBodySchema = z
  .object({
    code: z.string().optional(),
    fragment: z.string().optional(),
  })
  .refine((body) => Boolean(body.code?.trim() || body.fragment?.trim()), {
    message: "code or fragment required",
  });

const saveMessagesSchema = z.object({
  messages: z.array(z.unknown()),
});

const openProjectSchema = z.object({
  path: z.string().min(1),
});

const recentFileSchema = z.object({
  path: z.string().min(1),
});

const sttKeySchema = z.object({
  apiKey: z.string(),
});

const sessionPrefsSchema = z.object({
  harness: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

function denyLoopback(c: {
  get: (key: "principal") => ClientPrincipal;
  json: (body: unknown, status: 403) => Response;
}) {
  if (c.get("principal").kind === "loopback") return null;
  return c.json({ error: "only for this Mac" }, 403);
}

function denyNoProject(c: {
  get: (key: "projectRoot") => string | undefined;
  json: (body: unknown, status: 409) => Response;
}) {
  if (c.get("projectRoot")) return null;
  return c.json({ error: "open a folder first" }, 409);
}

function isPublicPair(method: string, path: string) {
  const clean = path.replace(/\/$/, "") || "/";
  return method === "POST" && (clean === "/pair" || clean === "/api/pair");
}

function projectPayload(root?: string | null) {
  const project = root ? projectRow(root) : currentProject();
  const path = project?.path ?? root ?? null;
  return {
    project,
    recents: listRecents(),
    fileRecents: listFileRecents(path),
    revision: catalogRevision(path),
  };
}

function prefsFromBody(body: {
  harness?: string;
  model?: string;
  effort?: string;
}) {
  const harness =
    body.harness && isHarnessId(body.harness) ? body.harness : DEFAULT_HARNESS;
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_HARNESS_MODEL[harness];
  const effort =
    body.effort && isChatEffort(body.effort)
      ? body.effort
      : DEFAULT_CHAT_EFFORT;
  return { harness, model, effort };
}

export const api = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (isPublicPair(c.req.method, path)) {
      await next();
      return;
    }
    const principal = resolvePrincipal(c.env.incoming);
    if (!principal) return c.json({ error: "pairing required" }, 401);
    c.set("principal", principal);
    try {
      const root = resolveRequestRoot(c.req.query("project"), principal.kind);
      if (root) c.set("projectRoot", root);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (status === 400 || status === 403) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          status as 400 | 403
        );
      }
      throw err;
    }
    await runWithPrincipal(principal, () => next());
  })
  .post("/pair", zValidator("json", pairBodySchema), (c) => {
    const body = c.req.valid("json");
    const label = labelFromUserAgent(c.req.header("user-agent") ?? undefined);
    const code = body.code?.trim() ?? "";
    const fragment = body.fragment?.trim() ?? "";
    const result = code
      ? redeemCode(code, label)
      : redeemFragment(fragment, label);
    if (result === "expired")
      return c.json({ error: "pairing code expired" }, 410);
    if (result === "invalid") return c.json({ error: "pairing failed" }, 401);
    return c.json(result);
  })
  .get("/me", (c) => c.json({ principal: publicPrincipal(c.get("principal")) }))
  .get("/settings/stt", (c) => {
    const denied = denyLoopback(c);
    if (denied) return denied;
    const { source } = sttApiKey();
    return c.json({ configured: source !== null, source });
  })
  .put("/settings/stt", zValidator("json", sttKeySchema), (c) => {
    const denied = denyLoopback(c);
    if (denied) return denied;
    setStoredSttApiKey(c.req.valid("json").apiKey);
    const { source } = sttApiKey();
    return c.json({ configured: source !== null, source });
  })
  .get("/pairing", (c) => {
    if (c.get("principal").kind !== "loopback") {
      return c.json({ error: "pairing info is only for this Mac" }, 403);
    }
    return c.json(joinInfo(ensureOffer()));
  })
  .post("/pairing", (c) => {
    if (c.get("principal").kind !== "loopback") {
      return c.json({ error: "pairing info is only for this Mac" }, 403);
    }
    return c.json(joinInfo(mintOffer()));
  })
  .get("/project", (c) => {
    return c.json(projectPayload(c.get("projectRoot")));
  })
  .post("/project", zValidator("json", openProjectSchema), (c) => {
    const denied = denyLoopback(c);
    if (denied) return denied;
    try {
      const row = openProject(c.req.valid("json").path);
      return c.json(projectPayload(row.path));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        status as 400
      );
    }
  })
  .get("/browse", (c) => {
    const denied = denyLoopback(c);
    if (denied) return denied;
    try {
      return c.json(listBrowse(c.req.query("path")));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        status as 400
      );
    }
  })
  .get("/catalog", (c) => {
    const root = c.get("projectRoot");
    if (!root)
      return c.json({ files: [], recents: [], revision: catalogRevision() });
    return c.json({
      files: listProjectFiles(root),
      recents: listFileRecents(root),
      revision: catalogRevision(root),
    });
  })
  .get("/session", (c) => {
    return c.json(snapshotFor(c.get("principal")));
  })
  .post("/recents", zValidator("json", recentFileSchema), (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    const root = c.get("projectRoot")!;
    try {
      const resolved = resolveArtifact(c.req.valid("json").path, root);
      if ("error" in resolved) return c.json({ error: resolved.error }, 400);
      return c.json({ recents: rememberOpenedFile(shownUrl(resolved), root) });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        status as 400
      );
    }
  })
  .post("/chat/stop", (c) => {
    stopSessionRun(c.get("projectRoot"));
    return c.json({ ok: true });
  })
  .get("/models", async (c) => {
    return c.json(await listOpenCodeModels(c.get("projectRoot")));
  })
  .get("/harnesses", async (c) => {
    return c.json(await listHarnesses(c.get("projectRoot")));
  })
  .get("/threads", (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    return c.json(listThreads(c.get("projectRoot")!));
  })
  .post("/threads", (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    return c.json(createThread(c.get("projectRoot")!), 201);
  })
  .get("/threads/:id", (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    const row = getThread(c.req.param("id"), c.get("projectRoot")!);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  })
  .put("/threads/:id/prefs", zValidator("json", sessionPrefsSchema), (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    const prefs = prefsFromBody(c.req.valid("json"));
    if (!saveThreadPrefs(c.req.param("id"), c.get("projectRoot")!, prefs)) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ thread: prefs });
  })
  .put("/threads/:id", zValidator("json", saveMessagesSchema), (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    const { messages } = c.req.valid("json");
    if (
      !saveMessages(
        c.req.param("id"),
        c.get("projectRoot")!,
        messages as UIMessage[]
      )
    ) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ ok: true });
  })
  .post("/chat", async (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    return handleChat(c.req.raw, c.get("projectRoot")!);
  })
  .post("/transcribe", async (c) => {
    return handleTranscribe(c.req.raw);
  })
  .on(["GET", "HEAD"], "/cad-pkg/*", async (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    return handleCadPkg(c.req.raw, c.get("projectRoot")!);
  })
  .on(["GET", "HEAD"], "/files/*", async (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    return handleProjectFile(c.req.raw, c.get("projectRoot")!);
  })
  .get("/world/view", async (c) => {
    const denied = denyNoProject(c);
    if (denied) return denied;
    const world = c.req.query("world") ?? "";
    const planned = planWorld(c.get("projectRoot")!, world);
    if (!planned.ok) {
      const message = planned.errors.map((error) => error.message).join("; ");
      return c.json(
        {
          error: message.includes(WORLD_V1_MESSAGE)
            ? WORLD_V1_MESSAGE
            : message || "World file did not load.",
        },
        400
      );
    }
    return c.json(viewOf(planned.plan));
  });

export const app = new Hono().route("/api", api);
export type AppType = typeof api;
