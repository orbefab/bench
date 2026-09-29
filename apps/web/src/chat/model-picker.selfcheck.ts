import { ok as expect } from "node:assert/strict";
import {
  applyHarnessFetchResult,
  decideHarnessRefetch,
  groupPickerModels,
  HARNESS_REFETCH_THROTTLE_MS,
  loginCommandFromStatus,
  loginHintCopy,
  MAX_MODEL_FAVORITES,
  mergeUnavailableSelection,
  modelDisplayName,
  pickerTriggerLabel,
  providerLoginSendReason,
  readModelFavorites,
  serializeModelFavorites,
  shouldAcceptHarnessCatalog,
  toggleModelFavorite,
} from "./model-picker";

expect(
  loginCommandFromStatus({
    status: "needs-auth",
    detail: "Run `codex login` on the Mac, or set OPENAI_API_KEY.",
  }) === "codex login",
  "codex detail backtick"
);
expect(
  loginCommandFromStatus({
    status: "needs-auth",
    detail: "A Mac Cursor login is not visible to this app.",
  }) === null,
  "cursor detail has no runnable command"
);
expect(
  loginCommandFromStatus({
    status: "needs-auth",
    detail: "Run `grok login` on the Mac, or set XAI_API_KEY.",
  }) === "grok login",
  "grok detail backtick"
);
expect(
  loginCommandFromStatus({
    status: "missing-cli",
    detail: "OpenCode is not connected. Install the CLI.",
  }) === null,
  "opencode missing-cli has no command"
);
expect(
  loginCommandFromStatus({ status: "ready", detail: "Run `codex login`." }) ===
    null,
  "ready has no command"
);
expect(
  loginCommandFromStatus({ status: "needs-auth" }) === null,
  "needs-auth without detail"
);
expect(
  loginCommandFromStatus({
    status: "needs-auth",
    detail: "Run `codex login`, not `rm -rf`.",
  }) === "codex login",
  "first backtick span only"
);

const codexHint = loginHintCopy({
  label: "Codex",
  status: "needs-auth",
  detail: "Run `codex login` on the Mac, or set OPENAI_API_KEY.",
});
expect(
  codexHint.headline ===
    "Codex isn't signed in. Run this on the Mac, then check again.",
  "needs-auth headline"
);
expect(codexHint.command === "codex login", "needs-auth command");
expect(
  codexHint.secondary === "or set OPENAI_API_KEY.",
  "needs-auth keeps env alternative"
);

const cursorHint = loginHintCopy({
  label: "Cursor",
  status: "needs-auth",
  detail: "A Mac Cursor login is not visible to this app.",
});
expect(cursorHint.command === null, "cursor has no login command");
expect(
  cursorHint.headline === "Cursor isn't signed in.",
  "cursor headline without run-this"
);
expect(
  cursorHint.secondary === "A Mac Cursor login is not visible to this app.",
  "cursor keeps the honest detail"
);

const grokHint = loginHintCopy({
  label: "Grok",
  status: "needs-auth",
  detail: "Run `grok login` on the Mac, or set XAI_API_KEY.",
});
expect(grokHint.secondary === "or set XAI_API_KEY.", "grok env alternative");

const missingHint = loginHintCopy({
  label: "OpenCode",
  status: "missing-cli",
  detail: "OpenCode is not connected. Install the CLI.",
});
expect(missingHint.command === null, "missing-cli without backtick");
expect(
  missingHint.headline === "OpenCode is not connected. Install the CLI.",
  "missing-cli uses server detail"
);
expect(
  missingHint.secondary === null,
  "missing-cli without command has no remainder"
);

expect(
  shouldAcceptHarnessCatalog("/abs/a", "/abs/a"),
  "same folder is current"
);
expect(
  shouldAcceptHarnessCatalog("/abs/a", "/abs/b") === false,
  "folder A must not land on B"
);
expect(
  shouldAcceptHarnessCatalog("", "/abs/b") === false,
  "empty request is stale"
);
expect(
  shouldAcceptHarnessCatalog("/abs/a", "") === false,
  "empty tab is stale"
);

expect(
  providerLoginSendReason({
    label: "Codex",
    status: "needs-auth",
    detail: "Run `codex login` on the Mac, or set OPENAI_API_KEY.",
  }) === "Codex isn't signed in — run `codex login`",
  "needs-auth send copy"
);
expect(
  providerLoginSendReason({
    label: "Cursor",
    status: "needs-auth",
    detail: "A Mac Cursor login is not visible to this app.",
  }) === "Cursor isn't signed in",
  "cursor send copy has no fake login command"
);
expect(
  providerLoginSendReason({
    label: "OpenCode",
    status: "missing-cli",
    detail: "OpenCode is not connected. Install the CLI.",
  }) === "OpenCode is not connected. Install the CLI.",
  "missing-cli keeps server detail when no command"
);

expect(
  decideHarnessRefetch({
    reason: "open",
    now: 20_000,
    lastStartedAt: 19_000,
  }) === "fetch",
  "open always fetches"
);
expect(
  decideHarnessRefetch({
    reason: "retry",
    now: 20_000,
    lastStartedAt: 19_000,
  }) === "fetch",
  "check-again always fetches"
);
expect(
  decideHarnessRefetch({
    reason: "focus",
    now: 20_000,
    lastStartedAt: 15_000,
  }) === "skip",
  "focus inside 10s skips"
);
expect(
  decideHarnessRefetch({
    reason: "focus",
    now: 25_000,
    lastStartedAt: 15_000,
  }) === "fetch",
  "focus after 10s fetches"
);
expect(
  decideHarnessRefetch({ reason: "focus", now: 100, lastStartedAt: null }) ===
    "fetch",
  "first focus fetches"
);
expect(
  decideHarnessRefetch({
    reason: "open",
    now: 20_000,
    lastStartedAt: 19_000,
    inflight: true,
  }) === "reuse-inflight",
  "concurrent open joins inflight"
);
expect(
  decideHarnessRefetch({
    reason: "focus",
    now: 20_000,
    lastStartedAt: 19_000,
    throttleMs: HARNESS_REFETCH_THROTTLE_MS,
  }) === "skip",
  "default throttle is 10s"
);

