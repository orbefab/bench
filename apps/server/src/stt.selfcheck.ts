import { ok as expect } from "node:assert/strict";
import { resolveSttApiKey } from "./stt";

const stored = resolveSttApiKey("settings-key", {});
expect(
  stored.source === "settings" && stored.key === "settings-key",
  "settings wins"
);

const envNamed = resolveSttApiKey(null, { STT_AI_GATEWAY_API_KEY: "stt-env" });
expect(
  envNamed.source === "env" && envNamed.key === "stt-env",
  "STT_AI_GATEWAY_API_KEY"
);

const settingsOverEnv = resolveSttApiKey("from-ui", {
  STT_AI_GATEWAY_API_KEY: "stt-env",
});
expect(settingsOverEnv.key === "from-ui", "settings overrides env");

const legacy = resolveSttApiKey(null, { AI_GATEWAY_API_KEY: "legacy" });
expect(
  legacy.source === "env" && legacy.key === "legacy",
  "legacy AI_GATEWAY_API_KEY still transcribes"
);

const namedBeatsLegacy = resolveSttApiKey(null, {
  STT_AI_GATEWAY_API_KEY: "stt-env",
  AI_GATEWAY_API_KEY: "legacy",
});
expect(
  namedBeatsLegacy.key === "stt-env",
  "named STT env beats legacy Gateway env"
);

const missing = resolveSttApiKey(null, {});
expect(missing.key === null && missing.source === null, "no key");

expect(
  resolveSttApiKey("  ", { STT_AI_GATEWAY_API_KEY: "  " }).key === null,
  "whitespace is empty"
);

console.log("stt.selfcheck ok");
