import { WORLD_NONCE_MAX } from "@sfab-bench/contract";

/** Enough for a nonce. `randomUUID` is secure-context only; this is not. */
export type NonceCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

function clampNonce(value: string): string {
  return value.length <= WORLD_NONCE_MAX
    ? value
    : value.slice(0, WORLD_NONCE_MAX);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * A play/pause nonce. `crypto.randomUUID` throws or is missing on plain
 * http (a paired Quest on the LAN). `getRandomValues` is used then.
 */
export function worldCommandNonce(
  source: NonceCrypto | undefined = globalThis.crypto
): string {
  if (source && typeof source.randomUUID === "function") {
    try {
      const id = source.randomUUID();
      if (typeof id === "string" && id.length > 0) return clampNonce(id);
    } catch {
      /* insecure context */
    }
  }
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return clampNonce(hex(bytes));
}
