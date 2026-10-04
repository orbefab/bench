/**
 * Which recipe captures a part's axis, which level takes the result, and
 * whether the part's source can run it.
 */
import type {
  CaptureAxisName,
  CaptureRecipe,
  PartFile,
} from "@sfab-bench/contract";
import type { Store } from "@sfab-bench/parts";

import type { HingeCaptureEntry } from "./body/hinge-capture";
import type { AnyCaptureEntry, CaptureEntry, CaptureFile } from "./capture";
import { groupSignature, hingeSignature } from "./capture-signature";
import type { CaptureSource } from "./capture-source";
import { type GroupCaptureEntry, isGroupForm } from "./group-capture";

export type CaptureAxis = CaptureAxisName;

export type CaptureRecipeSource = {
  catalogDir: string;
  store: Store;
  join(...parts: string[]): string;
};

function axisOf(entry: AnyCaptureEntry | CaptureRecipe): CaptureAxis {
  return "form" in entry && entry.form === "hinge@1" ? "body" : "behaviour";
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
): CaptureEntry | GroupCaptureEntry | null;
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

/**
 * Why the source cannot run this recipe, or null. The capture runners
 * refuse with the same reason, so the card's readiness and the run agree.
 * A fixture the run reads (a sweep's fixture file, a hinge's) must exist
 * in the project or the catalog. What only the run can show (a stamp that
 * does not build, a scene instance of another type) fails the run.
 */
export function captureProblem(
  entry: AnyCaptureEntry,
  source: CaptureSource
): string | null {
  const found = source.part(entry.part);
  if (!found) return `${entry.part} did not load`;
  const { part } = found;
  if (!source.typeOf(part)) return `${entry.part} type did not load`;
  const fixture = (id: string) =>
    source.store.exists(source.fixture(id)) ? null : `no fixture ${id}`;
  if ("scene" in entry) {
    if (!isGroupForm(entry.form)) {
      return `no group reduction to ${entry.form}`;
    }
    const variant = part.axes?.behaviour?.[entry.sourceLevel]?.default ?? "";
    const read = (id: string) => source.part(id)?.part ?? null;
    const readType = (id: string) => source.type(id)?.type ?? null;
    const hash = groupSignature(
      entry.part,
      { level: entry.sourceLevel, variant },
      read,
      readType
    );
    return hash
      ? null
      : `${entry.part} class ${entry.sourceLevel} behaviour is not a composite`;
  }
  if ("form" in entry) {
    const variant = part.axes?.body?.[entry.sourceLevel]?.default ?? "";
    if (!hingeSignature(part, { level: entry.sourceLevel, variant })) {
      return `${entry.part} class ${entry.sourceLevel} body is not a gear train`;
    }
    return fixture(entry.fixture);
  }
  return entry.sweep.fixture
    ? fixture(entry.sweep.fixture)
    : `${entry.part} capture needs a fixture`;
}
