import { Container, Text, Textarea } from "@react-three/uikit";
import {
  ChevronDown,
  History,
  Mic,
  Plus,
  Send,
  Square,
} from "@react-three/uikit-lucide";
import { memo, type ReactNode, useRef, useState } from "react";
import {
  type AskUserQuestionsOutput,
  askUserComposerPlaceholder,
  formatAskUserAnswer,
  isAskUserQuestionsPart,
  parseAskUserQuestionsInput,
} from "@/chat/ask-user-questions";
import { turnErrorText } from "@/chat/persist-thread";
import type { AIDataPart } from "@/components/chat/ai-types";
import { splitChatWorkedParts } from "@/components/chat/chat-message-parts";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import {
  messagePlainText,
  useViewerChat,
} from "@/components/chat/useViewerChat";
import { toolTitle } from "@/components/ui/tool";
import { workedLabel } from "@/components/ui/worked";
import { useFirstSetupHint } from "@/hooks/useFirstSetupHint";
import { useHarnesses } from "@/hooks/useHarnesses";
import { ChatModelChip } from "@/xr/ui/ChatModelCard";
import { ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";
import { asciiSafe, UikitMarkdown } from "@/xr/ui/UikitMarkdown";
import { useXrChatScroll, XR_SCROLL_GUTTER } from "@/xr/ui/useXrChatScroll";
import { VoiceRecordRow } from "@/xr/ui/VoiceRecordRow";
import { useXrChatRuntime } from "@/xr/ui/XrChatRuntime";
import { XR_COMPOSER_MAX_H, xrComposerHeight } from "@/xr/ui/xrChatChrome";

function workedDurationSeconds(message: GalleryChatMessage) {
  const n = message.metadata?.responseTime;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return;
  return n / 1000;
}

function XrPlan({ entries }: { entries: AIDataPart["plan"]["entries"] }) {
  const theme = useXrTheme();
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={3}>
      {entries.map((entry, i) => (
        <Text
          key={i}
          fontSize={12}
          color={entry.status === "completed" ? theme.subtle : theme.text}
        >
          {entry.status === "completed" ? "[x] " : "[ ] "}
          {entry.content}
        </Text>
      ))}
    </Container>
  );
}

function dump(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string") return asciiSafe(value);
  try {
    return asciiSafe(JSON.stringify(value));
  } catch {
    return "";
  }
}

function XrToolLine({ part }: { part: GalleryChatMessage["parts"][number] }) {
  const [open, setOpen] = useState(false);
  const toolName =
    "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : part.type.startsWith("tool-")
        ? part.type.slice(5)
        : "tool";
  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const label = toolTitle(toolName, input);
  const inText = dump(input);
  const outText = dump(output);
  const theme = useXrTheme();
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={2}>
      <Container
        flexDirection="row"
        alignItems="center"
        gap={4}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown
          width={12}
          height={12}
          color={theme.subtle}
          transformRotateZ={open ? 0 : 90}
        />
        <Text fontSize={12} color={theme.subtle}>
          {asciiSafe(label)}
        </Text>
      </Container>
      {open ? (
        <Container
          width="100%"
          flexShrink={0}
          flexDirection="column"
          gap={2}
          paddingLeft={16}
        >
          {inText ? (
            <>
              <Text fontSize={11} color={theme.subtle} fontWeight="semi-bold">
                Input
              </Text>
              <Text fontSize={11} color={theme.subtle}>
                {inText}
              </Text>
            </>
          ) : null}
          {outText ? (
            <>
              <Text fontSize={11} color={theme.subtle} fontWeight="semi-bold">
                Output
              </Text>
              <Text fontSize={11} color={theme.subtle}>
                {outText}
              </Text>
            </>
          ) : null}
        </Container>
      ) : null}
    </Container>
  );
}

function XrReasoning({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const streamed = useRef(isStreaming);
  if (isStreaming) streamed.current = true;
  const open = userOpen ?? (isStreaming || streamed.current);
  const theme = useXrTheme();
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={2}>
      <Container
        flexDirection="row"
        alignItems="center"
        gap={4}
        onClick={() => setUserOpen(!open)}
      >
        <ChevronDown
          width={12}
          height={12}
          color={theme.subtle}
          transformRotateZ={open ? 0 : 90}
        />
        <Text fontSize={12} color={theme.subtle}>
          {isStreaming ? "Reasoning..." : "Reasoning"}
        </Text>
      </Container>
      {open ? (
        <Text fontSize={12} color={theme.subtle}>
          {asciiSafe(text)}
        </Text>
      ) : null}
    </Container>
  );
}

