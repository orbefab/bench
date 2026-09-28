/**
 * Servo.h defaults: `MIN_PULSE_WIDTH` 544 and `MAX_PULSE_WIDTH` 2400.
 * `Servo.write` uses Arduino `map(angle, 0, 180, 544, 2400)`, which is
 * `(angle * (2400 - 544)) / 180 + 544` in integer arithmetic. The inverse
 * is `deg = (µs − 544) · 180 / (2400 − 544)`, clamped to 0–180.
 * A measured pulse outside 400–2600 µs is not a servo signal.
 */
export const SERVO_US_MIN = 544;
export const SERVO_US_MAX = 2400;
export const PULSE_US_LO = 400;
export const PULSE_US_HI = 2600;

/** No complete valid pulse for longer than this is no signal. */
export const SIGNAL_GAP_MS = 60;

const SERVO_DEG = 180;
const SERVO_US_SPAN = SERVO_US_MAX - SERVO_US_MIN;

export type ServoTrack = {
  pulseUs: number | null;
  commandDeg: number | null;
  /** Sim seconds of the last valid pulse. Null when there is no signal. */
  seen: number | null;
};

export function blankTrack(): ServoTrack {
  return { pulseUs: null, commandDeg: null, seen: null };
}

/** Degrees, or null when `us` is not a servo pulse. */
export function commandDegFromPulse(us: number): number | null {
  if (!Number.isFinite(us) || us < PULSE_US_LO || us > PULSE_US_HI) return null;
  const raw = ((us - SERVO_US_MIN) * SERVO_DEG) / SERVO_US_SPAN;
  if (raw < 0) return 0;
  if (raw > SERVO_DEG) return SERVO_DEG;
  return raw;
}

/**
 * One millisecond of one servo. `pulsesUs` are the widths completed during
 * this step. No signal leaves the joint limp: the caller applies no motor
 * voltage. The position loop itself is the motor law, not a slew.
 */
export function trackServo(input: {
  track: ServoTrack;
  simTime: number;
  pulsesUs: readonly number[];
  /**
   * False when the pin is not driving (reset, or a board that is not
   * running). The signal gap does not apply: the servo is limp this step.
   */
  driven?: boolean;
}): { track: ServoTrack; limp: boolean } {
  if (input.driven === false) {
    return { track: blankTrack(), limp: true };
  }
  let pulseUs = input.track.pulseUs;
  let commandDeg = input.track.commandDeg;
  let seen = input.track.seen;
  for (const us of input.pulsesUs) {
    const command = commandDegFromPulse(us);
    if (command === null) {
      pulseUs = null;
      commandDeg = null;
      seen = null;
      continue;
    }
    pulseUs = us;
    commandDeg = command;
    seen = input.simTime;
  }
  // Round to whole steps: MuJoCo's time is a float sum of 0.001 s steps.
  if (
    seen !== null &&
    Math.round((input.simTime - seen) * 1000) > SIGNAL_GAP_MS
  ) {
    pulseUs = null;
    commandDeg = null;
    seen = null;
  }
  if (commandDeg === null || seen === null) {
    return { track: blankTrack(), limp: true };
  }
  return { track: { pulseUs, commandDeg, seen }, limp: false };
}
