/** USART0 TX retained per board. Older bytes drop off the front. */
export const SERIAL_CAP = 64 * 1024;

export type SerialPage = {
  text: string;
  /** Monotonic offset just past `text`. */
  next: number;
  /** Bytes discarded before `from` because the ring moved on. */
  dropped?: number;
};

/**
 * A byte-offset log. `next` only increases, including across a firmware
 * reload that replaces the retained text with a marker line.
 */
export class SerialRing {
  private text = "";
  private base = 0;

  get next(): number {
    return this.base + this.text.length;
  }

  append(chunk: string) {
    if (!chunk) return;
    this.text += chunk;
    if (this.text.length <= SERIAL_CAP) return;
    const drop = this.text.length - SERIAL_CAP;
    this.text = this.text.slice(drop);
    this.base += drop;
  }

  /** Drop the retained text and keep `marker` at the new front. */
  clear(marker: string) {
    this.base = this.next;
    this.text = "";
    this.append(marker);
  }

  read(from: number): SerialPage {
    const next = this.next;
    const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    if (start < this.base) {
      return { text: this.text, next, dropped: this.base - start };
    }
    if (start >= next) return { text: "", next };
    return { text: this.text.slice(start - this.base), next };
  }

  /** The retained tail, at most `limit` characters. */
  tail(limit: number): SerialPage {
    const page = this.read(0);
    if (page.text.length <= limit) return page;
    return {
      text: page.text.slice(-limit),
      next: page.next,
      ...(page.dropped !== undefined ? { dropped: page.dropped } : {}),
    };
  }
}
