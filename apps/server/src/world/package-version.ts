/** Installed version of a dependency. Callers pass their own module URL. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function packageVersion(name: string, from: string): string {
  try {
    const require = createRequire(from);
    let dir = dirname(require.resolve(name));
    for (let hop = 0; hop < 6; hop++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === name) return pkg.version ?? "unknown";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* the manifest says unknown rather than failing the run */
  }
  return "unknown";
}
