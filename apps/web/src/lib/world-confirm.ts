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

export function confirmActions(prompt: ConfirmPrompt): {
  stay: "stay";
  breakLabel: string;
} {
  return { stay: "stay", breakLabel: `Break ${prompt.count}` };
}