function XrWorked({
  children,
  isStreaming,
  duration,
}: {
  children: ReactNode;
  isStreaming: boolean;
  duration?: number;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? isStreaming;
  const theme = useXrTheme();
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={4}>
      <Container
        flexDirection="row"
        alignItems="center"
        gap={4}
        onClick={() => setUserOpen(!open)}
      >
        <ChevronDown
          width={12}
          height={12}
          color={theme.subtle}
          transformRotateZ={open ? 0 : 90}
        />
        <Text fontSize={12} color={theme.subtle}>
          {workedLabel({ isStreaming, duration })}
        </Text>
      </Container>
      {open ? (
        <Container width="100%" flexShrink={0} flexDirection="column" gap={4}>
          {children}
        </Container>
      ) : null}
    </Container>
  );
}

function XrAskUserQuestions({
  part,
}: {
  part: GalleryChatMessage["parts"][number];
}) {
  const theme = useXrTheme();
  const input = parseAskUserQuestionsInput(
    "input" in part ? part.input : undefined
  );
  const pending =
    "state" in part &&
    (part.state === "input-available" || part.state === "input-streaming");
  if (!input) return <XrToolLine part={part} />;
  if (pending) return null;
  const summary = formatAskUserAnswer(
    input,
    "output" in part ? part.output : undefined
  );
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={2}>
      <Text fontSize={11} color={theme.subtle}>
        {asciiSafe(input.questions[0]?.header ?? "Question")}
      </Text>
      <Text fontSize={13} color={theme.text}>
        {asciiSafe(summary || "Answered")}
      </Text>
    </Container>
  );
}

function XrAskUserBanner({
  pendingAsk,
  onAnswer,
}: {
  pendingAsk: NonNullable<ReturnType<typeof useXrChatRuntime>>["pendingAsk"];
  onAnswer: (toolCallId: string, output: AskUserQuestionsOutput) => void;
}) {
  const theme = useXrTheme();
  if (!pendingAsk) return null;
  const question = pendingAsk.input.questions[0];
  if (!question) return null;
  return (
    <Container
      width="100%"
      flexShrink={0}
      flexDirection="column"
      gap={4}
      padding={8}
      borderRadius={8}
      backgroundColor={theme.muted}
    >
      <Text fontSize={11} color={theme.subtle}>
        {asciiSafe(question.header ?? "Question")}
      </Text>
      <Text fontSize={13} color={theme.text}>
        {asciiSafe(question.question)}
      </Text>
      {question.options.map((option) => (
        <Container
          key={option.id}
          width="100%"
          flexShrink={0}
          padding={8}
          borderRadius={8}
          backgroundColor={theme.card}
          onClick={() =>
            onAnswer(pendingAsk.toolCallId, {
              action: "answered",
              answers: { [question.id]: { optionIds: [option.id] } },
            })
          }
        >
          <Text fontSize={13} color={theme.text}>
            {asciiSafe(option.label)}
          </Text>
        </Container>
      ))}
    </Container>
  );
}

function XrPart({
  part,
  isStreaming,
}: {
  part: GalleryChatMessage["parts"][number];
  isStreaming?: boolean;
}) {
  const theme = useXrTheme();
  if (part.type === "text" && "text" in part && part.text.trim()) {
    if (isStreaming || ("state" in part && part.state === "streaming")) {
      return (
        <Text fontSize={13} color={theme.text}>
          {asciiSafe(part.text)}
        </Text>
      );
    }
    return <UikitMarkdown markdown={part.text} />;
  }
  const errorText = turnErrorText(part);
  if (errorText) {
    return (
      <Text fontSize={13} color={theme.danger} wordBreak="break-word">
        {asciiSafe(errorText)}
      </Text>
    );
  }
  if (part.type === "reasoning" && "text" in part) {
    return <XrReasoning isStreaming={Boolean(isStreaming)} text={part.text} />;
  }
  if (part.type === "data-plan") {
    return (
      <XrPlan entries={(part as { data: AIDataPart["plan"] }).data.entries} />
    );
  }
  if (isAskUserQuestionsPart(part)) {
    return <XrAskUserQuestions part={part} />;
  }
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    return <XrToolLine part={part} />;
  }
  return null;
}

