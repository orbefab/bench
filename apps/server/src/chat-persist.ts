import type { UIMessage } from "ai";

function errorPart(message: string) {
  return { type: "data-error" as const, data: { message } };
}

export function failedAssistant(errorText: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [errorPart(errorText)] as UIMessage["parts"],
  };
}

/** Attach a visible turn error so an empty or partial assistant is still persisted. */
export function withTurnError(
  assistant: UIMessage | undefined,
  errorText: string
): UIMessage {
  if (!assistant) return failedAssistant(errorText);
  const parts = assistant.parts ?? [];
  if (parts.some((part) => part.type === "data-error")) return assistant;
  return {
    ...assistant,
    parts: [...parts, errorPart(errorText)] as UIMessage["parts"],
  };
}

/**
 * A fill continues the assistant message already in `sent`. A prompt appends
 * a new one. Replacing keeps that message's id, so a reload does not show
 * the tool call twice.
 */
export function mergePersistedTurn(
  sent: UIMessage[],
  response: UIMessage | undefined,
  isContinuation: boolean
): UIMessage[] {
  if (!response || (response.parts ?? []).length === 0) return sent;
  const last = sent.at(-1);
  const continues =
    last?.role === "assistant" && (isContinuation || last.id === response.id);
  if (!continues || !last) return [...sent, response];
  return [...sent.slice(0, -1), { ...response, id: last.id }];
}

/** Abort and stream errors often yield an assistant with `parts: []`. Do not persist that placeholder. */
export function messagesToPersist(
  live: UIMessage[],
  assistant: UIMessage | undefined
): UIMessage[] {
  if (!assistant || (assistant.parts ?? []).length === 0) return live;
  return [...live, assistant];
}
