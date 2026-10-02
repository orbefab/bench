/** Serial to and from a board: the ring tails, the rx book, and delivery. */

import {
  SERIAL_TEXT_MAX,
  type WorldSender,
  type WorldServerMessage,
} from "@sfab-bench/contract";
import {
  RX_BACKLOG,
  type SerialPage,
  SerialRing,
} from "@sfab-bench/engine-mcu";
import { BOARD_ID, type Doc, type Sub } from "./doc";
import { post } from "./lifecycle";
import { broadcast, docKey, docs } from "./registry";

export function ringOf(doc: Doc, board: string): SerialRing {
  let ring = doc.serial.get(board);
  if (!ring) {
    ring = new SerialRing();
    doc.serial.set(board, ring);
  }
  return ring;
}

export function sendSerialTails(sub: Sub, doc: Doc) {
  for (const id of Object.keys(doc.lastState?.boards ?? {})) {
    const ring = doc.serial.get(id);
    if (!ring || ring.next === 0) continue;
    const page = ring.tail(SERIAL_TEXT_MAX);
    if (!page.text) continue;
    sub.delivered = true;
    sub.onEvent(
      structuredClone({
        type: "serial",
        board: id,
        text: page.text,
        next: page.next,
      } satisfies WorldServerMessage)
    );
  }
}

export function resetSerial(doc: Doc) {
  doc.serial = new Map();
  doc.rx = new Map();
  doc.rxSent = new Map();
}

export function clearRxBook(doc: Doc, board: string) {
  doc.rx.delete(board);
  doc.rxSent.delete(board);
}

function rejectSerial(
  doc: Doc,
  board: string,
  message: string,
  nonce?: string
): { error: string } {
  broadcast(doc, {
    type: "board-error",
    board,
    message,
    ...(nonce ? { nonce } : {}),
  });
  return { error: message };
}

export function deliverSerial(
  doc: Doc,
  sender: WorldSender,
  board: string,
  text: string,
  nonce?: string
): { ok: true } | { error: string } {
  const reject = (message: string) => rejectSerial(doc, board, message, nonce);
  if (!doc.worker || !doc.lastState) return reject("world is not running");
  if (doc.errors && doc.errors.length > 0) {
    return reject(doc.errorMessage ?? "world failed to load");
  }
  if (!BOARD_ID.test(board)) return reject("serial needs a board id");
  if (text.length > SERIAL_TEXT_MAX) {
    return reject(`serial text is longer than ${SERIAL_TEXT_MAX} characters`);
  }
  if (text.length === 0) return reject("serial text is empty");
  const info = doc.lastState.boards[board];
  if (!info) return reject(`no board "${board}"`);
  if (!info.running) {
    const why = info.fault ? `: ${info.fault}` : "";
    return reject(`board "${board}" is stopped${why}`);
  }
  const sent = doc.rxSent.get(board) ?? 0;
  const accepted = doc.rx.get(board)?.accepted ?? 0;
  const queued = Math.max(0, sent - accepted);
  const bytes = new TextEncoder().encode(text).length;
  if (queued + bytes > RX_BACKLOG) return reject("serial input is full");
  doc.rxSent.set(board, sent + bytes);
  post(doc, {
    type: "serialIn",
    board,
    text,
    generation: doc.generation,
    by: sender,
  });
  broadcast(doc, {
    type: "serial-sent",
    board,
    text,
    by: sender,
    ...(nonce ? { nonce } : {}),
  });
  return { ok: true };
}

export function readSerial(
  project: string,
  worldRel: string,
  board: string,
  from = 0
): SerialPage | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.worker || !doc.lastState) return { error: "world is not running" };
  if (!doc.lastState.boards[board]) return { error: `no board "${board}"` };
  const ring = doc.serial.get(board);
  if (!ring) return { text: "", next: 0 };
  return ring.read(from);
}

export function sendSerial(
  project: string,
  worldRel: string,
  board: string,
  text: string,
  sender: WorldSender,
  nonce?: string
): { ok: true } | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc) return { error: "world is not running" };
  return deliverSerial(doc, sender, board, text, nonce);
}

/** Test-only. Bytes waiting on USART0 RX, and how many have been accepted. */
export function boardRx(
  project: string,
  worldRel: string,
  board: string
): { queued: number; accepted: number } | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.lastState) return { error: "world is not running" };
  if (!doc.lastState.boards[board]) return { error: `no board "${board}"` };
  return doc.rx.get(board) ?? { queued: 0, accepted: 0 };
}
