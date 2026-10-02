export const HARNESS_IDS = [
  "opencode",
  "codex",
  "cursor",
  "grok-build",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/** What a probe can say about a harness. Server and web read the same list. */
export const HARNESS_STATUSES = [
  "ready",
  "missing-cli",
  "needs-auth",
  "error",
] as const;

export type HarnessStatus = (typeof HARNESS_STATUSES)[number];

export type HarnessModel = {
  id: string;
  name: string;
  slug: string;
  group?: string;
};

/** One row of `GET /api/harnesses`. */
export type HarnessInfo = {
  id: HarnessId;
  label: string;
  status: HarnessStatus;
  detail?: string;
  defaultModel: string;
  models: HarnessModel[];
  bridgeReady: boolean;
};

export const HARNESS_LABEL: Record<HarnessId, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
  "grok-build": "Grok",
};

export const DEFAULT_HARNESS: HarnessId = "opencode";

/** Intersection of OpenCode / Codex / Grok reasoning knobs. Cursor has none. */
export const CHAT_EFFORTS = ["default", "low", "medium", "high"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export const DEFAULT_CHAT_EFFORT: ChatEffort = "default";

export const CHAT_EFFORT_LABEL: Record<ChatEffort, string> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function isChatEffort(value: string): value is ChatEffort {
  return (CHAT_EFFORTS as readonly string[]).includes(value);
}

export function harnessSupportsEffort(id: HarnessId) {
  return id !== "cursor";
}

export const DEFAULT_HARNESS_MODEL: Record<HarnessId, string> = {
  opencode: "zai-coding-plan/glm-5.3-flash",
  codex: "gpt-5.5",
  cursor: "composer-2.5",
  "grok-build": "grok-4.6",
};

export const STATIC_HARNESS_MODELS: Record<
  Exclude<HarnessId, "opencode">,
  { id: string; name: string }[]
> = {
  codex: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
  // Base ids only. `@ai-sdk/harness-cursor` hardcodes
  // `parameterizedModelPicker: true`, so Cursor matches the name strictly and
  // rejects a variant like `claude-4.6-sonnet-medium` from
  // `session/set_config_option` with `-32602` — and puts the reason in
  // `error.data`, so the turn dies on a bare "Invalid params". Effort is a
  // separate knob there, which is why `harnessSupportsEffort` excludes cursor.
  // Do not verify one of these with `cursor-agent -p`: that path uses a lenient
  // resolver that normalises variant strings, and will accept ids ACP refuses.
  cursor: [
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "grok-4.6", name: "Grok 4.6" },
  ],
  "grok-build": [
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "grok-code", name: "Grok Code" },
  ],
};
