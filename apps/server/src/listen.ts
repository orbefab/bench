import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import { getCertificate } from "@vitejs/plugin-basic-ssl";

import {
  apiPort,
  certDir,
  DEV_API_HOST,
  ensureLoginLikePath,
  loadHomeEnv,
  publicPort,
} from "./config";
import { handleRequest } from "./http";
import { printJoinBanner } from "./join-banner";
import { bootProject, subscribeProjectChange } from "./projects";
import { hydrateSession } from "./session";
import { tryUpgradeWorld } from "./world/live";
import { tryUpgradeSession } from "./ws";

const isDev = process.env.SFAB_BENCH_DEV === "1";
// The desktop shell bundles this file somewhere else, so it says where dist is.
const dist =
  process.env.SFAB_BENCH_WEB_DIST ??
  fileURLToPath(new URL("../../web/dist", import.meta.url));

function onError(
  err: unknown,
  res: {
    headersSent: boolean;
    statusCode: number;
    end: (body?: string) => void;
  }
) {
  console.error("[api]", err);
  if (res.headersSent) return;
  res.statusCode = 500;
  res.end(err instanceof Error ? err.message : String(err));
}

/**
 * A failed `listen` arrives as an unhandled `error` event, which takes the process
 * down with a stack trace nobody can act on. EADDRINUSE is the one that actually
 * happens — a second `pnpm dev`, or the desktop shell racing one — so say that.
 */
function onListenError(
  err: NodeJS.ErrnoException,
  host: string,
  port: number
): void {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[api] ${host}:${port} is already taken. Another sfab-bench is running.`
    );
  } else {
    console.error(`[api] could not listen on ${host}:${port}: ${err.message}`);
  }
  process.exit(1);
}

async function main() {
  loadHomeEnv();
  ensureLoginLikePath();
  subscribeProjectChange(() => {
    hydrateSession();
  });
  bootProject();
  hydrateSession();
  if (isDev) {
    const port = apiPort();
    const server = createHttpServer((req, res) => {
      void handleRequest(req, res).catch((err) => onError(err, res));
    });
    server.on("upgrade", (req, socket, head) => {
      if (tryUpgradeSession(req, socket, head)) return;
      if (tryUpgradeWorld(req, socket, head)) return;
      socket.destroy();
    });
    server.requestTimeout = 0;
    server.on("error", (err) => onListenError(err, DEV_API_HOST, port));
    server.listen(port, DEV_API_HOST, () => {
      console.log(
        `[api] http://${DEV_API_HOST}:${port} (dev, loopback only; Vite proxies /api)`
      );
    });
    return;
  }

  const port = publicPort();
  const pem = await getCertificate(certDir());
  const server = createHttpsServer({ key: pem, cert: pem }, (req, res) => {
    void handleRequest(req, res, { staticRoot: dist }).catch((err) =>
      onError(err, res)
    );
  });
  server.on("upgrade", (req, socket, head) => {
    if (tryUpgradeSession(req, socket, head)) return;
    if (tryUpgradeWorld(req, socket, head)) return;
    socket.destroy();
  });
  server.requestTimeout = 0;
  server.on("error", (err) => onListenError(err, "0.0.0.0", port));
  server.listen(port, "0.0.0.0", () => {
    printJoinBanner("serve");
  });
}

void main();
