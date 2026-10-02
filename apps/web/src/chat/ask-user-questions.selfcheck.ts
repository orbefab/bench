import { ok as expect } from "node:assert/strict";
import {
  askUserComposerPlaceholder,
  buildAskUserQuestionsOutput,
  findPendingAskUserQuestions,
  formatAskUserAnswer,
  parseAskUserQuestionsInput,
} from "./ask-user-questions";

const parsed = parseAskUserQuestionsInput({
  allowPartialAnswers: true,
  questions: [
    {
      id: "question-1",
      header: "Viewer check",
      question: "Is the nut visible in the viewer?",
      options: [
        { id: "option-1", label: "Yes, nut is visible" },
        { id: "option-2", label: "Still empty" },
        { id: "option-3", label: "Tab points elsewhere" },
      ],
    },
  ],
});
expect(parsed !== null, "parses OpenCode question payload");
expect(parsed?.questions[0]?.header === "Viewer check", "keeps header");
expect(parsed?.questions[0]?.options.length === 3, "keeps three options");
expect(
  parsed?.questions[0]?.allowFreeForm === false,
  "options-only is not freeform"
);
expect(
  askUserComposerPlaceholder(parsed?.questions[0]) ===
    "Pick an option to continue…",
  "options-only placeholder"
);

const output = buildAskUserQuestionsOutput({
  "question-1": { optionIds: ["option-1"] },
});
expect(output.action === "answered", "answered action");
expect(output.answers["question-1"]?.optionIds[0] === "option-1", "option id");
expect(
  formatAskUserAnswer(parsed!, output) === "Yes, nut is visible",
  `summary, got ${formatAskUserAnswer(parsed!, output)}`
);

const both = parseAskUserQuestionsInput({
  questions: [
    {
      id: "q1",
      question: "Material?",
      allowFreeForm: true,
      options: [{ id: "steel", label: "Steel" }],
    },
  ],
});
expect(both?.questions[0]?.allowFreeForm === true, "parses allowFreeForm");
expect(
  askUserComposerPlaceholder(both?.questions[0]) ===
    "Type an answer or pick an option…",
  "both placeholder"
);

const typed = parseAskUserQuestionsInput({
  questions: [{ id: "q1", question: "Anything else?", allowFreeForm: true }],
});
expect(
  typed?.questions[0]?.options.length === 0,
  "freeform-only has no options"
);
expect(typed?.questions[0]?.allowFreeForm === true, "freeform-only");
expect(
  formatAskUserAnswer(typed!, {
    action: "answered",
    answers: { q1: { optionIds: [], freeform: "Use 316 stainless" } },
  }) === "Use 316 stainless",
  "formats freeform"
);

expect(
  parseAskUserQuestionsInput({
    questions: [{ question: "No way to answer" }],
  }) === null,
  "rejects empty options without freeform"
);

const pending = findPendingAskUserQuestions([
  {
    role: "assistant",
    parts: [
      {
        type: "tool-askUserQuestions",
        toolCallId: "call-1",
        state: "input-available",
        input: parsed,
      },
    ],
  },
]);
expect(pending?.toolCallId === "call-1", "finds pending askUserQuestions");

const answered = findPendingAskUserQuestions([
  {
    role: "assistant",
    parts: [
      {
        type: "tool-askUserQuestions",
        toolCallId: "call-1",
        state: "output-available",
        input: parsed,
        output,
      },
    ],
  },
]);
expect(answered === null, "answered tool is not pending");

console.log("ask-user-questions.selfcheck ok");
