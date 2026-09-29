import { ok as expect } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_PUBLIC_PORT, publicPort } from "./config";
import {
  CODE_TTL_MS,
  ensureOffer,
  lookupDevice,
  mintOffer,
  redeemCode,
  redeemFragment,
} from "./pairing";
import { forwardedClientAddress, isLoopbackAddress } from "./principal";

expect(isLoopbackAddress("127.0.0.1"), "127.0.0.1 is loopback");
expect(isLoopbackAddress("::1"), "::1 is loopback");
expect(isLoopbackAddress("::ffff:127.0.0.1"), "mapped IPv4 is loopback");
expect(!isLoopbackAddress("192.168.1.20"), "LAN is not loopback");
expect(!isLoopbackAddress(undefined), "missing address is not loopback");

expect(
  forwardedClientAddress("127.0.0.1", "192.168.1.20") === "192.168.1.20",
  "proxy trusts XFF from loopback peer"
);
expect(
  forwardedClientAddress("::1", "192.168.1.20") === "192.168.1.20",
  "ipv6 loopback peer trusts XFF"
);
expect(
  forwardedClientAddress("192.168.1.20", "127.0.0.1") === "192.168.1.20",
  "public server ignores spoofed XFF"
);
expect(
  forwardedClientAddress("127.0.0.1", undefined) === "127.0.0.1",
  "loopback without XFF stays loopback"
);
expect(
  forwardedClientAddress("127.0.0.1", "127.0.0.1") === "127.0.0.1",
  "localhost via proxy is still loopback"
);

const prevPort = process.env.SFAB_BENCH_PUBLIC_PORT;
process.env.SFAB_BENCH_PUBLIC_PORT = "9999";
expect(publicPort() === 9999, "SFAB_BENCH_PUBLIC_PORT overrides join port");
if (prevPort === undefined) delete process.env.SFAB_BENCH_PUBLIC_PORT;
else process.env.SFAB_BENCH_PUBLIC_PORT = prevPort;
expect(
  publicPort() === DEFAULT_PUBLIC_PORT,
  "join URLs default to 7322 (SFAB), not the API port"
);

const db = new DatabaseSync(":memory:");
const offer = mintOffer(db);
expect(offer.code.length === 6, "code is 6 characters");
expect(offer.fragment.startsWith("p."), "fragment has prefix");
expect(ensureOffer(db).code === offer.code, "fresh offer is reused");

const first = redeemCode(offer.code.toLowerCase(), "Quest", Date.now(), db);
expect(
  typeof first !== "string" && first.token.startsWith("d."),
  "code issues a device token"
);
expect(
  redeemCode(offer.code, "Quest", Date.now(), db) === "invalid",
  "code is single-use"
);
expect(
  typeof first !== "string" &&
    lookupDevice(first.token, db)?.id === first.deviceId,
  "issued token looks up"
);
expect(!lookupDevice("d.nope", db), "unknown token misses");

const next = mintOffer(db);
const viaFragment = redeemFragment(next.fragment, "Phone", Date.now(), db);
expect(
  typeof viaFragment !== "string" && viaFragment.label === "Phone",
  "fragment issues a device"
);
expect(
  redeemFragment(next.fragment, "Phone", Date.now(), db) === "invalid",
  "fragment is single-use"
);

const stale = mintOffer(db);
expect(
  redeemCode(stale.code, "Quest", stale.expiresAt + 1, db) === "expired",
  "expired code is rejected"
);
expect(
  ensureOffer(db, Date.now() + CODE_TTL_MS + 1).code !== stale.code,
  "expired offer is replaced"
);

console.log("auth.selfcheck ok");
