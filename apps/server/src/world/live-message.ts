/**
 * What a world socket accepts, checked once. Each client message type has
 * one schema; a failure is worded by the message's own text, never zod's,
 * because the web and the self-checks show these sentences.
 */

import {
  type EditOp,
  type EditRefusal,
  SERIAL_TEXT_MAX,
  WORLD_NONCE_MAX,
  type WorldClientMessage,
  type WorldServerMessage,
} from "@sfab-bench/contract";
import { readEditOp } from "@sfab-bench/parts";
import { z } from "zod";

const NONCE = "nonce must be a short string";
const PART = "part must be a part id";
const SERIAL_TEXT = `serial text must be a string of at most ${SERIAL_TEXT_MAX} characters`;
const TRACKS = "timeline tracks must be a short list of port ids";

const nonce = z
  .string({ error: NONCE })
  .min(1, NONCE)
  .max(WORLD_NONCE_MAX, NONCE);
const part = z.string({ error: PART });
const time = (text: string) => z.number({ error: text }).min(0, text);

/** A whole number is not a `.int()`: that one also refuses unsafe integers. */
const whole = (text: string) =>
  z.number({ error: text }).refine(Number.isInteger, text);

const playOrPause = (type: "play" | "pause") =>
  z.object({ type: z.literal(type), nonce: nonce.optional() });

const schemas = {
  play: playOrPause("play"),
  pause: playOrPause("pause"),
  step: z.object({
    type: z.literal("step"),
    n: whole("step needs a whole number of steps").min(
      0,
      "step needs a whole number of steps"
    ),
  }),
  "serial-send": z.object({
    type: z.literal("serial-send"),
    board: z
      .string({ error: "serial needs a board id" })
      .min(1, "serial needs a board id")
      .max(64, "serial needs a board id"),
    text: z.string({ error: SERIAL_TEXT }).max(SERIAL_TEXT_MAX, SERIAL_TEXT),
    nonce: nonce.optional(),
  }),
  timeline: z
    .object({
      type: z.literal("timeline"),
      from: time("timeline needs a start time"),
      to: z.number({ error: "timeline needs an end time" }),
      maxPoints: whole("timeline needs a point count").min(
        1,
        "timeline needs a point count"
      ),
      tracks: z
        .array(z.string({ error: TRACKS }).max(256, TRACKS), { error: TRACKS })
        .max(64, TRACKS)
        .optional(),
    })
    // `when` keeps this check running beside a bad `maxPoints`; the
    // field order in `firstIssue` then decides which one is reported.
    .refine(
      (row) =>
        typeof row.from !== "number" ||
        typeof row.to !== "number" ||
        row.to >= row.from,
      {
        error: "timeline needs an end time",
        path: ["to"],
        when: () => true,
      }
    ),
  seek: z.object({
    type: z.literal("seek"),
    t: time("seek needs a time"),
    nonce,
  }),
  undo: z.object({ type: z.literal("undo"), part: part.optional() }),
  redo: z.object({ type: z.literal("redo"), part: part.optional() }),
  histories: z.object({ type: z.literal("histories") }),
  capture: z.object({
    type: z.literal("capture"),
    nonce,
    path: z
      .string({ error: "capture needs an instance path" })
      .max(256, "capture needs an instance path"),
    axis: z.enum(["behaviour", "body"], {
      error: "capture axis must be behaviour or body",
    }),
  }),
  "capture-abort": z.object({ type: z.literal("capture-abort"), nonce }),
  edit: z
    .object({
      type: z.literal("edit"),
      ops: z
        .array(z.unknown(), { error: "edit needs operations" })
        .min(1, "edit needs operations"),
      label: z.string({ error: "edit label must be a string" }).optional(),
      part: part.optional(),
      confirm: z
        .literal("break", { error: "confirm must be break" })
        .optional(),
    })
    // The ops are read last, after the fields around them, and once: the
    // handler downstream trusts them.
    .transform((row, ctx): Omit<typeof row, "ops"> & { ops: EditOp[] } => {
      const ops: EditOp[] = [];
      for (const item of row.ops) {
        const read = readEditOp(item);
        if ("error" in read) {
          ctx.addIssue({ code: "custom", message: read.error });
          return z.NEVER;
        }
        ops.push(read);
      }
      return { ...row, ops };
    }),
} as const;

