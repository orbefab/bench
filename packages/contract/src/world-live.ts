/**
 * The shared world run (ADR 0009, D-015). One document, one sim.
 * Camera and scrub stay on the client. `timeline` and `seek` are answered
 * to the sender only and do not change the run.
 *
 * Poses are the body frame in the world: metres, Z-up, quaternion scalar
 * first `[w, x, y, z]`. Joint values are radians.
 */

import type { EditOp } from "./edit";
import type { RunReport } from "./layered";
import type { WorldError, WorldQuat, WorldVec3 } from "./world";

export type WorldLinkPose = {
  /** Position in metres. */
  p: WorldVec3;
  /** Unit quaternion, scalar first. */
  q: WorldQuat;
};

/**
 * Arduino pins in one number. Bit 0 is D0 … bit 13 is D13, bit 14 is A0 …
 * bit 19 is A5. PORTB6–7 and PORTC6–7 are not part of the mask.
 *
 * Collected at the state tick: port listeners OR the bits that changed,
 * and the tick reads DDR, PORT, and PIN. Nothing walks instructions.
 */
export type WorldPinState = {
  /** 1 = output (DDR). */
  ddr: number;
  /** PORT when the pin is an output, PIN when it is an input. */
  level: number;
  /** 1 if that pin changed since the previous state tick. */
  toggled: number;
};

/** D0–D13, then A0–A5. The pin table and the mask use this order. */
export const ARDUINO_PINS: readonly string[] = [
  "D0",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "D9",
  "D10",
  "D11",
  "D12",
  "D13",
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
];

/** Bit index in `WorldPinState`, or undefined when `pin` is not D0–D13 or A0–A5. */
export function arduinoPinBit(pin: string): number | undefined {
  const digital = /^D(\d+)$/.exec(pin);
  if (digital) {
    const n = Number(digital[1]);
    if (n >= 0 && n <= 13) return n;
    return undefined;
  }
  const analog = /^A(\d+)$/.exec(pin);
  if (analog) {
    const n = Number(analog[1]);
    if (n >= 0 && n <= 5) return 14 + n;
    return undefined;
  }
  return undefined;
}

export function maskHasPin(mask: number, pin: string): boolean {
  const bit = arduinoPinBit(pin);
  if (bit === undefined) return false;
  return (mask & (1 << bit)) !== 0;
}

/**
 * Pack PORTD, PORTB, and PORTC into the 20-bit Arduino mask.
 * D0–D7 = PORTD0–7, D8–D13 = PORTB0–5, A0–A5 = PORTC0–5.
 */
export function arduinoPinMask(
  portD: number,
  portB: number,
  portC: number
): number {
  return (portD & 0xff) | ((portB & 0x3f) << 8) | ((portC & 0x3f) << 14);
}

/** Servo display state. The motor current does not follow this. */
export type WorldPartMotion = "idle" | "moving" | "stall";

/**
 * One part in the shared run, at the state rate. `null` is no signal:
 * the pulse was missing, out of range, or older than the gap.
 * `state` and `current` are optional so a client from before the power
 * budget still reads the pulse.
 */
export type WorldPartState = {
  /** Last complete pulse width, in microseconds. */
  pulseUs: number | null;
  /** Command angle in degrees, from the servo map. */
  commandDeg: number | null;
  /** Idle, moving, or stall. Absent on an older client. */
  state?: WorldPartMotion;
  /** Amperes drawn from the supply. An unwired supply pin is 0. */
  current?: number;
  /**
   * Volts at V+ relative to GND. Absent when the part has no power port.
   * An unwired V+ is 0.
   */
  voltage?: number;
  /** Last ray hit, metres. Null is no echo. Absent on a servo. */
  distanceM?: number | null;
  /** Echo high time, seconds. Null when the part emitted no pulse. */
  echoS?: number | null;
  /** True when the last trigger returned a hit inside the range. */
  hit?: boolean;
};

/** One supply in the shared run. Optional on `WorldState` for older clients. */
export type WorldSupplyState = {
  /** Volts at this supply's terminal this step, never negative. */
  voltage: number;
  /** Amperes drawn from this supply this step. */
  current: number;
  /** State of charge, 0 to 1. Present on a `battery@1` supply. */
  soc?: number;
};

