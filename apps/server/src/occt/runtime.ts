import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { OpenCascade } from "./types";

const require = createRequire(import.meta.url);

let pending: Promise<OpenCascade> | null = null;

function distDir(): string {
  // No "exports" map in the package, so any subpath resolves.
  return join(dirname(require.resolve("opencascade.js/package.json")), "dist");
}

/**
 * opencascade.js ships one file that both `require()`s and ends in `export default`,
 * which Node 22+ refuses to classify. Strip the ESM tail and run the rest as CommonJS
 * text; pass the wasm bytes directly so emscripten never tries to fetch() a file path.
 */
function loadModule(): Promise<OpenCascade> {
  const dist = distDir();
  const src = readFileSync(join(dist, "opencascade.wasm.js"), "utf8").replace(
    /export default opencascade;\s*$/,
    "module.exports = opencascade;"
  );
  const holder: { exports: unknown } = { exports: {} };
  const factory = new Function(
    "module",
    "exports",
    "require",
    "__dirname",
    "__filename",
    src
  );
  factory(
    holder,
    holder.exports,
    require,
    dist,
    join(dist, "opencascade.wasm.js")
  );
  const init = holder.exports as (opts: {
    wasmBinary: Buffer;
    print: (line: string) => void;
    printErr: (line: string) => void;
  }) => Promise<OpenCascade>;
  // OCCT chats on stdout (build banner, per-file transfer notes). Ours are the lines
  // that matter, so keep the kernel's behind SFAB_BENCH_OCCT_LOG=1.
  const chatty = process.env.SFAB_BENCH_OCCT_LOG === "1";
  const say = (line: string) => {
    if (chatty) console.log(`[occt] ${line}`);
  };
  return init({
    wasmBinary: readFileSync(join(dist, "opencascade.wasm.wasm")),
    print: say,
    printErr: say,
  });
}

/** The OpenCascade WASM kernel, instantiated once per process. */
export function openCascade(): Promise<OpenCascade> {
  if (!pending) {
    const started = Date.now();
    pending = loadModule().then((oc) => {
      // Wall-clock lines are opt-in so two runs of one commit log the same.
      if (process.env.BENCH_TIMINGS === "1")
        console.log(`[occt] kernel ready in ${Date.now() - started}ms`);
      return oc;
    });
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * A kernel failure, as a line you can put in a log or an HTTP response.
 *
 * OCCT throws through embind, which does not always arrive as an `Error`. It can
 * be a raw heap pointer — a bare integer like `131422920`, with the real message
 * on the wasm side — or an object whose own `toString` walks back into the
 * emscripten module and yields the entire 324KB of generated glue. That once went
 * straight into a check's output and buried every other result in it, and the same
 * value would otherwise go to a client as an error body.
 *
 * So: never longer than a line, and say plainly when the kernel gave us nothing.
 */
export function briefError(err: unknown): string {
  if (err instanceof Error && err.message) {
    if (UNCATCHABLE.test(err.message)) {
      return "OpenCascade rejected this file and could not say why: the kernel raised a C++ exception, and this build ships without the glue that turns one into a message";
    }
    return clamp(err.message);
  }
  if (typeof err === "number")
    return `the kernel threw at ${err} without a message`;
  if (typeof err === "string" && err) return clamp(err);
  return clamp(String((err as { message?: unknown } | null)?.message ?? err));
}

/**
 * What a `Standard_Failure` looks like coming out of this build.
 *
 * None of `wasmTable`, `__cxa_can_catch` or `__cxa_is_pointer_type` are exported by
 * opencascade.js 1.1.1, so when OCCT throws, emscripten's dispatch reaches for
 * something that is not there and the throw surfaces as a JS TypeError about its
 * own internals. Two of the 35 NIST models do this. The kernel survives it — the
 * next file builds correctly — so there is nothing to recover, only something to
 * say that is not `wasmTable.get(...) is not a function`.
 */
const UNCATCHABLE =
  /wasmTable|_{2,3}cxa_(can_catch|is_pointer_type|find_matching_catch)/;

/** True when OCCT refused the file outright, rather than producing something wrong. */
export function refusedByKernel(err: unknown): boolean {
  if (typeof err === "number") return true;
  const message = err instanceof Error ? err.message : String(err);
  return (
    UNCATCHABLE.test(message) ||
    /without a message|could not say why/.test(message)
  );
}

const LIMIT = 300;
const clamp = (text: string) =>
  text.length > LIMIT
    ? `${text.slice(0, LIMIT)}… (${text.length} characters, truncated)`
    : text;
