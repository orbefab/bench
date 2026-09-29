/** Which recipe captures a part's axis, and which level takes the result. */
import type { PartFile } from "@sfab-bench/contract";
import type { Store } from "@sfab-bench/parts";

import type { CaptureEntry, CaptureFile } from "./capture";

export type CaptureAxis = "behaviour" | "body";

export type CaptureRecipeSource = {
  catalogDir: string;
  store: Store;
  join(...parts: string[]): string;
};

function isHinge(entry: { form?: string }): boolean {
  return entry.form === "hinge@1";
}

/**
 * The part document's own recipe wins; else the catalog entry for this
 * part id. A hinge entry is the body axis, every other entry behaviour.
 */
export function captureRecipeFor(
  part: PartFile,
  axis: CaptureAxis,
  source: CaptureRecipeSource
): CaptureEntry | null {
  const own = part.capture?.[axis];
  if (own) {
    return { id: part.id, part: part.id, ...own } as unknown as CaptureEntry;
  }
  const file = source.join(
    source.catalogDir,
    "fixtures",
    "capture.config.json"
  );
  if (!source.store.exists(file)) return null;
  const config = JSON.parse(source.store.readText(file)) as CaptureFile;
  const entry = config.entries.find(
    (row) =>
      row.part === part.id &&
      (isHinge(row as { form?: string }) ? "body" : "behaviour") === axis
  );
  return entry ?? null;
}

/** The level that takes the new variant, or why there is none. */
export function captureLevelFor(
  part: PartFile,
  axis: CaptureAxis,
  recipe: Pick<CaptureEntry, "into">
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