/** One board in the shared run. `pins` is the 20-bit snapshot for this tick. */
export type WorldBoardState = {
  /**
   * The firmware image is loaded. While the run is paused the CPU does
   * not advance, and `running` stays true. A fault clears it.
   */
  running: boolean;
  /** Why this board is stopped. The rest of the run keeps going. */
  fault?: string;
  /**
   * No supply reaches a power input, so the CPU never boots. Absent when
   * a supply does. The desktop status says "unpowered".
   */
  unpowered?: boolean;
  /** Absent only on a client that has not seen a state tick yet. */
  pins?: WorldPinState;
  /** Brownout reboots since this world was loaded. Absent on older clients. */
  resets?: number;
  /** True while the CPU is in reset, including the delay after the rail recovers. */
  brownout?: boolean;
  /**
   * Volts on this board's 5V node. Absent when no supply reaches the board.
   * With no cable this equals the supply terminal.
   */
  voltage?: number;
  /**
   * Forward current, amperes, of each LED on this board's rail.
   * Keyed by instance path (`nano.led`, `led`). Each value is the
   * time-weighted mean over the last recording frame's circuit steps.
   */
  leds?: Record<string, number>;
  /**
   * Frame mean through the onboard LED at `leds[`${id}.led`]`.
   * @deprecated Read `leds` instead. Kept for the D13 card and the gauge.
   */
  ledCurrent?: number;
  /**
   * Set while a running ATmega328P supply is above brownout and below
   * 3.78 V. Reporting only: the step does not change.
   */
  warnings?: WorldBoardWarning[];
};

/** 16 MHz ATmega328P is specified only above this supply voltage. */
export const ATMEGA328P_16MHZ_MIN_V = 3.78;

export type WorldBoardWarning = {
  code: "below-16mhz-soa" | "degraded";
  message: string;
};

/**
 * Warning while `voltage` is above the chip's brownout level and below
 * the 16 MHz minimum. Null outside that band, including brownout itself.
 */
export function atmega328pSoaWarning(
  voltage: number,
  brownoutVoltage: number
): WorldBoardWarning | null {
  if (!(voltage > brownoutVoltage) || !(voltage < ATMEGA328P_16MHZ_MIN_V)) {
    return null;
  }
  return {
    code: "below-16mhz-soa",
    message: `supply ${voltage.toFixed(2)} V is below the 3.78 V the ATmega328P needs at 16 MHz; real boards may misbehave`,
  };
}

/** Radians past `[lower, upper]`. 0 when the joint is not limited. */
export function radiansPastLimit(
  qpos: number,
  lower: number,
  upper: number
): number {
  if (!(upper > lower)) return 0;
  return Math.max(0, lower - qpos, qpos - upper);
}

export function degreesPastLimit(
  qpos: number,
  lower: number,
  upper: number
): number {
  return pastLimitAmount(qpos, lower, upper, "hinge");
}

/** A hinge warns in degrees. A slide warns in metres. URDF has no ball joints. */
export type JointLimitKind = "hinge" | "slide";

/** A slide joint warns once it is past its limit by more than 1 mm. */
export const SLIDE_LIMIT_WARN_M = 0.001;

/**
 * Overshoot in the unit the warning uses. A hinge is degrees.
 * A slide stays in metres: its coordinate is already a length.
 */
export function pastLimitAmount(
  qpos: number,
  lower: number,
  upper: number,
  kind: JointLimitKind
): number {
  const raw = radiansPastLimit(qpos, lower, upper);
  if (kind === "slide") return raw;
  return (raw * 180) / Math.PI;
}

/**
 * Null at 1° or under for a hinge, and at 1 mm or under for a slide.
 * `past` is degrees or metres, matching `kind`.
 */
export function jointLimitWarning(
  joint: string,
  past: number,
  kind: JointLimitKind = "hinge"
): string | null {
  if (kind === "slide") {
    if (!(past > SLIDE_LIMIT_WARN_M)) return null;
    return `${joint} is ${past.toFixed(4)} m past its limit`;
  }
  if (!(past > 1)) return null;
  return `${joint} is ${past.toFixed(2)}° past its limit`;
}

