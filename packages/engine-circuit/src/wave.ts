// Ported from layered-sim E1 src/mna/wave.ts @ 031dc5e.
/** Independent-source waveforms. Times in seconds, values in SI (V or A). */

export type Waveform =
  | { kind: "dc"; value: number }
  | { kind: "step"; t0: number; v0: number; v1: number }
  | {
      kind: "pwm";
      period: number;
      duty: number;
      low: number;
      high: number;
      t0?: number;
    }
  | { kind: "pwl"; points: ReadonlyArray<readonly [number, number]> }
  | { kind: "sine"; offset: number; amp: number; freq: number; phase?: number };

export function waveAt(w: Waveform, t: number): number {
  switch (w.kind) {
    case "dc":
      return w.value;
    case "step":
      return t <= w.t0 ? w.v0 : w.v1;
    case "pwm": {
      const t0 = w.t0 ?? 0;
      const period = w.period;
      let phase = (t - t0) % period;
      if (phase < 0) phase += period;
      return phase < w.duty * period ? w.high : w.low;
    }
    case "pwl": {
      const pts = w.points;
      const n = pts.length;
      if (n === 0) return 0;
      const first = pts[0] as readonly [number, number];
      if (t <= first[0]) return first[1];
      const last = pts[n - 1] as readonly [number, number];
      if (t >= last[0]) return last[1];
      for (let i = 1; i < n; i++) {
        const b = pts[i] as readonly [number, number];
        if (t <= b[0]) {
          const a = pts[i - 1] as readonly [number, number];
          const u = (t - a[0]) / (b[0] - a[0]);
          return a[1] + u * (b[1] - a[1]);
        }
      }
      return last[1];
    }
    case "sine":
      return (
        w.offset + w.amp * Math.sin(2 * Math.PI * w.freq * t + (w.phase ?? 0))
      );
    default: {
      const _never: never = w;
      return _never;
    }
  }
}
