export type ChatDock = "popup" | "docked";

/** Unknown stored values stay on the popup composer. */
export function chatDockMode(value: unknown): ChatDock {
  return value === "docked" ? "docked" : "popup";
}
