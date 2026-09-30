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

/**
 * The dialog's sentence. Deleting a capture names it and the rules that use
 * it, and says where Break sends those parts; the server's own sentence is
 * worded for an agent that resends the edit. Fixed ports keep the server's.
 */
export function confirmBody(
  ops: readonly { kind: string; variant?: string }[],
  prompt: ConfirmPrompt
): string {
  const remove = ops.find((op) => op.kind === "remove-capture");
  if (!remove) return prompt.message;
  const rules = prompt.ports.flatMap((port) => port.dependents);
  const noun = rules.length === 1 ? "rule uses" : "rules use";
  const name = remove.variant ?? prompt.ports[0]?.name ?? "this capture";
  return `${name} is deleted from the part, but ${rules.length} ${noun} it: ${rules.join("; ")}. Break deletes it and sends those parts back to the level's default. Stay changes nothing.`;
}

export function confirmActions(prompt: ConfirmPrompt): {
  stay: "stay";
  breakLabel: string;
} {
  return { stay: "stay", breakLabel: `Break ${prompt.count}` };
}
