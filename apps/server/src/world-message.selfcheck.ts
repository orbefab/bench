/**
 * The world socket's client messages: what parses, and the exact text of
 * every refusal. The table was taken from the hand-written parser, so a
 * schema that words one differently fails here.
 */
import { ok as expect } from "node:assert/strict";
import { SERIAL_TEXT_MAX, WORLD_NONCE_MAX } from "@sfab-bench/contract";

import { parseWorldClient } from "./world/live-message";

const SERIAL_TEXT_ERROR = `serial text must be a string of at most ${SERIAL_TEXT_MAX} characters`;

const op = (extra: Record<string, unknown> = {}) => ({
  kind: "set-pose",
  document: "w.json",
  id: "a",
  pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
  ...extra,
});

const longNonce = "n".repeat(WORLD_NONCE_MAX + 1);
const okNonce = "n".repeat(WORLD_NONCE_MAX);

/** raw text → the whole parse result, as JSON. */
const cases: [string, string, unknown][] = [
  ["not json", "{", { error: "message is not JSON" }],
  ["a number", "5", { error: "message is not an object" }],
  ["null", "null", { error: "message is not an object" }],
  ["a string", '"play"', { error: "message is not an object" }],
  ["an array", "[]", { error: "unknown world message" }],
  ["no type", "{}", { error: "unknown world message" }],
  [
    "a type from the prototype",
    '{"type":"constructor"}',
    {
      error: "unknown world message",
    },
  ],
  ["an unknown type", '{"type":"jump"}', { error: "unknown world message" }],

  ["play", '{"type":"play"}', { type: "play" }],
  [
    "pause with a nonce",
    '{"type":"pause","nonce":"a"}',
    {
      type: "pause",
      nonce: "a",
    },
  ],
  [
    "play with a long nonce",
    JSON.stringify({ type: "play", nonce: longNonce }),
    {
      error: "nonce must be a short string",
    },
  ],
  [
    "play with the longest nonce",
    JSON.stringify({ type: "play", nonce: okNonce }),
    {
      type: "play",
      nonce: okNonce,
    },
  ],
  [
    "play with an empty nonce",
    '{"type":"play","nonce":""}',
    {
      error: "nonce must be a short string",
    },
  ],
  [
    "play with a numeric nonce",
    '{"type":"play","nonce":3}',
    {
      error: "nonce must be a short string",
    },
  ],

  ["step", '{"type":"step","n":3}', { type: "step", n: 3 }],
  ["step zero", '{"type":"step","n":0}', { type: "step", n: 0 }],
  [
    "step negative",
    '{"type":"step","n":-1}',
    {
      error: "step needs a whole number of steps",
    },
  ],
  [
    "step fractional",
    '{"type":"step","n":1.5}',
    {
      error: "step needs a whole number of steps",
    },
  ],
  [
    "step text",
    '{"type":"step","n":"3"}',
    {
      error: "step needs a whole number of steps",
    },
  ],
  [
    "step none",
    '{"type":"step"}',
    {
      error: "step needs a whole number of steps",
    },
  ],

  [
    "serial",
    '{"type":"serial-send","board":"uno","text":"hi"}',
    {
      type: "serial-send",
      board: "uno",
      text: "hi",
    },
  ],
  [
    "serial with a nonce",
    '{"type":"serial-send","board":"uno","text":"","nonce":"a"}',
    {
      type: "serial-send",
      board: "uno",
      text: "",
      nonce: "a",
    },
  ],
  [
    "serial without a board",
    '{"type":"serial-send","text":"hi","nonce":"a"}',
    {
      error: "serial needs a board id",
      kind: "board",
      board: "",
      nonce: "a",
    },
  ],
  [
    "serial with an empty board",
    '{"type":"serial-send","board":"","text":"hi"}',
    {
      error: "serial needs a board id",
      kind: "board",
      board: "",
    },
  ],
  [
    "serial with a long board",
    JSON.stringify({ type: "serial-send", board: "b".repeat(65), text: "hi" }),
    {
      error: "serial needs a board id",
      kind: "board",
      board: "b".repeat(65),
    },
  ],
  [
    "serial with a numeric board",
    '{"type":"serial-send","board":4,"text":"hi"}',
    {
      error: "serial needs a board id",
      kind: "board",
      board: "",
    },
  ],
  [
    "serial without text",
    '{"type":"serial-send","board":"uno","nonce":"a"}',
    {
      error: SERIAL_TEXT_ERROR,
      kind: "board",
      board: "uno",
      nonce: "a",
    },
  ],
  [
    "serial with long text",
    JSON.stringify({
      type: "serial-send",
      board: "uno",
      text: "t".repeat(SERIAL_TEXT_MAX + 1),
    }),
    {
      error: SERIAL_TEXT_ERROR,
      kind: "board",
      board: "uno",
    },
  ],
  [
    "serial with a bad nonce",
    '{"type":"serial-send","board":"uno","text":"x","nonce":9}',
    {
      error: "nonce must be a short string",
      kind: "board",
      board: "uno",
    },
  ],
  [
    "serial with a bad board and a bad nonce",
    '{"type":"serial-send","board":"","text":"x","nonce":9}',
    { error: "serial needs a board id", kind: "board", board: "" },
  ],

  [
    "timeline",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10}',
    {
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
    },
  ],
  [
    "timeline of one instant",
    '{"type":"timeline","from":1,"to":1,"maxPoints":1}',
    {
      type: "timeline",
      from: 1,
      to: 1,
      maxPoints: 1,
    },
  ],
  [
    "timeline with tracks",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10,"tracks":["a.b"]}',
    { type: "timeline", from: 0, to: 2, maxPoints: 10, tracks: ["a.b"] },
  ],
  [
    "timeline with no tracks",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10,"tracks":[]}',
    {
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
      tracks: [],
    },
  ],
  [
    "timeline without a start",
    '{"type":"timeline","to":2,"maxPoints":10}',
    {
      error: "timeline needs a start time",
    },
  ],
  [
    "timeline with a negative start",
    '{"type":"timeline","from":-1,"to":2,"maxPoints":10}',
    {
      error: "timeline needs a start time",
    },
  ],
  [
    "timeline ending early",
    '{"type":"timeline","from":2,"to":1,"maxPoints":10}',
    {
      error: "timeline needs an end time",
    },
  ],
  [
    "timeline without an end",
    '{"type":"timeline","from":0,"maxPoints":10}',
    {
      error: "timeline needs an end time",
    },
  ],
  [
    "timeline ending early with no point count",
    '{"type":"timeline","from":2,"to":1}',
    { error: "timeline needs an end time" },
  ],
  [
    "timeline with no points",
    '{"type":"timeline","from":0,"to":2,"maxPoints":0}',
    {
      error: "timeline needs a point count",
    },
  ],
  [
    "timeline with half a point",
    '{"type":"timeline","from":0,"to":2,"maxPoints":1.5}',
    {
      error: "timeline needs a point count",
    },
  ],
  [
    "timeline with a bad start and end",
    '{"type":"timeline","from":"a","to":"b","maxPoints":2}',
    {
      error: "timeline needs a start time",
    },
  ],
  [
    "timeline tracks that are not a list",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10,"tracks":"a"}',
    { error: "timeline tracks must be a short list of port ids" },
  ],
  [
    "timeline tracks that are null",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10,"tracks":null}',
    { error: "timeline tracks must be a short list of port ids" },
  ],
  [
    "timeline with a numeric track",
    '{"type":"timeline","from":0,"to":2,"maxPoints":10,"tracks":[1]}',
    { error: "timeline tracks must be a short list of port ids" },
  ],
  [
    "timeline with a long track",
    JSON.stringify({
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
      tracks: ["t".repeat(257)],
    }),
    { error: "timeline tracks must be a short list of port ids" },
  ],
  [
    "timeline with too many tracks",
    JSON.stringify({
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
      tracks: Array.from({ length: 65 }, () => "t"),
    }),
    { error: "timeline tracks must be a short list of port ids" },
  ],
  [
    "timeline with 64 tracks",
    JSON.stringify({
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
      tracks: Array.from({ length: 64 }, () => "t"),
    }),
    {
      type: "timeline",
      from: 0,
      to: 2,
      maxPoints: 10,
      tracks: Array.from({ length: 64 }, () => "t"),
    },
  ],

  [
    "seek",
    '{"type":"seek","t":1.5,"nonce":"a"}',
    {
      type: "seek",
      t: 1.5,
      nonce: "a",
    },
  ],
  [
    "seek without a time",
    '{"type":"seek","nonce":"a"}',
    {
      error: "seek needs a time",
    },
  ],
  [
    "seek to a negative time",
    '{"type":"seek","t":-1,"nonce":"a"}',
    {
      error: "seek needs a time",
    },
  ],
  [
    "seek without a nonce",
    '{"type":"seek","t":1}',
    {
      error: "nonce must be a short string",
    },
  ],
  [
    "seek with no time and no nonce",
    '{"type":"seek"}',
    {
      error: "seek needs a time",
    },
  ],

  ["undo", '{"type":"undo"}', { type: "undo" }],
  [
    "redo of a part",
    '{"type":"redo","part":"sfab/x@1.0.0"}',
    {
      type: "redo",
      part: "sfab/x@1.0.0",
    },
  ],
  [
    "undo with a numeric part",
    '{"type":"undo","part":3}',
    {
      error: "part must be a part id",
      refuses: "undo",
    },
  ],
  [
    "redo with a numeric part",
    '{"type":"redo","part":3}',
    {
      error: "part must be a part id",
      refuses: "redo",
    },
  ],
  ["histories", '{"type":"histories"}', { type: "histories" }],

  [
    "an edit",
    JSON.stringify({ type: "edit", ops: [op()] }),
    {
      type: "edit",
      ops: [op()],
    },
  ],
  [
    "an edit with a label, a part and a confirm",
    JSON.stringify({
      type: "edit",
      ops: [op()],
      label: "Move a",
      part: "sfab/x@1.0.0",
      confirm: "break",
    }),
    {
      type: "edit",
      ops: [op()],
      label: "Move a",
      part: "sfab/x@1.0.0",
      confirm: "break",
    },
  ],
  [
    "an edit with no ops",
    '{"type":"edit"}',
    {
      error: "edit needs operations",
      refuses: "edit",
    },
  ],
  [
    "an edit with an empty list",
    '{"type":"edit","ops":[]}',
    {
      error: "edit needs operations",
      refuses: "edit",
    },
  ],
  [
    "an edit with ops that are not a list",
    '{"type":"edit","ops":{}}',
    {
      error: "edit needs operations",
      refuses: "edit",
    },
  ],
  [
    "an edit with a numeric label",
    JSON.stringify({ type: "edit", ops: [op()], label: 5 }),
    { error: "edit label must be a string", refuses: "edit" },
  ],
  [
    "an edit with a numeric part",
    JSON.stringify({ type: "edit", ops: [op()], part: 5 }),
    { error: "part must be a part id", refuses: "edit" },
  ],
  [
    "an edit with a confirm that is not break",
    JSON.stringify({ type: "edit", ops: [op()], confirm: "yes" }),
    { error: "confirm must be break", refuses: "edit" },
  ],
  [
    "an edit with a bad label and a bad op",
    JSON.stringify({ type: "edit", ops: [{}], label: 5 }),
    { error: "edit label must be a string", refuses: "edit" },
  ],
  [
    "an edit with a bad part and a bad label",
    JSON.stringify({ type: "edit", ops: [op()], label: 5, part: 5 }),
    { error: "edit label must be a string", refuses: "edit" },
  ],
  [
    "an edit with an op that is not an object",
    JSON.stringify({ type: "edit", ops: [3] }),
    { error: "edit is not an operation", refuses: "edit" },
  ],
  [
    "an edit with an op that has no document",
    JSON.stringify({ type: "edit", ops: [{ kind: "set-pose" }] }),
    { error: "edit needs a document", refuses: "edit" },
  ],
  [
    "an edit with a bad confirm on an op",
    JSON.stringify({ type: "edit", ops: [op({ confirm: "no" })] }),
    { error: "confirm must be break", refuses: "edit" },
  ],
  [
    "an edit with a break on an op",
    JSON.stringify({ type: "edit", ops: [op({ confirm: "break" })] }),
    { type: "edit", ops: [op({ confirm: "break" })] },
  ],
];

for (const [name, raw, want] of cases) {
  const got = parseWorldClient(raw);
  expect(
    JSON.stringify(sorted(got)) === JSON.stringify(sorted(want)),
    `${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`
  );
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)])
    );
  }
  return value;
}

console.log(`world-message.selfcheck ok (${cases.length} messages)`);
