/**
 * L2 engine face (ADR 0012). Init, advance on the master clock, and
 * read or write a named port quantity. A2b's orchestrator is the first
 * caller in a run. No events and no registry.
 *
 * Quantities are SI. A serial byte is the integer 0–255 on `tx` and `rx`.
 */
export interface Engine {
  readonly id: string;
  init(spec: unknown): void | Promise<void>;
  /** Advance this engine's clock to `toSeconds`. */
  advance(toSeconds: number): void | Promise<void>;
  read(port: string, quantity: string): number;
  write(port: string, quantity: string, value: number): void;
  dispose(): void;
}
