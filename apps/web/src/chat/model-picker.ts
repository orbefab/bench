import { type HarnessId, isHarnessId } from "@sfab-bench/contract";

export const HARNESS_REFETCH_THROTTLE_MS = 10_000;
export const MODEL_FAVORITES_KEY = "sfab-bench.model-favorites";
export const MAX_MODEL_FAVORITES = 24;
export const EFFORT_TRIGGER_TITLE =
  "Reasoning effort — how much the model thinks before answering";

export type HarnessRefreshReason = "mount" | "open" | "focus" | "retry";

export type PickerModel = {
  id: string;
  name: string;
  slug: string;
  group?: string;
  unavailable?: boolean;
};

export type ModelFavorite = {
  harness: HarnessId;
  model: string;
};

export type PickerModelGroup = {
  group: string;
  models: PickerModel[];
};

/** First backticked span in a harness `detail` string (`codex login`). */
export function loginCommandFromStatus(input: {
  status: string;
  detail?: string;
}): string | null {
  if (input.status !== "needs-auth" && input.status !== "missing-cli")
    return null;
  const match = input.detail?.match(/`([^`]+)`/);
  const command = match?.[1]?.trim();
  return command || null;
}

/** Drop the `Run \`cmd\` on the Mac` clause; keep env-var alternatives, never values. */
export function loginDetailSecondary(
  detail: string | undefined,
  command: string | null
): string | null {
  if (!detail?.trim()) return null;
  let rest = detail.trim();
  if (command) {
    const tick = `\`${command}\``;
    const at = rest.indexOf(tick);
    if (at >= 0) rest = rest.slice(at + tick.length);
  }
  rest = rest.replace(/^[\s,.]*(?:on the Mac)?[\s,.]*/i, "").trim();
  return rest || null;
}

export function loginHintCopy(input: {
  label: string;
  status: string;
  detail?: string;
}): {
  headline: string;
  command: string | null;
  secondary: string | null;
} {
  const command = loginCommandFromStatus(input);
  const secondary = loginDetailSecondary(input.detail, command);
  if (input.status === "needs-auth") {
    return {
      headline: command
        ? `${input.label} isn't signed in. Run this on the Mac, then check again.`
        : `${input.label} isn't signed in.`,
      command,
      secondary,
    };
  }
  if (input.status === "missing-cli") {
    return {
      headline: command
        ? `${input.label} CLI isn't installed. Run this on the Mac, then check again.`
        : input.detail?.trim() ||
          `${input.label} CLI isn't installed. Install it on the Mac, then check again.`,
      command,
      secondary: command ? secondary : null,
    };
  }
  return {
    headline: input.detail?.trim() || `${input.label} is not ready`,
    command,
    secondary: command ? secondary : null,
  };
}

/** Ignore a catalog response whose folder is no longer the tab's `?project=`. */
export function shouldAcceptHarnessCatalog(
  requestProject: string,
  currentProject: string
): boolean {
  return requestProject.length > 0 && requestProject === currentProject;
}

export function providerLoginSendReason(input: {
  label: string;
  status: string;
  detail?: string;
}): string {
  const command = loginCommandFromStatus(input);
  if (input.status === "needs-auth") {
    return command
      ? `${input.label} isn't signed in — run \`${command}\``
      : `${input.label} isn't signed in`;
  }
  if (input.status === "missing-cli") {
    if (command)
      return `${input.label} CLI isn't installed — run \`${command}\``;
    return input.detail?.trim() || `${input.label} CLI isn't installed`;
  }
  return input.detail?.trim() || `${input.label} is not ready`;
}

export function decideHarnessRefetch(input: {
  reason: HarnessRefreshReason;
  now: number;
  lastStartedAt: number | null;
  inflight?: boolean;
  throttleMs?: number;
}): "fetch" | "reuse-inflight" | "skip" {
  if (input.inflight) return "reuse-inflight";
  if (input.reason === "focus") {
    const throttle = input.throttleMs ?? HARNESS_REFETCH_THROTTLE_MS;
    if (
      input.lastStartedAt != null &&
      input.now - input.lastStartedAt < throttle
    )
      return "skip";
  }
  return "fetch";
}

export function applyHarnessFetchResult<T>(input: {
  ok: boolean;
  list?: readonly T[];
  lastGood: readonly T[] | null;
}): { list: T[]; error: boolean } {
  if (input.ok && Array.isArray(input.list))
    return { list: [...input.list], error: false };
  if (input.lastGood) return { list: [...input.lastGood], error: false };
  return { list: [], error: true };
}