export type WorldState = {
  /** Seconds of simulation since the run was loaded or reloaded. */
  simTime: number;
  playing: boolean;
  /** robot id → link name → world pose of that body. */
  poses: Record<string, Record<string, WorldLinkPose>>;
  /** robot id → joint name → joint position in radians. */
  joints: Record<string, Record<string, number>>;
  /** board id → whether that CPU is loaded. */
  boards: Record<string, WorldBoardState>;
  /**
   * part id → pulse and command. Optional so a client from before this
   * field still reads the rest of the state.
   */
  parts?: Record<string, WorldPartState>;
  /**
   * supply id → terminal voltage and current. Optional so an older client
   * ignores the power budget. Voltage is solved from this step's loads.
   */
  supplies?: Record<string, WorldSupplyState>;
  /**
   * Degraded parts in this run. The card's board warning list also
   * carries the ones that name a board, after any supply-voltage warning.
   */
  diagnostics?: {
    severity: "degraded";
    code: string;
    path: string;
    message: string;
  }[];
  /**
   * The recording this run is writing. Absent on a client from before
   * timelines. `from` > 0 means the front of the recording was dropped.
   */
  recording?: RecordingSummary;
};

/**
 * Who sent play or pause. A principal is its kind plus the device label
 * the session already shows. The agent has no device.
 */
export type WorldSender =
  | { kind: "loopback"; label: string }
  | { kind: "paired"; label: string }
  | { kind: "agent" };

/** Play/pause nonce. Optional, and absent on agent commands. */
export const WORLD_NONCE_MAX = 64;

/** One serial-send or send_serial payload, in characters. */
export const SERIAL_TEXT_MAX = 8_000;

/** What a client may send on the world socket. `step` is loopback only. */
export type WorldClientMessage =
  | { type: "play"; nonce?: string }
  | { type: "pause"; nonce?: string }
  | { type: "step"; n: number }
  | { type: "serial-send"; board: string; text: string; nonce?: string }
  /** Overview series for this client's strip. Does not move the run. */
  | {
      type: "timeline";
      from: number;
      to: number;
      maxPoints: number;
      /**
       * Probed ports (`portProbeId`). The answer then also carries their
       * port-level tracks. Absent means the answer is what it always was.
       */
      tracks?: string[];
    }
  /** This client wants the recorded frame at `t`. Does not move the run. */
  | { type: "seek"; t: number; nonce: string }
  /**
   * Change one part. `part` is a part id in the world; the root is the
   * default. `confirm: "break"` applies an edit that drops fixed ports.
   */
  | {
      type: "edit";
      ops: EditOp[];
      label?: string;
      part?: string;
      confirm?: "break";
    }
  | { type: "undo"; part?: string }
  | { type: "redo"; part?: string }
  /** Undo flags for this document. Sent when a part tab connects. */
  | { type: "histories" };

export type WorldServerMessage =
  | { type: "state"; state: WorldState; report?: RunReport }
  | {
      type: "command";
      command: "play" | "pause";
      by: WorldSender;
      /** Echo of the client nonce. Absent when the sender did not pass one. */
      nonce?: string;
    }
  | { type: "reloaded" }
  /** The document cannot run. A board fault is `board-error`, not this. */
  | { type: "error"; errors: WorldError[]; message?: string }
  /**
   * One board failed, or this client's serial write was rejected.
   * The run keeps its play state. `nonce` is set on a rejected send so
   * only that sender shows the line.
   */
  | { type: "board-error"; board: string; message: string; nonce?: string }
  /** USART0 TX since the previous event. `next` is the ring offset after `text`. */
  | { type: "serial"; board: string; text: string; next: number }
  | {
      type: "serial-sent";
      board: string;
      text: string;
      by: WorldSender;
      nonce?: string;
    }
  /**
   * Overview for the client that asked. Pin masks are never interpolated:
   * a point is a real frame, and its extremes cover the frames it stands in for.
   */
  | {
      type: "timeline-data";
      recording: string;
      from: number;
      to: number;
      tracks: TimelineTrack[];
      markers: TimelineMarker[];
      /**
       * Present only when the request named ports: the probed ports with
       * no recorded quantity at this level, as `portProbeId`s.
       */
      unrecorded?: string[];
    }
  /** The recorded frame for the client that sought. `frame` is null when `t` is gone. */
  | {
      type: "frame";
      recording: string;
      t: number;
      frame: RecordedFrame | null;
      nonce: string;
    }
  /**
   * The seek or timeline read failed. The shared run is unchanged.
   * `nonce` is set for a failed seek so that client can retire it.
   */
  | { type: "timeline-error"; message: string; nonce?: string }
  /**
   * An edit, undo, or redo landed. The run reloads separately.
   * `canUndo` and `canRedo` are for `part`, or for the open document
   * when `part` is absent. `histories` is every open part history.
   */
  | {
      type: "edited";
      label: string;
      canUndo: boolean;
      canRedo: boolean;
      /** The part this answer is about. Absent for the open document. */
      part?: string;
      /**
       * Undo flags for every part history this world has open.
       * Absent on an older server; the client then trusts `canUndo`
       * for `part` alone.
       */
      histories?: { part?: string; canUndo: boolean; canRedo: boolean }[];
      /** Ports a break disconnected. Absent when the edit broke none. */
      warnings?: string[];
      /**
       * A rename moved this document. Project-relative paths. Present
       * on the apply and on the undo or redo of that rename.
       */
      moved?: { from: string; to: string };
    }
  /**
   * Undo flags for this document, with no edit attached. A part tab
   * asks on connect so the buttons match this file's history.
   */
  | {
      type: "histories";
      histories: { part?: string; canUndo: boolean; canRedo: boolean }[];
    }
  /**
   * The edit would remove or rename a fixed port. Nothing was written.
   * Stay is not sending it again. Break sends `confirm: "break"`.
   */
  | {
      type: "needs-confirm";
      count: number;
      ports: { name: string; dependents: string[] }[];
      message: string;
    };

