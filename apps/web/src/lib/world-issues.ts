import type { WorldSender } from "@sfab-bench/contract";

/** A client-side load problem. `mesh` is the URDF filename when a mesh failed. */
export type AssetIssue = {
  text: string;
  mesh?: string;
};

/**
 * Validator errors already name a bad mesh. Hide the client load line for
 * that same path, and keep it when the server reported nothing.
 */
export function visibleAssetIssues(
  issues: readonly AssetIssue[],
  errors: readonly { message: string }[]
): AssetIssue[] {
  if (errors.length === 0) return [...issues];
  return issues.filter((issue) => {
    const text = issue.text.trim();
    if (text && errors.some((error) => error.message.includes(text))) {
      return false;
    }
    if (!issue.mesh) return true;
    const mesh = issue.mesh;
    return !errors.some((error) => error.message.includes(mesh));
  });
}

/** One row of the canvas error overlay. Hint is split out of the validator message. */
export type WorldIssueLine = {
  code: string;
  path: string;
  message: string;
  hint: string;
};

export function formatWorldIssues(
  errors: readonly { code: string; path: string; message: string }[],
  fallback?: string | null
): WorldIssueLine[] {
  if (errors.length === 0) {
    const message = fallback?.trim() ?? "";
    if (!message) return [];
    return [splitIssue("error", "", message)];
  }
  return errors.map((issue) =>
    splitIssue(issue.code, issue.path, issue.message)
  );
}

function splitIssue(code: string, path: string, raw: string): WorldIssueLine {
  const idx = raw.indexOf("Hint:");
  if (idx === -1) {
    return { code, path, message: raw.trim(), hint: "" };
  }
  return {
    code,
    path,
    message: raw.slice(0, idx).trim(),
    hint: raw.slice(idx + "Hint:".length).trim(),
  };
}

/** `12.345 s`. The desktop run readout. */
export function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0.000 s";
  return `${seconds.toFixed(3)} s`;
}

/** "Paused by Headset A", "Played by agent". */
export function commandNotice(
  command: "play" | "pause",
  by: WorldSender
): string {
  const who = by.kind === "agent" ? "agent" : by.label || "someone";
  return command === "play" ? `Played by ${who}` : `Paused by ${who}`;
}

/**
 * One headset line. Validator rows come first (`code: message`), then the
 * asset issues `visibleAssetIssues` kept. The count is both lists together.
 * The desktop card keeps each path and hint.
 */
export function formatXrIssueLine(
  errors: readonly { code: string; path: string; message: string }[],
  assets: readonly { text: string }[],
  fallback?: string | null
): string {
  const heads: string[] = [];
  for (const line of formatWorldIssues(errors, fallback)) {
    heads.push(line.code ? `${line.code}: ${line.message}` : line.message);
  }
  for (const asset of assets) {
    const text = asset.text.trim();
    if (text) heads.push(text);
  }
  const first = heads[0];
  if (!first) return "";
  const rest = heads.length - 1;
  return rest > 0 ? `${first} (+${rest} more)` : first;
}

/** Validator rows only. Asset issues go through `formatXrIssueLine`. */
export function formatXrErrorLine(
  errors: readonly { code: string; path: string; message: string }[],
  fallback?: string | null
): string {
  return formatXrIssueLine(errors, [], fallback);
}

/** True when this tab sent the nonce the server echoed. Agent commands have none. */
export function isOwnCommandNonce(
  nonce: string | undefined,
  sent: ReadonlySet<string>
): boolean {
  return nonce != null && sent.has(nonce);
}
