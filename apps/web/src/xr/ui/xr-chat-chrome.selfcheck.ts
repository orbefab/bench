import { equal as expect } from "node:assert/strict";
import {
  XR_CHAT_DEFAULT_H,
  XR_CHAT_DEFAULT_W,
  XR_CHAT_OVERLAY_H,
  XR_CHAT_OVERLAY_W,
  XR_COMPOSER_MAX_H,
  XR_COMPOSER_MIN_H,
  xrComposerHeight,
} from "./xrChatChrome";

expect(xrComposerHeight(""), XR_COMPOSER_MIN_H, "empty stays min");
expect(xrComposerHeight("hi"), XR_COMPOSER_MIN_H, "one short line stays min");
expect(xrComposerHeight("a\nb"), 52, "two explicit lines");
expect(
  xrComposerHeight("x".repeat(32)),
  XR_COMPOSER_MIN_H,
  "exactly one wrap unit"
);
expect(xrComposerHeight("x".repeat(33)), 52, "wraps onto a second line");
expect(
  xrComposerHeight("x".repeat(32 * 20)),
  XR_COMPOSER_MAX_H,
  "long wrap caps"
);
expect(
  xrComposerHeight("a\n".repeat(20)),
  XR_COMPOSER_MAX_H,
  "many newlines cap"
);

expect(
  XR_CHAT_OVERLAY_W < XR_CHAT_DEFAULT_W,
  true,
  "overlay narrower than chat"
);
expect(
  XR_CHAT_OVERLAY_H < XR_CHAT_DEFAULT_H,
  true,
  "overlay shorter than chat"
);

console.log("xr-chat-chrome.selfcheck ok");
