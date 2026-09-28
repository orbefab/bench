/** Web standards, in browsers and in Node. Not a host import. */
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare function structuredClone<T>(value: T): T;
declare const console: { log(...args: unknown[]): void };