function XrAssistantParts({
  message,
  isStreaming,
}: {
  message: GalleryChatMessage;
  isStreaming: boolean;
}) {
  const duration = workedDurationSeconds(message);
  return (
    <Container width="100%" flexShrink={0} flexDirection="column" gap={8}>
      {splitChatWorkedParts(message.parts).map((segment) => {
        if (segment.kind === "worked") {
          const start = segment.items[0]?.index ?? 0;
          return (
            <XrWorked
              key={`w-${start}`}
              isStreaming={isStreaming}
              duration={duration}
            >
              {segment.items.map((item) => (
                <XrPart
                  key={item.index}
                  isStreaming={isStreaming}
                  part={item.part}
                />
              ))}
            </XrWorked>
          );
        }
        return (
          <XrPart
            key={segment.item.index}
            isStreaming={isStreaming}
            part={segment.item.part}
          />
        );
      })}
    </Container>
  );
}

const XrMessageRow = memo(
  function XrMessageRow({
    message,
    isStreaming,
  }: {
    message: GalleryChatMessage;
    isStreaming: boolean;
  }) {
    const mine = message.role === "user";
    const text = messagePlainText(message);
    const theme = useXrTheme();
    if (mine && !text) return null;
    return (
      <Container
        width="100%"
        flexShrink={0}
        flexDirection="column"
        alignItems={mine ? "flex-end" : "flex-start"}
      >
        {mine ? (
          <Container
            width="auto"
            maxWidth="80%"
            flexShrink={0}
            alignSelf="flex-end"
            padding={8}
            borderRadius={10}
            backgroundColor={theme.bubble}
          >
            <Text fontSize={13} color={theme.text}>
              {asciiSafe(text)}
            </Text>
          </Container>
        ) : (
          <Container maxWidth="100%" width="100%" flexShrink={0}>
            <XrAssistantParts isStreaming={isStreaming} message={message} />
          </Container>
        )}
      </Container>
    );
  },
  (prev, next) =>
    prev.isStreaming === next.isStreaming &&
    prev.message.id === next.message.id &&
    prev.message.parts === next.message.parts
);

