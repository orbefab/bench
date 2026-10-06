/** `sfab-bench repin`: prints each moved pin and each refusal. */

import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { repin } from "./repin";
import { catalogRoot } from "./world/plan-host";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** The bench's own examples and fixtures, when no folder is named. */
const DEFAULT_ROOTS = [
  join(repo, "examples"),
  join(repo, "apps/server/fixtures"),
];

export async function repinCli(action: {
  write: boolean;
  roots: string[];
}): Promise<number> {
  const result = await repin({
    roots: action.roots.length > 0 ? action.roots : DEFAULT_ROOTS,
    catalogDir: catalogRoot(),
    journal: join(repo, ".sfab", "repin-plan.json"),
    write: action.write,
  });
  const rel = (file: string) => relative(process.cwd(), file) || file;
  for (const row of result.changes) {
    process.stdout.write(
      `${rel(row.file)} ${row.field} ${row.id} ${row.from.slice(0, 12)} → ${row.to.slice(0, 12)}\n`
    );
  }
  for (const why of result.refusals) process.stdout.write(`refused: ${why}\n`);
  const moved = result.changes.length;
  if (result.refusals.length > 0) {
    process.stdout.write("repin: refused; nothing written\n");
    return 1;
  }
  process.stdout.write(
    moved === 0
      ? "repin: every pin is current\n"
      : result.wrote
        ? `repin: wrote ${moved} pin(s)\n`
        : `repin: ${moved} pin(s) would move (--dry)\n`
  );
  return 0;
}
