import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  ClientPrincipal,
  WorldSender,
  WorldServerMessage,
} from "@sfab-bench/contract";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { resolveUpgradePrincipal, runWithPrincipal } from "../principal";
import { resolveRequestRoot } from "../projects";
import { abortCapture, abortCaptureOf, startCapture } from "./capture-job";
import { handleLiveEdit, historiesForConnect } from "./edit";
import { attachWorld, type WorldHandle } from "./host";
import { parseFailureReply, parseWorldClient } from "./live-message";

/**
 * A world run is per document and streams poses at 30 Hz. The session
 * socket is one process-wide library stream, so this is its own upgrade:
 * `/api/world/live?project=&world=`. Auth matches the other project routes:
 * loopback is trusted, everyone else needs a paired token.
 */

const wss = new WebSocketServer({ noServer: true });

function reject(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function worldSender(principal: ClientPrincipal): WorldSender {
  // resolveUpgradePrincipal only returns loopback or a paired device.
  // An account principal is not produced on this path.
  if (principal.kind === "paired") {
    return { kind: "paired", label: principal.label || "Quest" };
  }
  if (principal.kind === "loopback") return { kind: "loopback", label: "Mac" };
  throw new Error("an account principal cannot open a world socket");
}

/** A failed seek or timeline read. Not a world `error`: the run stays up. */
export function scrubReadError(
  kind: "seek" | "timeline",
  message: string,
  nonce?: string
): Extract<WorldServerMessage, { type: "timeline-error" }> {
  if (kind === "seek" && nonce)
    return { type: "timeline-error", message, nonce };
  return { type: "timeline-error", message };
}

function send(ws: WebSocket, event: WorldServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

wss.on(
  "connection",
  (
    ws: WebSocket,
    _req: IncomingMessage,
    principal: ClientPrincipal,
    project: string,
    world: string
  ) => {
    let handle: WorldHandle | null = null;
    let closed = false;
    ws.on("close", () => {
      closed = true;
      abortCaptureOf(ws);
      handle?.detach();
    });
    ws.on("error", () => {
      closed = true;
      abortCaptureOf(ws);
      handle?.detach();
    });
    // A rejected attach must not become an unhandled rejection: that would
    // take down the API process.
    runWithPrincipal(principal, async () => {
      const attached = await attachWorld(project, world, {
        sender: worldSender(principal),
        onEvent(event) {
          send(ws, event);
        },
      });
      if ("error" in attached) {
        send(ws, {
          type: "error",
          errors: [],
          message: attached.error,
        });
        ws.close();
        return;
      }
      if (closed) {
        attached.detach();
        return;
      }
      handle = attached;
      ws.on("message", (data) => {
        const parsed = parseWorldClient(String(data));
        if ("error" in parsed) {
          send(ws, parseFailureReply(parsed));
          return;
        }
        if (parsed.type === "play") handle?.play(parsed.nonce);
        else if (parsed.type === "pause") handle?.pause(parsed.nonce);
        else if (parsed.type === "serial-send") {
          // A rejection is broadcast as board-error, including to this socket.
          handle?.sendSerial(parsed.board, parsed.text, parsed.nonce);
        } else if (parsed.type === "timeline") {
          // Loopback and paired clients both scrub. The reply stays on this socket.
          void handle?.timeline(parsed)?.then((result) => {
            if ("error" in result) {
              send(ws, scrubReadError("timeline", result.error));
              return;
            }
            send(ws, result);
          });
        } else if (parsed.type === "seek") {
          void handle?.seek(parsed.t, parsed.nonce)?.then((result) => {
            if ("error" in result) {
              send(ws, scrubReadError("seek", result.error, parsed.nonce));
              return;
            }
            send(ws, result);
          });
        } else if (parsed.type === "histories") {
          send(ws, {
            type: "histories",
            histories: historiesForConnect(project, world),
          });
        } else if (parsed.type === "capture") {
          startCapture(project, world, parsed, ws, (event) => send(ws, event));
        } else if (parsed.type === "capture-abort") {
          abortCapture(project, world, parsed.nonce);
        } else if (
          parsed.type === "edit" ||
          parsed.type === "undo" ||
          parsed.type === "redo"
        ) {
          void handleLiveEdit(project, world, parsed).then((event) => {
            if (event.type === "edited") return;
            send(ws, event);
          });
        } else if (principal.kind !== "loopback") {
          send(ws, {
            type: "error",
            errors: [],
            message: "step is only for this Mac",
          });
        } else handle?.step(parsed.n);
      });
    }).catch((err: unknown) => {
      console.error("[world] attach failed", err);
      send(ws, {
        type: "error",
        errors: [],
        message: "could not open this world",
      });
      ws.close();
    });
  }
);

export function tryUpgradeWorld(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/api/world/live") return false;
  const principal = resolveUpgradePrincipal(req);
  if (!principal) {
    reject(socket, 401, "Unauthorized");
    return true;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    reject(socket, 400, "Bad Request");
    return true;
  }
  const world = url.searchParams.get("world")?.trim() ?? "";
  if (!world) {
    reject(socket, 400, "Bad Request");
    return true;
  }
  let project: string | null;
  try {
    project = resolveRequestRoot(
      url.searchParams.get("project") ?? undefined,
      principal.kind
    );
  } catch (err) {
    const status = (err as { status?: number }).status === 403 ? 403 : 400;
    reject(socket, status, status === 403 ? "Forbidden" : "Bad Request");
    return true;
  }
  if (!project) {
    reject(socket, 409, "Conflict");
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    runWithPrincipal(principal, () => {
      wss.emit("connection", ws, req, principal, project, world);
    });
  });
  return true;
}
