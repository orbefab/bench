/**
 * Stay / Break. Stay sends nothing. Break repeats the edit with
 * confirm "break". The lines are the server's ports and dependents.
 */

export type ConfirmPort = {
  name: string;
  dependents: string[];
};

export type ConfirmPrompt = {
  count: number;
  ports: ConfirmPort[];
  message: string;
};

export type ConfirmLine = {
  port: string;
  dependents: string;
};

export function confirmLines(prompt: ConfirmPrompt): ConfirmLine[] {
  return prompt.ports.map((port) => ({
    port: port.name,
    dependents:
      port.dependents.length > 0 ? port.dependents.join(", ") : "none",
  }));
}

/** The ask is for fixed ports unless the edit deletes a capture a parent uses. */
export function confirmTitle(ops: readonly { kind: string }[]): string {
  return ops.some((op) => op.kind === "remove-capture")
    ? "A parent uses this capture"
    : "This edit drops fixed ports";
}

export function confirmActions(prompt: ConfirmPrompt): {
  stay: "stay";
  breakLabel: string;
} {
  return { stay: "stay", breakLabel: `Break ${prompt.count}` };
}