export function modelShortLabel(slug: string, name?: string): string {
  if (name && name.trim()) return name.trim();
  const i = slug.lastIndexOf("/");
  return i >= 0 ? slug.slice(i + 1) : slug;
}

export function modelDisplayName(model: PickerModel): string {
  const base = modelShortLabel(model.slug, model.name);
  return model.unavailable ? `${base} (unavailable)` : base;
}

export function mergeUnavailableSelection(
  models: readonly PickerModel[],
  selectedSlug: string | null | undefined
): PickerModel[] {
  const list = models.map((model) => ({ ...model }));
  if (!selectedSlug) return list;
  if (list.some((model) => model.slug === selectedSlug)) return list;
  return [
    ...list,
    {
      id: selectedSlug,
      name: modelShortLabel(selectedSlug),
      slug: selectedSlug,
      unavailable: true,
    },
  ];
}

export function pickerTriggerLabel(input: {
  harnessLabel: string;
  model: PickerModel | null;
  slug: string;
}): string {
  const modelName = input.model
    ? modelDisplayName(input.model)
    : `${modelShortLabel(input.slug)} (unavailable)`;
  return `Model: ${input.harnessLabel} · ${modelName}`;
}

export function favoriteKey(harness: HarnessId, model: string): string {
  return `${harness}:${model}`;
}

export function readModelFavorites(raw: string | null): ModelFavorite[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ModelFavorite[] = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const rec = row as { harness?: unknown; model?: unknown };
      if (
        !isHarnessId(String(rec.harness ?? "")) ||
        typeof rec.model !== "string" ||
        !rec.model
      )
        continue;
      const harness = rec.harness as HarnessId;
      const key = favoriteKey(harness, rec.model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ harness, model: rec.model });
      if (out.length >= MAX_MODEL_FAVORITES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeModelFavorites(
  favorites: readonly ModelFavorite[]
): string {
  return JSON.stringify(favorites.slice(0, MAX_MODEL_FAVORITES));
}

export function toggleModelFavorite(
  favorites: readonly ModelFavorite[],
  harness: HarnessId,
  model: string,
  max = MAX_MODEL_FAVORITES
): ModelFavorite[] {
  const key = favoriteKey(harness, model);
  const exists = favorites.some(
    (row) => favoriteKey(row.harness, row.model) === key
  );
  if (exists)
    return favorites.filter(
      (row) => favoriteKey(row.harness, row.model) !== key
    );
  return [
    { harness, model },
    ...favorites.filter((row) => favoriteKey(row.harness, row.model) !== key),
  ].slice(0, max);
}

export function isModelFavorite(
  favorites: readonly ModelFavorite[],
  harness: HarnessId,
  model: string
): boolean {
  const key = favoriteKey(harness, model);
  return favorites.some((row) => favoriteKey(row.harness, row.model) === key);
}

function modelMatchesQuery(model: PickerModel, query: string): boolean {
  if (!query) return true;
  return (
    model.name.toLowerCase().includes(query) ||
    model.slug.toLowerCase().includes(query) ||
    (model.group ?? "").toLowerCase().includes(query)
  );
}

/** Favorites (this harness, user order) then remaining catalog groups. */
export function groupPickerModels(input: {
  models: readonly PickerModel[];
  query: string;
  favoriteSlugs: readonly string[];
  defaultGroup: string;
}): PickerModelGroup[] {
  const q = input.query.trim().toLowerCase();
  const favoriteSet = new Set(input.favoriteSlugs);
  const matched = input.models.filter((model) => modelMatchesQuery(model, q));
  const groups: PickerModelGroup[] = [];
  const favorites = input.favoriteSlugs.flatMap((slug) => {
    const hit = matched.find((model) => model.slug === slug);
    return hit ? [hit] : [];
  });
  if (favorites.length > 0)
    groups.push({ group: "Favorites", models: favorites });
  const byGroup = new Map<string, PickerModel[]>();
  for (const model of matched) {
    if (favoriteSet.has(model.slug)) continue;
    const key = model.group ?? input.defaultGroup;
    const list = byGroup.get(key) ?? [];
    list.push(model);
    byGroup.set(key, list);
  }
  for (const [group, models] of byGroup) groups.push({ group, models });
  return groups;
}

export function harnessStatusTitle(label: string, status: string): string {
  if (status === "ready") return `${label} is ready`;
  if (status === "needs-auth") return `${label} needs login`;
  if (status === "missing-cli") return `${label} CLI is missing`;
  if (status === "error") return `${label} error`;
  return label;
}
