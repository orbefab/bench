/**
 * What the client draws and inspects. Built on the server from the run
 * plan. Not a file format.
 */

import type { Pose } from "./layered";
import type { WorldPrimitive, WorldStepProp } from "./world";

export type WorldViewRobot = {
  id: string;
  /** Path relative to the world file. */
  urdf: string;
  pose: Pose;
};

export type WorldViewBoard = {
  id: string;
  chip: string;
  firmware: string;
  source?: string;
  pose: Pose;
  size: [number, number, number];
  /** Volts. The card's brownout line uses this, not a client-side catalog. */
  brownoutVoltage: number;
};

export type WorldViewSupply = {
  id: string;
  voltage: number;
  currentLimit: number;
  rSeries: number;
};

export type WorldViewPart = {
  id: string;
  /** Short name the card shows, for example `sg90`. */
  model: string;
  drives?: { robot: string; joint: string };
  /** Servo signal pin, or null when the part is not a servo. */
  signalPin: string | null;
};

export type WorldViewFeeds = {
  boards: Record<string, string | null>;
  parts: Record<string, string | null>;
};

export type WorldView = {
  environment: {
    ground: { plane: boolean };
    primitives?: WorldPrimitive[];
    stepProps?: WorldStepProp[];
  };
  robots: WorldViewRobot[];
  boards: WorldViewBoard[];
  supplies: WorldViewSupply[];
  parts: WorldViewPart[];
  wires: [string, string][];
  feeds: WorldViewFeeds;
};