type ClientType = keyof typeof schemas;

function isClientType(type: unknown): type is ClientType {
  return typeof type === "string" && Object.hasOwn(schemas, type);
}

/**
 * The refusal that names the first field in the schema's order. A check
 * across two fields (a timeline that ends before it starts) is reported
 * after the fields it reads, so it would otherwise hide an earlier one.
 */
function firstIssue(
  schema: (typeof schemas)[ClientType],
  issues: z.core.$ZodIssue[]
): string {
  const order = "shape" in schema ? Object.keys(schema.shape) : [];
  const rank = (issue: z.core.$ZodIssue) => {
    const at = order.indexOf(String(issue.path[0]));
    return at < 0 ? order.length : at;
  };
  const first = issues.reduce((best, issue) =>
    rank(issue) < rank(best) ? issue : best
  );
  return first.message;
}

/**
 * An edit request read by the socket's own `edit` schema. The agent's
 * `world_edit` tool reads its ops here too, so both paths refuse the
 * same input with the same sentence.
 */
export function parseEditRequest(
  value: unknown
): z.output<typeof schemas.edit> | { error: string } {
  const read = schemas.edit.safeParse(value);
  if (read.success) return read.data;
  return { error: firstIssue(schemas.edit, read.error.issues) };
}

/** A message the socket refused. `refuses` and `board` say who is told. */
export type ParseFailure =
  | { error: string }
  | { error: string; refuses: "edit" | "undo" | "redo"; part?: string }
  | { error: string; kind: "board"; board: string; nonce?: string }
  | { error: string; kind: "capture"; nonce: string };

export function parseWorldClient(
  raw: string
): WorldClientMessage | ParseFailure {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { error: "message is not JSON" };
  }
  if (!value || typeof value !== "object") {
    return { error: "message is not an object" };
  }
  const row = value as { type?: unknown; board?: unknown; nonce?: unknown };
  if (!isClientType(row.type)) return { error: "unknown world message" };
  // One schema per type: the `type` has picked it, so the result is that
  // schema's output, which is a member of the union.
  const schema = schemas[row.type];
  const read = schema.safeParse(value);
  if (read.success) return read.data as WorldClientMessage;
  const error = firstIssue(schema, read.error.issues);
  if (row.type === "serial-send") {
    return {
      error,
      kind: "board",
      board: typeof row.board === "string" ? row.board : "",
      ...(nonce.safeParse(row.nonce).success
        ? { nonce: row.nonce as string }
        : {}),
    };
  }
  if (row.type === "capture" && nonce.safeParse(row.nonce).success) {
    return { error, kind: "capture", nonce: row.nonce as string };
  }
  if (row.type === "edit" || row.type === "undo" || row.type === "redo") {
    const partId = (value as { part?: unknown }).part;
    return {
      error,
      refuses: row.type,
      ...(typeof partId === "string" ? { part: partId } : {}),
    };
  }
  return { error };
}

export function editRefused(
  kind: "edit" | "undo" | "redo",
  message: string,
  extra: { part?: string; refusal?: EditRefusal } = {}
): WorldServerMessage {
  return {
    type: "edit-refused",
    kind,
    ...(extra.part ? { part: extra.part } : {}),
    message,
    ...(extra.refusal ? { refusal: extra.refusal } : {}),
  };
}

/** The reply to a message that did not parse. */
export function parseFailureReply(failure: ParseFailure): WorldServerMessage {
  if ("kind" in failure && failure.kind === "capture") {
    return {
      type: "capture-failed",
      nonce: failure.nonce,
      message: failure.error,
    };
  }
  if ("kind" in failure) {
    return {
      type: "board-error",
      board: failure.board,
      message: failure.error,
      ...(failure.nonce ? { nonce: failure.nonce } : {}),
    };
  }
  if ("refuses" in failure) {
    return editRefused(failure.refuses, failure.error, {
      part: failure.part,
    });
  }
  return { type: "error", errors: [], message: failure.error };
}
