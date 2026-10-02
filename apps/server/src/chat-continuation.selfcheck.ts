/**
 * Fill vs prompt is the last message role plus a live unfinished session,
 * not the AI SDK chatbot helper (that helper also matches completed
 * show_artifact and will continue an idle harness turn).
 */
import { ok as expect } from "node:assert/strict";
import type { UIMessage } from "ai";

import { admitChatTurn, isFillRequest, priorMessages } from "./chat";

const user: UIMessage = {
  id: "u",
  role: "user",
  parts: [{ type: "text", text: "hi" }],
};
const assistant = (parts: UIMessage["parts"]): UIMessage => ({
  id: "m1",
  role: "assistant",
  parts,
});

expect(!isFillRequest(user), "a user message is a prompt");
expect(
  isFillRequest(assistant([{ type: "text", text: "done" }])),
  "an assistant tail is a fill (server 409s if the session is idle)"
);
expect(
  isFillRequest(
    assistant([
      {
        type: "tool-show_artifact",
        toolCallId: "a",
        state: "output-available",
        input: { path: "cad/a.step" },
        output: { shown: "cad/a.step" },
      },
    ] as UIMessage["parts"])
  ),
  "a finished show_artifact is still a fill request, not an auto-continue"
);

expect(
  admitChatTurn({ lastRole: "user", liveUnfinished: false }) === "prompt",
  "user is always a prompt"
);
expect(
  admitChatTurn({ lastRole: "user", liveUnfinished: true }) === "prompt",
  "an unfinished session does not turn a user line into a fill"
);
expect(
  admitChatTurn({ lastRole: "assistant", liveUnfinished: true }) === "fill",
  "assistant + live unfinished session is a fill"
);
expect(
  admitChatTurn({ lastRole: "assistant", liveUnfinished: false }) === "reject",
  "assistant + idle/missing session is 409, not a harness continue"
);

const stamped: UIMessage = {
  id: "u",
  role: "user",
  parts: [{ type: "text", text: "now" }],
};
const history: UIMessage[] = [
  { id: "h", role: "user", parts: [{ type: "text", text: "earlier" }] },
  stamped,
];
const filled = priorMessages(true, history, stamped);
expect(filled === history, "fill returns body.messages");
const fresh = priorMessages(false, history, stamped);
expect(
  fresh.length === 1 && fresh[0] === stamped,
  "a prompt does not replay history"
);

console.log("chat-continuation.selfcheck ok");
