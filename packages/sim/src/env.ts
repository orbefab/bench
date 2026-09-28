/**
 * File and clock access the host passes in. This package does not import
 * `node:*`.
 */
import type { Store } from "@sfab-bench/parts";

import type { CaptureEnv } from "./capture";

export type PlanEnv = {
  store: Store;
  catalogDir(): string;
  exists(file: string): boolean;
  readText(file: string): string;
  realpath(file: string): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(file: string): string;
  isAbsolute(file: string): boolean;
  absolutePath(file: string): string;
  sep: string;
};

export type StampEnv = {
  store: Store;
  absolutePath(file: string): string;
  defaultCatalog(): string;
  join(...parts: string[]): string;
};

let planEnv: PlanEnv | null = null;
let stampEnv: StampEnv | null = null;
let captureEnv: CaptureEnv | null = null;

export function configurePlanEnv(env: PlanEnv): void {
  planEnv = env;
}

export function requirePlanEnv(): PlanEnv {
  if (!planEnv) throw new Error("plan has no file host");
  return planEnv;
}

export function configureStampEnv(env: StampEnv): void {
  stampEnv = env;
}

export function requireStampEnv(): StampEnv {
  if (!stampEnv) throw new Error("circuit stamp has no file host");
  return stampEnv;
}

export function configureCaptureEnv(env: CaptureEnv): void {
  captureEnv = env;
}

export function requireCaptureEnv(): CaptureEnv {
  if (!captureEnv) throw new Error("capture has no file host");
  return captureEnv;
}
