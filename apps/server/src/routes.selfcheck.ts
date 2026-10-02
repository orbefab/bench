/**
 * The HTTP routes through `app.request`, with a fake Node socket as the
 * `incoming` binding: the pairing gate in front of `/api`, then the
 * world-view route on a copy of `examples/nano`. Function-level checks of
 * the same pieces are `auth.selfcheck.ts` and `project.selfcheck.ts`; this
 * one proves the middleware and the routes are wired to them.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "./app";
import { db } from "./db";
import { closeRootWatches } from "./projects";

const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

/** A request as `@hono/node-server` hands it over: the socket's peer and headers. */
function socket(
  remoteAddress: string,
  headers: Record<string, string> = {}
): { incoming: IncomingMessage } {
  return {
    incoming: {
      headers,
      socket: { remoteAddress },
      url: "/",
    } as unknown as IncomingMessage,
  };
}

const LOOPBACK = socket("127.0.0.1");

async function call(
  path: string,
  env: { incoming: IncomingMessage },
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(path, init, env);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

// The gate: a LAN client with no token is refused before any route runs,
// also when it comes through the dev proxy (loopback peer, forwarded LAN).
{
  const lan = await call("/api/me", socket("192.168.1.20"));
  expect(
    lan.status === 401 && lan.body.error === "pairing required",
    `LAN /api/me: ${JSON.stringify(lan)}`
  );
  const proxied = await call(
    "/api/me",
    socket("127.0.0.1", { "x-forwarded-for": "192.168.1.20" })
  );
  expect(
    proxied.status === 401,
    `proxied LAN /api/me: ${JSON.stringify(proxied)}`
  );
  const me = await call("/api/me", LOOPBACK);
  expect(
    me.status === 200 &&
      JSON.stringify(me.body) ===
        JSON.stringify({ principal: { kind: "loopback" } }),
    `loopback /api/me: ${JSON.stringify(me)}`
  );
  // Pairing is the one public route: a bad body is the validator's 400,
  // not the gate's 401.
  const pair = await call("/api/pair", socket("192.168.1.20"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(pair.status === 400, `empty pair body: ${JSON.stringify(pair)}`);
  console.log(
    "routes gate: LAN 401 direct and through the proxy, loopback is loopback, pair is public"
  );
}

// The world view: a folder that is not there is refused by the gate; a
// world plans to its view; a missing or broken world is a 400 with the
// planner's sentence.
const dir = mkdtempSync(join(tmpdir(), "sfab-routes-"));
const project = join(dir, "nano");
try {
  cpSync(nanoExample, project, { recursive: true });
  writeFileSync(join(project, "broken.world.json"), "{ not json");
  const query = (world: string) =>
    `/api/world/view?project=${encodeURIComponent(project)}&world=${encodeURIComponent(world)}`;

  const gone = await call(
    `/api/world/view?project=${encodeURIComponent(join(dir, "gone"))}&world=x`,
    LOOPBACK
  );
  expect(
    gone.status === 400 && typeof gone.body.error === "string",
    `a folder that is not there: ${JSON.stringify(gone)}`
  );

  const view = await call(query("parts/sfab/nano-led@1.0.0.json"), LOOPBACK);
  const boards = view.body.boards as
    | { id: string; pins?: string[] }[]
    | undefined;
  const nano = boards?.find((board) => board.id === "nano");
  expect(
    view.status === 200 && nano?.pins?.includes("D13") === true,
    `nano-led view: ${JSON.stringify(view).slice(0, 400)}`
  );

  const missing = await call(query("parts/sfab/nope@1.0.0.json"), LOOPBACK);
  expect(
    missing.status === 400 && typeof missing.body.error === "string",
    `missing world: ${JSON.stringify(missing)}`
  );
  const broken = await call(query("broken.world.json"), LOOPBACK);
  expect(
    broken.status === 400 &&
      String(broken.body.error).startsWith("World file is not JSON."),
    `broken world: ${JSON.stringify(broken)}`
  );
  console.log(
    `routes world view: missing folder 400; nano-led plans ${boards?.length ?? 0} board(s) with D13; missing world 400; not JSON 400: ${broken.body.error}`
  );
} finally {
  db.prepare("DELETE FROM projects WHERE path = ?").run(project);
  closeRootWatches((root) => root.startsWith(dir));
  rmSync(dir, { recursive: true, force: true });
}

console.log("routes.selfcheck ok");
