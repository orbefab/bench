import { ok as expect } from "node:assert/strict";
import {
  finishPersistMessages,
  messagesWithTurnError,
  shouldPersistMessages,
} from "./persist-thread";

const user = {
  id: "u",
  role: "user" as const,
  parts: [{ type: "text" as const, text: "PING" }],
};
const empty = { id: "a", role: "assistant" as const, parts: [] };
const text = {
  id: "a",
  role: "assistant" as const,
  parts: [{ type: "text" as const, text: "PING" }],
};

expect(shouldPersistMessages([user]), "user-only persist");
expect(!shouldPersistMessages([user, empty]), "empty assistant skipped");
expect(shouldPersistMessages([user, text]), "text assistant persisted");

const fromUser = messagesWithTurnError(
  [user] as { id: string; role: string; parts: unknown[] }[],
  "Bootstrap command failed"
);
expect(fromUser.length === 2, "error assistant appended to user-only");
expect(fromUser[1]?.role === "assistant", "error role");
expect(
  (fromUser[1]?.parts ?? []).some(
    (p) => (p as { type?: string }).type === "data-error"
  ),
  "error part"
);

const fromEmpty = messagesWithTurnError(
  [user, empty],
  "Bootstrap command failed"
);
expect(fromEmpty.length === 2, "reuse empty assistant");
expect(
  (fromEmpty[1]?.parts ?? []).length === 1,
  "error attached to empty assistant"
);

const skipWipe = finishPersistMessages([user], true, null);
expect(skipWipe === null, "error without text does not PUT user-only");

const skipEmpty = finishPersistMessages([user, empty], true, null);
expect(skipEmpty === null, "error without text does not PUT empty assistant");

const withText = finishPersistMessages(
  [user],
  true,
  "Bootstrap command failed"
);
expect(
  withText !== null && withText.length === 2,
  "error text becomes a persisted turn"
);

const midTurn = {
  id: "a",
  role: "assistant" as const,
  parts: [
    { type: "step-start" as const },
    { type: "reasoning" as const },
    { type: "tool-bash" as const },
  ],
};
const stamped = finishPersistMessages(
  [user, midTurn],
  true,
  "expected a user message or tool result"
);
expect(
  stamped !== null && stamped.length === 2,
  "mid-turn error keeps the assistant row"
);
expect(
  ((stamped?.[1]?.parts ?? []) as { type?: string }[]).some(
    (p) => p.type === "data-error"
  ),
  "mid-turn error stamps data-error onto the worked parts"
);

const ok = finishPersistMessages([user, text], false, null);
expect(ok !== null && ok.length === 2, "success persist unchanged");

console.log("persist-thread.selfcheck ok");
