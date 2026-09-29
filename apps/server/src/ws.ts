import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ClientPrincipal } from "@sfab-bench/contract";
import { type WebSocket, WebSocketServer } from "ws";

import { resolveUpgradePrincipal, runWithPrincipal } from "./principal";
import { type SessionSocket, sendSnapshot, subscribeSession } from "./session";

const wss = new WebSocketServer({ noServer: true });

function pathOf(req: IncomingMessage) {
  return (req.url ?? "").split("?")[0];
}

function wrap(ws: WebSocket): SessionSocket {
  return {
    send: (data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
  };
}

wss.on(
  "connection",
  (ws: WebSocket, _req: IncomingMessage, principal: ClientPrincipal) => {
    const socket = wrap(ws);
    const unsub = subscribeSession(socket);
    sendSnapshot(socket, principal);
    ws.on("close", () => unsub());
    ws.on("error", () => unsub());
  }
);

export function tryUpgradeSession(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const path = pathOf(req);
  if (path !== "/api/session/live") return false;
  const principal = resolveUpgradePrincipal(req);
  if (!principal) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    runWithPrincipal(principal, () => {
      wss.emit("connection", ws, req, principal);
    });
  });
  return true;
}
