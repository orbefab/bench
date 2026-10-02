import { ok as expect } from "node:assert/strict";
import { ensureProvisioned, installFailureDetail } from "./provisioning";

expect(
  installFailureDetail(
    "codex",
    new Error("getaddrinfo ENOTFOUND registry.npmjs.org")
  ) === "Could not install Codex — no connection to the registry.",
  "offline install says so"
);
expect(
  installFailureDetail(
    "cursor",
    new Error("Bootstrap command failed for harness 'cursor' (exit 1)")
  ) === "Could not install Cursor.",
  "other failures stay short"
);
expect(
  !installFailureDetail("codex", new Error("pnpm exploded")).includes("pnpm"),
  "no tool noise in the copy"
);
expect(
  installFailureDetail("grok-build", "not an Error").startsWith(
    "Could not install Grok"
  ),
  "a thrown non-Error still reads"
);
// The word boundary is the point: an error that merely says "network" is not
// evidence the registry was unreachable, and the old test claimed it was.
expect(
  installFailureDetail("codex", new Error("network config parse error")) ===
    "Could not install Codex.",
  "a stray 'network' is not an offline diagnosis"
);

/** One install, resolved by hand, counting how many times it was asked for. */
function fakeInstall() {
  let calls = 0;
  let settle!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const prepare = () => {
    calls += 1;
    return new Promise<unknown>((res, rej) => {
      settle = res;
      reject = rej;
    });
  };
  return {
    prepare,
    calls: () => calls,
    settle: (v: unknown = null) => settle(v),
    reject: (e: unknown) => reject(e),
  };
}

const run = async () => {
  // Two folders sending at once must join one install, not run two. This is
  // the whole reason `inflight` is keyed by harness and not by (root, harness).
  const shared = fakeInstall();
  const a = ensureProvisioned("/tmp/one", "codex", shared.prepare);
  const b = ensureProvisioned("/tmp/two", "codex", shared.prepare);
  expect(shared.calls() === 1, "two folders join one install");
  shared.settle();
  expect(
    (await a) === null && (await b) === null,
    "both callers get the success"
  );

  // And nothing is remembered: the vendor's marker makes the second run a
  // no-op on disk, so the map must be empty again or a later send is served a
  // stale promise for an install that has since been removed.
  const again = fakeInstall();
  const c = ensureProvisioned("/tmp/one", "codex", again.prepare);
  expect(again.calls() === 1, "a settled install is forgotten, not cached");
  again.settle();
  await c;

  // A failure is reported as copy, not thrown, and is likewise forgotten so
  // the next send simply tries again.
  const bad = fakeInstall();
  const d = ensureProvisioned("/tmp/one", "cursor", bad.prepare);
  bad.reject(new Error("getaddrinfo EAI_AGAIN registry.npmjs.org"));
  expect(
    (await d) === "Could not install Cursor — no connection to the registry.",
    "a failed install reads as copy"
  );
  const retry = fakeInstall();
  void ensureProvisioned("/tmp/one", "cursor", retry.prepare);
  expect(retry.calls() === 1, "a failed install is retried by the next send");
  retry.settle();

  // Different harnesses are different installs.
  const grok = fakeInstall();
  void ensureProvisioned("/tmp/one", "grok-build", grok.prepare);
  const open = fakeInstall();
  void ensureProvisioned("/tmp/one", "opencode", open.prepare);
  expect(
    grok.calls() === 1 && open.calls() === 1,
    "two harnesses do not share an install"
  );
  grok.settle();
  open.settle();

  // A hang never settles, so without a timeout the map stays occupied and
  // every folder's next send joins the dead promise until the process dies.
  const hung = fakeInstall();
  const timed = ensureProvisioned("/tmp/one", "codex", hung.prepare, 20);
  expect(
    (await timed) === "Could not install Codex — the install took too long.",
    "a hung install times out as copy"
  );
  hung.settle();
  const afterHang = fakeInstall();
  void ensureProvisioned("/tmp/one", "codex", afterHang.prepare, 20);
  expect(
    afterHang.calls() === 1,
    "a timed-out install is retried by the next send"
  );
  afterHang.settle();
};

// ensureProvisioned logs each failure with its stack, which carries absolute
// paths. Collect those lines so the check's output stays the same on every machine.
const main = async () => {
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(String(args[0]));
  };
  try {
    await run();
  } finally {
    console.error = realError;
  }
  expect(
    logged.includes("[provisioning] cursor install failed") &&
      logged.includes("[provisioning] codex install failed"),
    "failed installs are logged"
  );
  console.log("provisioning.selfcheck ok");
};

await main();