expect(
  JSON.stringify(
    applyHarnessFetchResult({ ok: true, list: [1], lastGood: [0] })
  ) === JSON.stringify({ list: [1], error: false }),
  "ok fetch replaces last good"
);
expect(
  JSON.stringify(applyHarnessFetchResult({ ok: false, lastGood: [0] })) ===
    JSON.stringify({ list: [0], error: false }),
  "failed fetch keeps last good"
);
expect(
  JSON.stringify(applyHarnessFetchResult({ ok: false, lastGood: null })) ===
    JSON.stringify({ list: [], error: true }),
  "failed fetch with no catalog is an error"
);

const catalog = [
  {
    id: "opencode/big-pickle",
    name: "Big Pickle",
    slug: "opencode/big-pickle",
    group: "OPENCODE",
  },
  {
    id: "opencode/other",
    name: "Other",
    slug: "opencode/other",
    group: "OPENCODE",
  },
];
const withUnavailable = mergeUnavailableSelection(
  catalog,
  "zai-coding-plan/glm-5.3-flash"
);
expect(withUnavailable.length === 3, "unavailable selected slug is appended");
expect(withUnavailable[2]?.unavailable === true, "appended row is unavailable");
expect(
  withUnavailable[2]?.slug === "zai-coding-plan/glm-5.3-flash",
  "appended slug is kept"
);
expect(
  modelDisplayName(withUnavailable[2]!) === "glm-5.3-flash (unavailable)",
  "unavailable display"
);
expect(
  mergeUnavailableSelection(catalog, "opencode/big-pickle").length === 2,
  "catalog hit is not duplicated"
);
expect(
  mergeUnavailableSelection(catalog, null).length === 2,
  "no selection leaves catalog"
);
expect(
  pickerTriggerLabel({
    harnessLabel: "OpenCode",
    model: withUnavailable[2]!,
    slug: "zai-coding-plan/glm-5.3-flash",
  }) === "Model: OpenCode · glm-5.3-flash (unavailable)",
  "trigger aria includes harness and unavailable"
);

const empty = readModelFavorites(null);
expect(empty.length === 0, "empty favorites");
expect(readModelFavorites("not-json").length === 0, "invalid json");
expect(
  readModelFavorites('{"model":"x"}').length === 0,
  "object is not a list"
);
expect(
  readModelFavorites('[{"harness":"nope","model":"gpt"}]').length === 0,
  "unknown harness dropped"
);

let favs = toggleModelFavorite([], "codex", "gpt-5.5");
expect(favs.length === 1 && favs[0]?.model === "gpt-5.5", "star prepends");
favs = toggleModelFavorite(favs, "opencode", "opencode/big-pickle");
expect(
  favs[0]?.harness === "opencode" && favs[1]?.model === "gpt-5.5",
  "new star goes first"
);
favs = toggleModelFavorite(favs, "codex", "gpt-5.5");
expect(favs.length === 1 && favs[0]?.harness === "opencode", "unstar removes");
expect(
  readModelFavorites(serializeModelFavorites(favs)).length === 1,
  "roundtrip"
);

const overflow = Array.from({ length: MAX_MODEL_FAVORITES }, (_, i) => ({
  harness: "codex" as const,
  model: `m${i}`,
}));
const bounded = toggleModelFavorite(overflow, "cursor", "gpt-5.6-luna");
expect(bounded.length === MAX_MODEL_FAVORITES, "favorites stay bounded");
expect(bounded[0]?.model === "gpt-5.6-luna", "newest favorite kept");
expect(
  bounded.some((row) => row.model === "m23") === false,
  "oldest favorite dropped"
);

const grouped = groupPickerModels({
  models: [
    { id: "a", name: "Alpha", slug: "a", group: "OPENCODE" },
    { id: "b", name: "Beta", slug: "b", group: "OPENCODE" },
    { id: "c", name: "Gamma", slug: "c", group: "OTHER" },
  ],
  query: "",
  favoriteSlugs: ["c", "a"],
  defaultGroup: "OpenCode",
});
expect(grouped[0]?.group === "Favorites", "favorites section first");
expect(
  grouped[0]?.models.map((m) => m.slug).join(",") === "c,a",
  "favorite order preserved"
);
expect(
  grouped[1]?.group === "OPENCODE" && grouped[1]?.models[0]?.slug === "b",
  "rest stay grouped"
);
expect(
  grouped.some(
    (g) => g.models.some((m) => m.slug === "a") && g.group !== "Favorites"
  ) === false,
  "no dup rows"
);

const searched = groupPickerModels({
  models: catalog,
  query: "pickle",
  favoriteSlugs: ["opencode/big-pickle", "opencode/other"],
  defaultGroup: "OpenCode",
});
expect(
  searched[0]?.models.length === 1 &&
    searched[0]?.models[0]?.slug === "opencode/big-pickle",
  "search filters favorites"
);
expect(searched.length === 1, "non-matching rest omitted");

console.log("model-picker.selfcheck ok");
