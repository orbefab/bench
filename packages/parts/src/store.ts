/**
 * File access for the document layer. The package does not import `node:*`.
 * The Node implementation lives in the server.
 */
export type Store = {
  readText(path: string): string;
  exists(path: string): boolean;
  /** Replace the file. The Node store writes a temp file, then renames. */
  writeText(path: string, text: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
};
