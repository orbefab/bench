import { ok as expect } from "node:assert/strict";
import {
  dropTrailingHarnessErrors,
  harnessErrorsAsTurnParts,
  harnessErrorText,
  isCompletedTurnFinish,
} from "./chat-stream";

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const part of stream) out.push(part);
  return out;
}

expect(isCompletedTurnFinish("stop"), "stop is a completed turn");
expect(isCompletedTurnFinish("length"), "length is a completed turn");
expect(isCompletedTurnFinish({ unified: "stop" }), "unified stop");
expect(!isCompletedTurnFinish("tool-calls"), "tool-calls is not done");
expect(!isCompletedTurnFinish("error"), "error finish is not a success");

const dropped = await collect(
  dropTrailingHarnessErrors(
    ReadableStream.from([
      { type: "text-delta", id: "a" },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "text-delta", id: "b" },
      { type: "finish-step", finishReason: "stop" },
      { type: "error", error: new Error("trailing") },
      { type: "finish", finishReason: "stop" },
    ])
  )
);
expect(
  dropped.map((p) => p.type).join(",") ===
    "text-delta,finish-step,text-delta,finish-step,finish",
  `trailing error dropped, got ${dropped.map((p) => p.type).join(",")}`
);

const kept = await collect(
  dropTrailingHarnessErrors(
    ReadableStream.from([
      { type: "text-delta", id: "a" },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "error", error: new Error("mid-turn") },
    ])
  )
);
expect(kept.at(-1)?.type === "error", "error after tool-calls is kept");

expect(
  harnessErrorText(new Error("Bootstrap command failed")) ===
    "Bootstrap command failed",
  "Error.message"
);
expect(harnessErrorText("plain") === "plain", "string error");
expect(
  harnessErrorText(
    new Error(
      '{"name":"UnknownError","data":{"message":"Model not found: x."}}'
    )
  ) === "Model not found: x.",
  "OpenCode JSON error payload"
);

const turned = await collect(
  harnessErrorsAsTurnParts(
    ReadableStream.from([
      { type: "start" },
      { type: "error", errorText: "Bootstrap command failed" },
    ])
  )
);
expect(turned[0]?.type === "start", "start kept");
expect(turned[1]?.type === "data-error", "error chunk becomes data-error");
expect(
  turned[1] &&
    "data" in turned[1] &&
    turned[1].data.message === "Bootstrap command failed",
  "error text is the part body"
);

console.log("chat-stream.selfcheck ok");