/** One frame every 10 ms of sim time. The name is the unit. */
export const RECORD_FRAME_MS = 10;

/** How much sim time a recording keeps. Older frames and events drop. */
export const RECORD_BOUND_MS = 10 * 60 * 1000;

/** Live extent of the recording, riding on `state`. Times are seconds. */
export type RecordingSummary = {
  id: string;
  /** Seconds. Greater than 0 after the front has been dropped. */
  from: number;
  /** Seconds. The live edge, which may sit between frames. */
  to: number;
};

/** Track ids the host reports. Prefixed so one list can name every channel. */
export type RecordingTracks = {
  joints: string[];
  bodies: string[];
  parts: string[];
  supplies: string[];
  boards: string[];
};

/**
 * Identity of one recording, computed when the run is built or restarted.
 * Not sampled per frame.
 */
export type RecordingManifest = {
  mujoco: string;
  avr8js: string;
  /** Seconds. */
  timestep: number;
  integrator: string;
  /** Milliseconds between frames. */
  frameMs: number;
  /** SHA-256 of the world file bytes loaded for this run. */
  worldSha256: string;
  boards: { id: string; firmware: string; sha256: string }[];
  /** Catalog rows for each part kind used by this document. */
  parts: Record<string, RecordingPartCatalog>;
};

export type RecordingPartCatalog = {
  torqueNm?: number;
  supply?: { nominal: number; min: number; max: number };
  motor?: {
    k: number;
    resistance: number;
    efficiency: number;
    eSat: number;
    quiescent: number;
    armature: number;
    frictionloss: number;
    damping: number;
  };
};

export type RecordingInfo = RecordingSummary & {
  frameMs: number;
  tracks: RecordingTracks;
  manifest: RecordingManifest;
};

export function jointTrackId(robot: string, joint: string): string {
  return `joint:${robot}/${joint}`;
}

export function bodyTrackId(robot: string, link: string): string {
  return `body:${robot}/${link}`;
}

export function partTrackId(id: string): string {
  return `part:${id}`;
}

export function supplyTrackId(id: string): string {
  return `supply:${id}`;
}

export function boardTrackId(id: string): string {
  return `board:${id}`;
}

/**
 * A probed port: the instance's run path and the port name. Run paths use
 * dots, port names do not, so the last dot splits them.
 */
export function portProbeId(instance: string, port: string): string {
  return `port:${instance}.${port}`;
}

