import { ok as expect } from "node:assert/strict";
import {
  jointLimitWarning,
  pastLimitAmount,
  SLIDE_LIMIT_WARN_M,
} from "@sfab-bench/contract";

/**
 * A hinge overshoots in degrees. A slide stays in metres and warns
 * above 1 mm. The inputs are the joint coordinate.
 */

const deg = (degrees: number) => (degrees * Math.PI) / 180;

const hingeSmall = pastLimitAmount(deg(0.5), 0, 0, "hinge");
expect(hingeSmall === 0, `unlimited hinge was ${hingeSmall}`);

const hinge = pastLimitAmount(1 + deg(0.5), 0, 1, "hinge");
expect(Math.abs(hinge - 0.5) < 1e-9, `hinge 0.5° was ${hinge}`);
expect(
  jointLimitWarning("arm/elbow", hinge, "hinge") === null,
  "0.5° hinge warned"
);
expect(jointLimitWarning("arm/elbow", 1, "hinge") === null, "1° hinge warned");

const hingeOver = pastLimitAmount(1 + deg(2), 0, 1, "hinge");
expect(
  jointLimitWarning("arm/elbow", hingeOver, "hinge") ===
    "arm/elbow is 2.00° past its limit",
  `hinge text ${jointLimitWarning("arm/elbow", hingeOver, "hinge")}`
);

const slideExact = pastLimitAmount(1.001, 0, 1, "slide");
expect(
  Math.abs(slideExact - SLIDE_LIMIT_WARN_M) < 1e-12,
  `1 mm slide was ${slideExact}`
);
expect(
  jointLimitWarning("jaw", SLIDE_LIMIT_WARN_M, "slide") === null,
  "1 mm slide warned"
);

const slide = pastLimitAmount(1.5, 0, 1, "slide");
expect(slide === 0.5, `slide metres were ${slide}`);
const slideText = jointLimitWarning("jaw", 0.0015, "slide");
expect(
  slideText === "jaw is 0.0015 m past its limit",
  `slide text ${slideText}`
);
expect(slideText?.includes("°") !== true, "slide warning used degrees");

console.log("limits.selfcheck ok");
