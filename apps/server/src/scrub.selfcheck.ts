import { parseWorldClient, scrubReadError } from "./world/live";

/**
 * A bad scrub is not a world failure, and negative times are refused.
 */

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const negativeFrom = parseWorldClient(
  JSON.stringify({ type: "timeline", from: -0.01, to: 1, maxPoints: 8 })
);
expect("error" in negativeFrom, "timeline from below 0 is refused");

const negativeSeek = parseWorldClient(
  JSON.stringify({ type: "seek", t: -0.001, nonce: "n" })
);
expect("error" in negativeSeek, "seek before 0 is refused");

const ok = parseWorldClient(JSON.stringify({ type: "seek", t: 0, nonce: "n" }));
expect(!("error" in ok) && ok.type === "seek", "seek at 0 is the start");

const histories = parseWorldClient(JSON.stringify({ type: "histories" }));
expect(
  !("error" in histories) && histories.type === "histories",
  "a part tab may ask for undo history"
);

const seek = scrubReadError("seek", "recording did not answer", "n1");
expect(seek.type === "timeline-error", "a failed seek is not a world error");
expect(seek.nonce === "n1", "the seek nonce comes back");
expect(seek.message === "recording did not answer", seek.message);

const overview = scrubReadError("timeline", "recording did not answer");
expect(overview.type === "timeline-error", "a failed timeline read is scoped");
expect(overview.nonce === undefined, "a timeline read has no seek nonce");

console.log("scrub.selfcheck ok");
