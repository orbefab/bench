import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";

import type { ClientPrincipal } from "@sfab-bench/contract";

import { lookupDevice } from "./pairing";

const als = new AsyncLocalStorage<ClientPrincipal>();

export function runWithPrincipal<T>(
  principal: ClientPrincipal,
  fn: () => T
): T {
  return als.run(principal, fn);
}

export function getPrincipal(): ClientPrincipal | undefined {
  return als.getStore();
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  return a === "127.0.0.1" || a === "::1";
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}

function queryToken(req: IncomingMessage): string | null {
  const raw = req.url ?? "";
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
  if (!q) return null;
  try {
    return (
      new URL(q, "http://localhost").searchParams.get("token")?.trim() || null
    );
  } catch {
    return null;
  }
}

function principalFromToken(token: string | null): ClientPrincipal | null {
  if (!token) return null;
  const device = lookupDevice(token);
  if (!device) return null;
  return {
    kind: "paired",
    deviceId: device.id,
    label: device.label,
  };
}

/** Trust X-Forwarded-For only when the TCP peer is loopback (Vite proxy). */
export function forwardedClientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined
): string | undefined {
  if (isLoopbackAddress(peer) && forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return peer;
}

export function clientAddress(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const header =
    typeof forwarded === "string"
      ? forwarded
      : Array.isArray(forwarded)
        ? forwarded[0]
        : undefined;
  return forwardedClientAddress(req.socket.remoteAddress, header);
}

export function resolvePrincipal(req: IncomingMessage): ClientPrincipal | null {
  if (isLoopbackAddress(clientAddress(req))) return { kind: "loopback" };
  return principalFromToken(bearerToken(req));
}

/** WebSocket cannot set Authorization; allow ?token= on the upgrade only. */
export function resolveUpgradePrincipal(
  req: IncomingMessage
): ClientPrincipal | null {
  if (isLoopbackAddress(clientAddress(req))) return { kind: "loopback" };
  return principalFromToken(bearerToken(req) ?? queryToken(req));
}

export function publicPrincipal(principal: ClientPrincipal) {
  if (principal.kind === "loopback") return { kind: "loopback" as const };
  if (principal.kind === "paired") {
    return {
      kind: "paired" as const,
      deviceId: principal.deviceId,
      label: principal.label,
    };
  }
  return {
    kind: "account" as const,
    userId: principal.userId,
    deviceId: principal.deviceId,
  };
}
