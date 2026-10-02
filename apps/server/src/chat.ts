import type {
  HarnessAgentResumeSessionState,
  HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import {
  type ChatEffort,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_MODEL,
  emptySnapshot,
  type HarnessId,
  isChatEffort,
  isHarnessId,
  type ViewerSnapshot,
} from "@sfab-bench/contract";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { getAgent } from "./agent";
import { mergePersistedTurn, withTurnError } from "./chat-persist";
import {
  dropTrailingHarnessErrors,
  harnessErrorsAsTurnParts,
  harnessErrorText,
} from "./chat-stream";
import { ensureProvisioned } from "./provisioning";
import { endSessionRun, rememberOpenedFile, startSessionRun } from "./session";
import {
  isResumePayload,
  isUnusableResumeError,
  LOST_CONTEXT_LINE,
  lostContext,
  nativeIdFromResume,
  resumeFromStored,
  shouldPersistPark,
  stripResumeCredentials,
} from "./thread-sessions";
import {
  dropThreadSession,
  loadThreadSession,
  saveMessages,
  saveThreadSession,
} from "./threads-db";
import { runViewerContext } from "./viewer-context";

const sessions = new Map<string, Promise<HarnessAgentSession>>();

function sessionKey(root: string, harness: HarnessId, chatId: string) {
  return `${root}:${harness}:${chatId}`;
}

export const NO_UNFINISHED_TURN = "no unfinished turn";

export function isFillRequest(last: UIMessage): boolean {
  return last.role !== "user";
}

/** Gate before the harness: UI shape is not enough. */
export function admitChatTurn(input: {
  lastRole: UIMessage["role"];
  liveUnfinished: boolean;
}): "prompt" | "fill" | "reject" {
  if (input.lastRole === "user") return "prompt";
  return input.liveUnfinished ? "fill" : "reject";
}

export function priorMessages(
  fill: boolean,
  bodyMessages: UIMessage[],
  stamped: UIMessage
): UIMessage[] {
  // A fill carries the client tool result on the last assistant message. A
  // prompt is the last user message only: the harness session already owns
  // prior turns.
  return fill ? bodyMessages : [stamped];
}

function persistChat(chatId: string, next: UIMessage[], root: string) {
  try {
    const ok = saveMessages(chatId, root, next);
    if (!ok) console.error("[chat] persist skipped (no thread)", chatId);
  } catch (err) {
    console.error("[chat] persist failed", err);
  }
}

async function createLiveSession(
  root: string,
  harness: HarnessId,
  chatId: string,
  effort: ChatEffort,
  resumeFrom?: HarnessAgentResumeSessionState
) {
  return getAgent(harness, effort, root).createSession({
    sessionId: chatId,
    ...(resumeFromStored(resumeFrom) as {
      resumeFrom?: HarnessAgentResumeSessionState;
    }),
  });
}

async function sessionFor(
  root: string,
  harness: HarnessId,
  chatId: string,
  effort: ChatEffort
): Promise<{ session: HarnessAgentSession; lostContext: boolean }> {
  const key = sessionKey(root, harness, chatId);
  const pending = sessions.get(key);
  if (pending) return { session: await pending, lostContext: false };

  const stored = loadThreadSession(chatId, harness);
  let resumeFrom: HarnessAgentResumeSessionState | undefined;
  let lost = false;
  if (stored) {
    if (!isResumePayload(stored.state)) {
      dropThreadSession(chatId, harness);
      lost = true;
    } else {
      resumeFrom = stored.state as HarnessAgentResumeSessionState;
    }
  }

  const start = async () => {
    if (!resumeFrom) return createLiveSession(root, harness, chatId, effort);
    try {
      return await createLiveSession(root, harness, chatId, effort, resumeFrom);
    } catch (err) {
      if (!isUnusableResumeError(err)) throw err;
      dropThreadSession(chatId, harness);
      lost = true;
      return createLiveSession(root, harness, chatId, effort);
    }
  };

  const promise = start().catch((err) => {
    sessions.delete(key);
    throw err;
  });
  sessions.set(key, promise);
  return { session: await promise, lostContext: lost };
}

type ChatBody = {
  id?: string;
  messages: UIMessage[];
  viewerFile?: string;
  viewer?: ViewerSnapshot;
  model?: string;
  harness?: string;
  effort?: string;
};

function stampUser(last: UIMessage, snapshot: ViewerSnapshot): UIMessage {
  const bits = [`file=${snapshot.file || "(none)"}`];
  if (snapshot.empty) bits.push("empty");
  if (snapshot.selected) bits.push(`selected=${snapshot.selected}`);
  if (typeof snapshot.playing === "boolean") {
    bits.push(snapshot.playing ? "playing" : "paused");
  }
  if (
    typeof snapshot.simTime === "number" &&
    Number.isFinite(snapshot.simTime)
  ) {
    bits.push(`simTime=${snapshot.simTime.toFixed(3)}`);
  }
  const stamp = `[viewer] ${bits.join(" ")}`;
  const parts = last.parts ?? [];
  const texts = parts.filter((p) => p.type === "text");
  if (texts.length === 0)
    return {
      ...last,
      parts: [...parts, { type: "text" as const, text: stamp }],
    };
  let used = false;
  return {
    ...last,
    parts: parts.map((p) => {
      if (p.type !== "text" || used) return p;
      used = true;
      return { ...p, type: "text" as const, text: `${p.text}\n\n${stamp}` };
    }),
  };
}

export async function handleChat(
  req: Request,
  root: string
): Promise<Response> {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const chatId = body.id?.trim();
  if (!chatId) {
    return new Response("missing thread id", { status: 400 });
  }
  const requestedHarness = body.harness || DEFAULT_HARNESS;
  const harness: HarnessId = isHarnessId(requestedHarness)
    ? requestedHarness
    : DEFAULT_HARNESS;
  const requestedEffort = body.effort || DEFAULT_CHAT_EFFORT;
  const effort: ChatEffort = isChatEffort(requestedEffort)
    ? requestedEffort
    : DEFAULT_CHAT_EFFORT;
  const last = body.messages?.at(-1);
  if (!last) {
    return new Response("missing message", { status: 400 });
  }

  const key = sessionKey(root, harness, chatId);
  let fillSession: HarnessAgentSession | undefined;
  if (isFillRequest(last)) {
    const pending = sessions.get(key);
    if (pending) {
      fillSession = await pending;
    }
  }
  const kind = admitChatTurn({
    lastRole: last.role,
    liveUnfinished: Boolean(fillSession?.hasUnfinishedTurn()),
  });
  if (kind === "reject") {
    return new Response(NO_UNFINISHED_TURN, { status: 409 });
  }
  if (kind === "prompt") {
    // First use installs the harness bridge. Wait for it here, so a failed
    // install is a plain send failure with the prompt kept, not a dead turn.
    const installFailed = await ensureProvisioned(root, harness);
    if (installFailed) return new Response(installFailed, { status: 503 });
  }

  // That wait is the longest gap in the handler, and `abort` does not replay
  // for a listener added afterwards — so a stop during the install would
  // otherwise be dropped and start a turn nobody is waiting for, locking the
  // folder to 409 until it ends. We drop out here instead of passing the
  // signal into the install: the install is shared, and one folder giving up
  // must not cancel it for another.
  if (req.signal.aborted) return new Response(null, { status: 499 });

  const run = startSessionRun(root);
  if (!run) {
    return new Response("a reply is already in progress", { status: 409 });
  }
  req.signal.addEventListener("abort", () => run.abort());

  const snapshot: ViewerSnapshot =
    body.viewer ?? emptySnapshot(body.viewerFile ?? "");
  const stamped = kind === "fill" ? last : stampUser(last, snapshot);
  const history = body.messages.slice(0, -1);
  const live = [...history, last];

  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      // A fill's last message is the assistant that is waiting on a client
      // tool. Reusing its id makes the continuation extend that message
      // instead of starting a second one.
      originalMessages: body.messages,
      execute: async ({ writer }) => {
        let session: HarnessAgentSession | undefined;
        try {
          await runViewerContext(
            {
              root,
              file: snapshot.file,
              snapshot,
              show: (file) => {
                rememberOpenedFile(file, root);
                writer.write({ type: "data-viewer", data: { file } });
              },
            },
            async () => {
              const agent = getAgent(harness, effort, root);
              let lost = false;
              if (kind === "fill") {
                session = fillSession;
              } else {
                const resolved = await sessionFor(
                  root,
                  harness,
                  chatId,
                  effort
                );
                session = resolved.session;
                lost = resolved.lostContext;
              }
              if (!session) {
                throw new Error("missing harness session");
              }
              if (lost) {
                writer.write({
                  type: "data-error",
                  data: { message: LOST_CONTEXT_LINE },
                });
              }
              const model =
                typeof body.model === "string" && body.model.trim()
                  ? body.model.trim()
                  : DEFAULT_HARNESS_MODEL[harness];
              const prior = priorMessages(
                kind === "fill",
                body.messages,
                stamped
              );
              const result = await agent.stream({
                session,
                messages: await convertToModelMessages(prior),
                options: { model },
                abortSignal: run.signal,
              });
              const ui = harnessErrorsAsTurnParts(
                toUIMessageStream({
                  stream: dropTrailingHarnessErrors(
                    result.stream as never
                  ) as never,
                  onError: harnessErrorText,
                }) as never
              );
              writer.merge(ui as never);
              try {
                await result.text;
              } catch {
                /* stream failed; idle-check below still applies */
              }
            }
          );

          if (!session || run.signal.aborted) return;
          const unfinished = session.hasUnfinishedTurn();
          writer.write({
            type: "data-turn",
            data: { state: unfinished ? "suspended" : "idle" },
          });
          // Client tools (get_viewer, ask) leave the live handle in the Map.
          if (unfinished) return;
          let payload: HarnessAgentResumeSessionState;
          try {
            payload = await session.detach();
          } finally {
            sessions.delete(key);
          }
          if (
            !shouldPersistPark({
              unfinished: false,
              aborted: run.signal.aborted,
              continueFrom: payload.continueFrom,
            })
          ) {
            return;
          }
          const stripped = stripResumeCredentials(payload);
          const nextNative = nativeIdFromResume(harness, stripped);
          const prev = loadThreadSession(chatId, harness);
          saveThreadSession(chatId, root, harness, stripped, nextNative);
          if (lostContext(prev?.native_id, nextNative)) {
            writer.write({
              type: "data-error",
              data: { message: LOST_CONTEXT_LINE },
            });
          }
        } catch (err) {
          if (!run.signal.aborted) {
            writer.write({
              type: "data-error",
              data: { message: harnessErrorText(err) },
            });
          }
        } finally {
          endSessionRun(root);
        }
      },
      onFinish: ({ responseMessage, isAborted, outcome, isContinuation }) => {
        if (isAborted && (responseMessage.parts ?? []).length === 0) {
          persistChat(chatId, live, root);
          return;
        }
        const response =
          outcome.status === "failed"
            ? withTurnError(responseMessage, harnessErrorText(outcome.error))
            : responseMessage;
        persistChat(
          chatId,
          mergePersistedTurn(live, response, isContinuation),
          root
        );
      },
      onError: harnessErrorText,
    }),
  });
}
