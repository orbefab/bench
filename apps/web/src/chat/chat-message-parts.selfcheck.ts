import { ok as expect } from "node:assert/strict";
import {
  messageCopyVisible,
  splitChatWorkedParts,
} from "../components/chat/chat-message-parts";

function kinds(parts: Array<{ type: string; toolName?: string }>) {
  return splitChatWorkedParts(parts).map((segment) => {
    if (segment.kind === "worked")
      return `worked:${segment.items.map((item) => item.part.type).join(",")}`;
    return `visible:${segment.item.part.type}`;
  });
}

const simple = kinds([
  { type: "reasoning" },
  { type: "dynamic-tool" },
  { type: "text" },
]);
expect(simple.length === 2, "simple-ai mock stays one fold plus answer");
expect(
  simple[0] === "worked:reasoning,dynamic-tool",
  `simple fold, got ${simple[0]}`
);
expect(simple[1] === "visible:text", "answer stays visible");

const harness = kinds([
  { type: "step-start" },
  { type: "reasoning" },
  { type: "tool-bash" },
  { type: "step-start" },
  { type: "reasoning" },
  { type: "tool-read" },
  { type: "step-start" },
  { type: "text" },
]);
expect(
  harness.length === 2,
  `harness steps collapse to one fold, got ${harness.length}: ${harness.join(" | ")}`
);
expect(
  harness[0] === "worked:reasoning,tool-bash,reasoning,tool-read",
  `merged work, got ${harness[0]}`
);
expect(harness[1] === "visible:text", "harness answer stays visible");

const finish = kinds([
  { type: "reasoning" },
  { type: "step-finish" },
  { type: "tool-bash" },
  { type: "text" },
]);
expect(
  finish.join("|") === "worked:reasoning,tool-bash|visible:text",
  `step-finish does not split a fold, got ${finish.join("|")}`
);

const trailing = kinds([
  { type: "reasoning" },
  { type: "text" },
  { type: "step-start" },
  { type: "tool-bash" },
]);
expect(
  trailing.join("|") === "worked:reasoning|visible:text|visible:tool-bash",
  `trailing tools stay outside, got ${trailing.join("|")}`
);

const ask = kinds([
  { type: "reasoning" },
  { type: "tool-bash" },
  { type: "tool-askUserQuestions" },
]);
expect(
  ask.join("|") === "worked:reasoning,tool-bash|visible:tool-askUserQuestions",
  `ask-user stays outside the fold, got ${ask.join("|")}`
);

const askDynamic = kinds([
  { type: "dynamic-tool", toolName: "askUserQuestions" },
]);
expect(
  askDynamic[0] === "visible:dynamic-tool",
  `dynamic ask-user stays visible, got ${askDynamic[0]}`
);

const errorRow = kinds([{ type: "reasoning" }, { type: "data-error" }]);
expect(
  errorRow.join("|") === "worked:reasoning|visible:data-error",
  `turn error stays outside the fold, got ${errorRow.join("|")}`
);

const turnState = kinds([
  { type: "reasoning" },
  { type: "text" },
  { type: "data-turn" },
]);
expect(
  turnState.join("|") === "worked:reasoning|visible:text",
  `data-turn is structural, got ${turnState.join("|")}`
);

expect(messageCopyVisible(false, "hi") === true, "copy after the turn");
expect(messageCopyVisible(true, "hi") === false, "no copy while streaming");
expect(messageCopyVisible(false, "") === false, "no copy without text");

console.log("chat-message-parts.selfcheck ok");
