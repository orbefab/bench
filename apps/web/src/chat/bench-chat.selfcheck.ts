/**
 * The continue predicate must stay false for the cases
 * `lastAssistantMessageIsCompleteWithToolCalls` would submit.
 * Fill is an explicit `sendMessage()` after `addToolOutput` (ADR 0007).
 * Mapped error copy is covered by composer-recovery.selfcheck.ts.
 */
import { ok as expect } from "node:assert/strict";
import { harnessSendAutomaticallyWhen } from "./bench-chat";

function continues(messages: readonly { role?: string; parts?: unknown[] }[]) {
  return harnessSendAutomaticallyWhen({ messages });
}

expect(continues([]) === false, "empty thread does not auto-continue");

expect(
  continues([
    { role: "user", parts: [{ type: "text", text: "how tall is this?" }] },
  ]) === false,
  "a user prompt is sent by the composer, not the predicate"
);

expect(
  continues([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-show_artifact",
          toolCallId: "show-1",
          state: "output-available",
          input: { path: "cad/a.step" },
          output: { shown: "cad/a.step" },
        },
      ],
    },
  ]) === false,
  "a finished show_artifact does not auto-continue an idle turn"
);

expect(
  continues([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-get_viewer",
          toolCallId: "gv-1",
          state: "input-available",
          input: {},
        },
      ],
    },
  ]) === false,
  "a pending get_viewer waits for this tab"
);

expect(
  continues([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-get_viewer",
          toolCallId: "gv-1",
          state: "output-available",
          input: {},
          output: { selection: [] },
        },
      ],
    },
  ]) === false,
  "a filled get_viewer continues from sendMessage, not the predicate"
);

expect(
  continues([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-askUserQuestions",
          toolCallId: "ask-1",
          state: "output-available",
          input: { questions: [] },
          output: { action: "answered", answers: {} },
        },
      ],
    },
  ]) === false,
  "an answered ask-user continues from sendMessage, not the predicate"
);

console.log("bench-chat.selfcheck ok");
