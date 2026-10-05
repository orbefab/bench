/**
 * File access the host passes in. This package does not import `node:*`.
 * Callers pass a `PlanEnv` or `StampEnv`. Nothing here is stored.
 */
import type { Store } from "@sfab-bench/parts";

export type PlanEnv = {
  store: Store;
  catalogDir(): string;
  exists(file: string): boolean;
  readText(file: string): string;
  /** The file's bytes. Without it, a file is hashed as its text. */
  readBytes?(file: string): Uint8Array;
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
