import { ok as expect } from "node:assert/strict";
import { forceIwerRuntimeIfNative, shouldForceIwerOnThisPage } from "./devIwer";

expect(shouldForceIwerOnThisPage("127.0.0.1", true), "dev 127.0.0.1");
expect(shouldForceIwerOnThisPage("localhost", true), "dev localhost");
expect(!shouldForceIwerOnThisPage("192.168.1.10", true), "dev LAN is Quest");
expect(!shouldForceIwerOnThisPage("127.0.0.1", false), "prod loopback");
expect(!shouldForceIwerOnThisPage("localhost", false), "prod localhost");

let forced = false;
forceIwerRuntimeIfNative({
  isNativeXRAvailable: () => true,
  installRuntime: (options) => {
    forced = options.forceInstall;
  },
});
expect(forced, "force when native xr is present");

forced = false;
forceIwerRuntimeIfNative({
  isNativeXRAvailable: () => false,
  installRuntime: () => {
    forced = true;
  },
});
expect(!forced, "skip when IWER already owns navigator.xr");
forceIwerRuntimeIfNative(undefined);
forceIwerRuntimeIfNative({});

console.log("devIwer.selfcheck ok");
