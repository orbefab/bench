import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  type EditOp,
  SERIAL_TEXT_MAX,
  WORLD_NONCE_MAX,
  type WorldClientMessage,
  type WorldSender,
  type WorldServerMessage,
} from "@sfab-bench/contract";
import { readEditOp } from "@sfab-bench/parts";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { ClientPrincipal } from "../principal";
import { resolveUpgradePrincipal, runWithPrincipal } from "../principal";
import { resolveRequestRoot } from "../projects";
import { handleLiveEdit, historiesForConnect } from "./edit";
import { attachWorld, type WorldHandle } from "./host";

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

type ParsedClient =
  | WorldClientMessage
  | { error: string }
  | { error: string; kind: "board"; board: string; nonce?: string };

function boardParseError(
  message: string,
  board: unknown,
  nonce: unknown
): ParsedClient {
  const id = typeof board === "string" ? board : "";
  if (
    typeof nonce === "string" &&
    nonce.length > 0 &&
    nonce.length <= WORLD_NONCE_MAX
  ) {
    return { error: message, kind: "board", board: id, nonce };
  }
  return { error: message, kind: "board", board: id };
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

export function parseWorldClient(raw: string): ParsedClient {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { error: "message is not JSON" };
  }
  if (!value || typeof value !== "object")
    return { error: "message is not an object" };
  const type = (value as { type?: unknown }).type;
  if (type === "play" || type === "pause") {
    const nonce = (value as { nonce?: unknown }).nonce;
    if (nonce === undefined) return { type };
    if (
      typeof nonce !== "string" ||
      nonce.length < 1 ||
      nonce.length > WORLD_NONCE_MAX
    ) {
      return { error: "nonce must be a short string" };
    }
    return { type, nonce };
  }
  if (type === "step") {
    const n = (value as { n?: unknown }).n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return { error: "step needs a whole number of steps" };
    }
    return { type: "step", n };
  }
  if (type === "serial-send") {
    const board = (value as { board?: unknown }).board;
    const text = (value as { text?: unknown }).text;
    const nonce = (value as { nonce?: unknown }).nonce;
    if (typeof board !== "string" || board.length < 1 || board.length > 64) {
      return boardParseError("serial needs a board id", board, nonce);
    }
    if (typeof text !== "string" || text.length > SERIAL_TEXT_MAX) {
      return boardParseError(
        `serial text must be a string of at most ${SERIAL_TEXT_MAX} characters`,
        board,
        nonce
      );
    }
    if (nonce === undefined) return { type: "serial-send", board, text };
    if (
      typeof nonce !== "string" ||
      nonce.length < 1 ||
      nonce.length > WORLD_NONCE_MAX
    ) {
      return boardParseError("nonce must be a short string", board, nonce);
    }
    return { type: "serial-send", board, text, nonce };
  }
  if (type === "timeline") {
    const from = (value as { from?: unknown }).from;
    const to = (value as { to?: unknown }).to;
    const maxPoints = (value as { maxPoints?: unknown }).maxPoints;
    if (typeof from !== "number" || !Number.isFinite(from) || from < 0) {
      return { error: "timeline needs a start time" };
    }
    if (typeof to !== "number" || !Number.isFinite(to) || to < from) {
      return { error: "timeline needs an end time" };
    }
    if (
      typeof maxPoints !== "number" ||
      !Number.isInteger(maxPoints) ||
      maxPoints < 1
    ) {
      return { error: "timeline needs a point count" };
    }
    return { type: "timeline", from, to, maxPoints };
  }
  if (type === "seek") {
    const t = (value as { t?: unknown }).t;
    const nonce = (value as { nonce?: unknown }).nonce;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      return { error: "seek needs a time" };
    }
    if (
      typeof nonce !== "string" ||
      nonce.length < 1 ||
      nonce.length > WORLD_NONCE_MAX
    ) {
      return { error: "nonce must be a short string" };
    }
    return { type: "seek", t, nonce };
  }
  if (type === "undo" || type === "redo") {
    const part = (value as { part?: unknown }).part;
    if (part !== undefined && typeof part !== "string") {
      return { error: "part must be a part id" };
    }
    return { type, ...(typeof part === "string" ? { part } : {}) };
  }
  if (type === "histories") return { type: "histories" };
  if (type === "edit") {
    const ops = (value as { ops?: unknown }).ops;
    const label = (value as { label?: unknown }).label;
    const part = (value as { part?: unknown }).part;
    const confirm = (value as { confirm?: unknown }).confirm;
    if (!Array.isArray(ops) || ops.length === 0) {
      return { error: "edit needs operations" };
    }
    if (label !== undefined && typeof label !== "string") {
      return { error: "edit needs operations" };
    }
    if (part !== undefined && typeof part !== "string") {
      return { error: "part must be a part id" };
    }
    if (confirm !== undefined && confirm !== "break") {
      return { error: "confirm must be break" };
    }
    const parsed: EditOp[] = [];
    for (const item of ops) {
      const read = readEditOp(item);
      if ("error" in read) return { error: read.error };
      parsed.push(read);
    }
    return {
      type: "edit",
      ops: parsed,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof part === "string" ? { part } : {}),
      ...(confirm === "break" ? { confirm } : {}),
    };
  }
  return { error: "unknown world message" };
}

function send(ws: WebSocket, event: unknown) {
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
      handle?.detach();
    });
    ws.on("error", () => {
      closed = true;
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
          if ("kind" in parsed && parsed.kind === "board") {
            send(ws, {
              type: "board-error",
              board: parsed.board,
              message: parsed.error,
              ...(parsed.nonce ? { nonce: parsed.nonce } : {}),
            });
          } else {
            send(ws, { type: "error", errors: [], message: parsed.error });
          }
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
