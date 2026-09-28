/**
 * File access for the document layer. The package does not import `node:*`.
 * The Node implementation lives in the server.
 */
export type Store = {
  readText(path: string): string;
  exists(path: string): boolean;
  writeText(path: string, text: string): void;
};
