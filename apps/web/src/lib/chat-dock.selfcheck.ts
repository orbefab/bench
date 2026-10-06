import { ok as expect } from "node:assert/strict";

import { chatDockMode } from "./chat-dock";

expect(chatDockMode("docked") === "docked", "docked stays docked");
expect(chatDockMode("popup") === "popup", "popup stays popup");
expect(chatDockMode("side") === "popup", "an unknown mode is popup");
expect(chatDockMode(undefined) === "popup", "a missing mode is popup");

console.log("chat-dock.selfcheck ok");