function XrChatSession({
  modelsOpen,
  onToggleModels,
}: {
  modelsOpen: boolean;
  onToggleModels: () => void;
}) {
  const runtime = useXrChatRuntime();
  const catalog = useHarnesses();
  const firstSetupHint = useFirstSetupHint(runtime?.status ?? "ready", catalog);
  const { ref: listRef, atEnd, onScroll, jumpToEnd } = useXrChatScroll();
  const theme = useXrTheme();
  if (!runtime) return null;
  const {
    messages,
    busy,
    error,
    draft,
    setDraft,
    send,
    stop,
    voice,
    answerAskUser,
    pendingAsk,
  } = runtime;
  const lockSend = Boolean(
    pendingAsk && !pendingAsk.input.questions[0]?.allowFreeForm
  );
  const submit = () => {
    send();
    jumpToEnd();
  };
  const composerH = xrComposerHeight(draft);

  return (
    <>
      <Container
        flexGrow={1}
        minHeight={0}
        width="100%"
        positionType="relative"
      >
        <Container
          ref={listRef}
          flexGrow={1}
          minHeight={0}
          width="100%"
          overflow="scroll"
          gap={6}
          flexDirection="column"
          paddingTop={4}
          paddingRight={XR_SCROLL_GUTTER}
          onScroll={onScroll}
        >
          {messages.length === 0 ? (
            <Text fontSize={13} color={theme.subtle}>
              Ask for a CAD change. Try "What am I looking at?" then a size
              change.
            </Text>
          ) : (
            messages.map((message, mi) => (
              <XrMessageRow
                key={message.id}
                isStreaming={
                  busy && mi === messages.length - 1 && message.role !== "user"
                }
                message={message}
              />
            ))
          )}
          {error ? (
            <Text fontSize={12} color={theme.danger}>
              {error}
            </Text>
          ) : null}
        </Container>
        {!atEnd ? (
          <Container
            positionType="absolute"
            positionBottom={8}
            positionLeft={0}
            positionRight={0}
            alignItems="center"
            pointerEvents="none"
            zIndexOffset={4}
          >
            <Container pointerEvents="auto">
              <ToolBtn
                id="xr-chat-jump"
                icon={ChevronDown}
                tip="Jump to latest"
                grow={false}
                onClick={jumpToEnd}
              />
            </Container>
          </Container>
        ) : null}
      </Container>
      <Container
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={theme.border}
      />
      {pendingAsk ? (
        <XrAskUserBanner pendingAsk={pendingAsk} onAnswer={answerAskUser} />
      ) : null}
      {voice.active ? (
        <VoiceRecordRow
          elapsedMs={voice.elapsedMs}
          error={voice.error}
          level={voice.level}
          recording={voice.recording}
          transcribing={voice.busy}
          onCancel={voice.cancel}
          onComplete={voice.complete}
        />
      ) : (
        <Container
          flexDirection="row"
          flexShrink={0}
          alignItems="flex-end"
          gap={4}
          width="100%"
        >
          <Container
            flexGrow={1}
            minWidth={0}
            height={composerH}
            maxHeight={XR_COMPOSER_MAX_H}
            borderRadius={8}
            backgroundColor={theme.muted}
            paddingX={8}
            paddingY={8}
            overflow="scroll"
          >
            <Textarea
              value={draft}
              onValueChange={(value: string) => setDraft(value)}
              placeholder={
                pendingAsk
                  ? askUserComposerPlaceholder(pendingAsk.input.questions[0])
                  : "Ask for a change..."
              }
              placeholderStyle={{ color: theme.subtle }}
              disabled={busy || lockSend}
              width="100%"
              height="100%"
              fontSize={14}
              color={theme.text}
              wordBreak="break-word"
            />
          </Container>
          <ToolBtn
            id="xr-chat-mic"
            icon={Mic}
            tip={voice.error ?? "Tap to talk"}
            grow={false}
            onClick={() => {
              if (!busy) void voice.start();
            }}
          />
          {busy ? (
            <ToolBtn
              id="xr-chat-stop"
              icon={Square}
              tip="Stop"
              grow={false}
              onClick={() => stop()}
            />
          ) : (
            <ToolBtn
              id="xr-chat-send"
              icon={Send}
              tip="Send"
              grow={false}
              onClick={() => {
                if (!lockSend) submit();
              }}
            />
          )}
        </Container>
      )}
      {voice.error && !voice.active ? (
        <Text fontSize={11} color={theme.danger}>
          {asciiSafe(voice.error)}
        </Text>
      ) : firstSetupHint ? (
        <Text fontSize={11} color={theme.subtle}>
          {asciiSafe(firstSetupHint)}
        </Text>
      ) : null}
      <Container
        flexDirection="row"
        flexShrink={0}
        width="100%"
        justifyContent="flex-start"
      >
        <ChatModelChip active={modelsOpen} onClick={onToggleModels} />
      </Container>
    </>
  );
}

export function ChatCard({
  historyOpen,
  onToggleHistory,
  modelsOpen,
  onToggleModels,
  width = 340,
  height = 520,
}: {
  historyOpen: boolean;
  onToggleHistory: () => void;
  modelsOpen: boolean;
  onToggleModels: () => void;
  width?: number;
  height?: number;
}) {
  const { threads, threadId, newThread } = useViewerChat();
  const active = threads.find((t) => t.id === threadId);
  const theme = useXrTheme();

  return (
    <Container
      width={width}
      height={height}
      padding={8}
      gap={6}
      flexDirection="column"
      backgroundColor={theme.card}
      borderRadius={12}
      pixelSize={0.001}
      pointerEvents="auto"
    >
      <Container
        flexDirection="row"
        flexShrink={0}
        alignItems="center"
        gap={4}
        width="100%"
      >
        <Container
          flexGrow={1}
          minWidth={0}
          flexDirection="row"
          alignItems="center"
          gap={6}
        >
          <Text fontSize={14} color={theme.text} wordBreak="break-word">
            {asciiSafe(active?.title ?? "Assistant")}
          </Text>
        </Container>
        <ToolBtn
          id="xr-chat-history"
          icon={History}
          tip="History"
          grow={false}
          active={historyOpen}
          onClick={onToggleHistory}
        />
        <ToolBtn
          id="xr-chat-new"
          icon={Plus}
          tip="New chat"
          grow={false}
          onClick={() => void newThread()}
        />
      </Container>
      <Container
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={theme.border}
      />
      {threadId ? (
        <XrChatSession
          modelsOpen={modelsOpen}
          onToggleModels={onToggleModels}
        />
      ) : (
        <Container flexGrow={1}>
          <Text fontSize={13} color={theme.subtle}>
            Loading...
          </Text>
        </Container>
      )}
    </Container>
  );
}