export function parsePortProbeId(
  id: string
): { instance: string; port: string } | null {
  if (!id.startsWith("port:")) return null;
  const rest = id.slice("port:".length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { instance: rest.slice(0, dot), port: rest.slice(dot + 1) };
}

/** One quantity of a probed port, for example `port:servo.V+~A`. */
export function portTrackId(probe: string, unit: TimelineUnit): string {
  return `${probe}~${unit}`;
}

/** The probe a port-level track id belongs to. */
export function probeOfTrack(id: string): string | null {
  const cut = id.lastIndexOf("~");
  if (!id.startsWith("port:") || cut < 0) return null;
  return id.slice(0, cut);
}

/**
 * One recorded instant. Joints are radians, like `WorldState`.
 * `minVoltage`, `maxCurrent`, `worst`, and `brownoutAny` cover the
 * window (t − frame, t], so a 1 ms dip is not lost between frames.
 */
export type RecordedFrame = {
  /** Seconds of sim time. */
  t: number;
  joints: Record<string, Record<string, number>>;
  /**
   * Max overshoot in the window, in degrees for a hinge and in metres
   * for a slide. 0 when the joint stayed inside. Folded like
   * `minVoltage`, so a 1 ms spike is kept.
   */
  limitDeg: Record<string, Record<string, number>>;
  poses: Record<string, Record<string, WorldLinkPose>>;
  parts: Record<
    string,
    {
      pulseUs: number | null;
      commandDeg: number | null;
      /** Value at t. */
      state: WorldPartMotion;
      /** Worst in the window. Stall outranks moving, which outranks idle. */
      worst: WorldPartMotion;
      current: number;
      maxCurrent: number;
      /** Volts at V+ relative to GND. 0 when that port is unwired. */
      voltage: number;
      /** Metres. Present on a ranger. Null is no echo. */
      distanceM?: number | null;
      /** Echo high time, seconds. Present on a ranger. */
      echoS?: number | null;
      /** Present on a ranger. */
      hit?: boolean;
    }
  >;
  supplies: Record<
    string,
    {
      /** Terminal voltage at t. */
      voltage: number;
      /** Lowest terminal voltage in the window. */
      minVoltage: number;
      current: number;
      maxCurrent: number;
      /** Present when the supply is a battery. Follows the playhead. */
      soc?: number;
    }
  >;
  boards: Record<
    string,
    {
      pins: WorldPinState;
      running: boolean;
      /** In brownout at t. */
      brownout: boolean;
      /** In brownout at any step of the window. */
      brownoutAny: boolean;
      /** Supply was in the 16 MHz out-of-SOA band at any step of the window. */
      belowSoa: boolean;
      /** Volts on the 5V node at t. With no cable this equals the terminal. */
      voltage: number;
      /** Lowest 5V-node voltage in the window. */
      minVoltage: number;
      /** Regulator pass current into this 5V node at t. 0 when none feeds it. */
      regulatorA: number;
      /** Peak of that current in the window. */
      regulatorMax: number;
      /**
       * Forward current of each LED on this rail, keyed by instance path.
       * The time-weighted mean over this frame's circuit steps.
       */
      leds?: Record<string, number>;
      /**
       * Frame mean through `leds[`${id}.led`]`.
       * @deprecated Read `leds`. Kept for the D13 card and the gauge.
       */
      ledCurrent?: number;
    }
  >;
};

export type RecordingEvent =
  | {
      t: number;
      kind: "serial";
      board: string;
      text: string;
      /** Byte offsets in that board's stream, half-open [from, to). */
      from: number;
      to: number;
    }
  | {
      t: number;
      kind: "serial-send";
      board: string;
      text: string;
      by: WorldSender;
    }
  | { t: number; kind: "fault"; board: string; message: string }
  | { t: number; kind: "reset"; board: string }
  | { t: number; kind: "reboot"; board: string }
  | { t: number; kind: "reload"; board: string }
  | { t: number; kind: "play"; by: WorldSender }
  | { t: number; kind: "pause"; by: WorldSender }
  | {
      t: number;
      kind: "move-target";
      id: string;
      position: [number, number, number];
    };

export type RecordingRead = {
  id: string;
  from: number;
  to: number;
  frameMs: number;
  frames: RecordedFrame[];
  events: RecordingEvent[];
};

export type TimelineUnit = "deg" | "V" | "A" | "ms";

/** One numeric series for the strip. `t` and `v` are the same length. */
export type TimelineTrack = {
  id: string;
  /**
   * `deg` for a joint or a servo command, `V` for a supply terminal, a board's
   * 5V node or a pin level, `A` for a current, `ms` for a pulse or echo width.
   */
  unit: TimelineUnit;
  t: number[];
  /** Picked frame: joint degrees, volts at that port, or the command in degrees. */
  v: (number | null)[];
  /** Window minimum, when the series has one (a supply terminal or a board node). */
  lo?: number[];
};

/** Resets, reloads, faults, and serial lines. Times are seconds. */
export type TimelineMarker = {
  t: number;
  kind: "reset" | "reload" | "fault" | "serial";
  board?: string;
  text?: string;
};
