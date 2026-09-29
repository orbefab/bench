/** Which recipe captures a part's axis, and which level takes the result. */
import type {
  CaptureAxisName,
  CaptureRecipe,
  PartFile,
} from "@sfab-bench/contract";
import type { Store } from "@sfab-bench/parts";

import type { HingeCaptureEntry } from "./body/hinge-capture";
import type { AnyCaptureEntry, CaptureEntry, CaptureFile } from "./capture";

export type CaptureAxis = CaptureAxisName;

export type CaptureRecipeSource = {
  catalogDir: string;
  store: Store;
  join(...parts: string[]): string;
};

function axisOf(entry: AnyCaptureEntry | CaptureRecipe): CaptureAxis {
  return "form" in entry ? "body" : "behaviour";
}

function entryOf(id: string, recipe: CaptureRecipe): AnyCaptureEntry {
  return { id, part: id, ...recipe };
}

/**
 * The part document's own recipe wins; else the catalog entry for this
 * part id. A hinge entry is the body axis, every other entry behaviour;
 * a recipe filed under the other axis is ignored.
 */
export function captureRecipeFor(
  part: PartFile,
  axis: "behaviour",
  source: CaptureRecipeSource
): CaptureEntry | null;
export function captureRecipeFor(
  part: PartFile,
  axis: "body",
  source: CaptureRecipeSource
): HingeCaptureEntry | null;
export function captureRecipeFor(
  part: PartFile,
  axis: CaptureAxis,
  source: CaptureRecipeSource
): AnyCaptureEntry | null;
export function captureRecipeFor(
  part: PartFile,
  axis: CaptureAxis,
  source: CaptureRecipeSource
): AnyCaptureEntry | null {
  const own = part.capture?.[axis];
  if (own && axisOf(own) === axis) return entryOf(part.id, own);
  const file = source.join(
    source.catalogDir,
    "fixtures",
    "capture.config.json"
  );
  if (!source.store.exists(file)) return null;
  const config = JSON.parse(
    source.store.readText(file)
  ) as CaptureFile<AnyCaptureEntry>;
  const entry = config.entries.find(
    (row) => row.part === part.id && axisOf(row) === axis
  );
  return entry ?? null;
}

/** The level that takes the new variant, or why there is none. */
export function captureLevelFor(
  part: PartFile,
  axis: CaptureAxis,
  recipe: { into?: string }
): { level: string } | { error: string } {
  const slots = part.axes?.[axis] ?? {};
  if (recipe.into !== undefined) {
    if (!slots[recipe.into as "0"]) {
      return {
        error: `${part.id} has no ${axis} level ${recipe.into} to capture into`,
      };
    }
    return { level: recipe.into };
  }
  const holders = Object.entries(slots)
    .filter(([, slot]) =>
      Object.values(slot?.variants ?? {}).some(
        (variant) => (variant as { kind?: string }).kind === "snapshot"
      )
    )
    .map(([level]) => level)
    .sort();
  const first = holders[0];
  if (first === undefined) {
    return {
      error: `${part.id} has no ${axis} level that holds a snapshot; name one with "into" in the capture recipe`,
    };
  }
  return { level: first };
}
