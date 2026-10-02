import type { ChatStatus } from "ai";
import { Hash, Mic } from "lucide-react";
import {
  type MutableRefObject,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type AskUserQuestion,
  type AskUserQuestionsInput,
  type AskUserQuestionsOutput,
  askUserComposerPlaceholder,
} from "@/chat/ask-user-questions";
import {
  CAD_MENTION_FACE_CAP,
  type CadMentionCatalogPart,
  type CadMentionItem,
  cadMentionQueryCloses,
  filterCadMentionCatalog,
  parseCadRefs,
  resolveCadRef,
} from "@/chat/cad-refs";
import {
  COMPOSER_HINT,
  captureSessionDraft,
  composerPlaceholder,
  EMPTY_PROMPT_REASON,
  getSessionDraft,
  providerSendBlockReason,
  sendDisabledReason,
  setSessionDraft,
} from "@/chat/composer-recovery";
import {
  type AskUserQuestionsHandle,
  AskUserQuestionsPanel,
} from "@/components/chat/AskUserQuestionsPanel";
import { Button } from "@/components/ui/button";
import {
  ChatInput,
  ChatInputEditor,
  type ChatInputHandle,
  ChatInputMentionButton,
  ChatInputSubmitButton,
} from "@/components/ui/chat-input";
import { InputGroupAddon } from "@/components/ui/input-group";
import { useFirstSetupHint } from "@/hooks/useFirstSetupHint";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { HARNESS_LABEL } from "@/lib/harness";
import { partLabelFileStem } from "@/lib/part-label";
import {
  compactChatSheetOpen,
  escBelongsTo,
  isEditableTarget,
  probeEscLayers,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";
import { useViewer } from "@/state/viewer";
import { EffortSelect } from "./EffortSelect";
import { ModelPicker } from "./ModelPicker";
import { ProviderStatus } from "./ProviderStatus";
import { VoiceRecordBar } from "./VoiceRecordBar";

export interface GalleryPromptMessage {
  text: string;
}

type HarnessCatalog = ReturnType<typeof useHarnesses>;

function selectedPartFaceOrds(
  parts: { id: number; object: { children: readonly unknown[] } }[] | undefined,
  selectedId: number | null
): { ord: number }[] | undefined {
  if (!parts || selectedId === null) return undefined;
  const part = parts[selectedId];
  if (!part) return undefined;
  const ranges: { ord: number }[] = [];
  for (const child of part.object.children) {
    const geom =
      child && typeof child === "object" && "geometry" in child
        ? (
            child as {
              geometry?: { userData?: { faceRanges?: { ord: number }[] } };
            }
          ).geometry
        : undefined;
    const faceRanges = geom?.userData?.faceRanges;
    if (!Array.isArray(faceRanges)) continue;
    for (const range of faceRanges) {
      if (typeof range?.ord === "number") ranges.push({ ord: range.ord });
    }
  }
  if (ranges.length === 0 || ranges.length > CAD_MENTION_FACE_CAP)
    return undefined;
  return ranges;
}

function PartMentionRow({ item }: { item: CadMentionItem }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{item.name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {item.cadRef}
      </span>
    </span>
  );
}

function outsideChatEditableHasFocus(root: Element | null): boolean {
  const active = document.activeElement;
  if (!isEditableTarget(active)) return false;
  if (active instanceof Node && root?.contains(active)) return false;
  return true;
}

function ChatInputInner({
  disabled,
  onStop,
  onSubmit,
  placeholder,
  status,
  lockSend,
  attached,
  threadId,
  restorePrompt,
  canStop,
  loadingModel,
  sendBlockReason,
  inputRef,
  cancelVoiceRef,
  catalog,
}: {
  disabled: boolean;
  onStop?: () => void;
  onSubmit: (message: GalleryPromptMessage) => void | Promise<void>;
  placeholder: string;
  status: ChatStatus;
  lockSend: boolean;
  attached: boolean;
  threadId: string;
  restorePrompt: string | null;
  canStop: boolean;
  loadingModel: boolean;
  sendBlockReason: string | null;
  inputRef: RefObject<ChatInputHandle | null>;
  cancelVoiceRef: MutableRefObject<() => void>;
  catalog: HarnessCatalog;
}) {
  const draftTouchedRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [draftText, setDraftText] = useState(() => getSessionDraft(threadId));
  const { review, selectedId, title } = useViewer(
    useShallow((s) => ({
      review: s.review,
      selectedId: s.selectedId,
      title: s.title,
    }))
  );
  const catalogParts = useMemo<CadMentionCatalogPart[]>(
    () =>
      (review?.parts ?? [])
        .filter((part): part is typeof part & { cadRef: string } =>
          Boolean(part.cadRef)
        )
        .map((part) => ({ name: part.name, cadRef: part.cadRef })),
    [review]
  );
  const hasCadParts = catalogParts.length > 0;
  const fileStem = partLabelFileStem(review?.parts.length ?? 0, title);
  const selectedPart = useMemo(() => {
    const selectedRaw =
      selectedId !== null ? review?.parts[selectedId] : undefined;
    if (selectedRaw?.cadRef == null) return undefined;
    return { name: selectedRaw.name, cadRef: selectedRaw.cadRef };
  }, [review, selectedId]);
  const faces = useMemo(
    () => selectedPartFaceOrds(review?.parts, selectedId),
    [review, selectedId]
  );
  const mentions = useMemo(
    () => ({
      part: {
        trigger: "#",
        allowSpaces: true,
        queryCloses: cadMentionQueryCloses,
        refsInText: parseCadRefs,
        resolve: (ref: string) => {
          const resolved = resolveCadRef(ref, catalogParts, fileStem);
          if (!resolved) return undefined;
          return {
            id: resolved.ref,
            name: resolved.label,
            cadRef: resolved.ref,
            kind: resolved.kind,
          } satisfies CadMentionItem;
        },
        items: (query: string) => {
          return filterCadMentionCatalog(catalogParts, query, {
            fileStem,
            selectedPart,
            faces,
          }).items;
        },
        render: (item: CadMentionItem) => <PartMentionRow item={item} />,
      },
    }),
    [catalogParts, faces, fileStem, selectedPart]
  );
  const mentionTitle = hasCadParts
    ? "Mention a part (#)"
    : "Open a STEP to mention parts";
  const voice = useVoiceInput((text) => {
    const cur = inputRef.current?.getText() ?? "";
    const next = !cur.trim()
      ? text
      : /[\s\n]$/.test(cur)
        ? `${cur}${text}`
        : `${cur} ${text}`;
    inputRef.current?.setText(next);
    inputRef.current?.focus();
    setDraftText(next);
    captureSessionDraft(threadId, next);
  });
  cancelVoiceRef.current = voice.cancel;

  useEffect(() => {
    if (!voice.active) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const layers = {
        ...probeEscLayers(document),
        compactChat: compactChatSheetOpen(document),
        voice: true,
      };
      if (!escBelongsTo("voice", layers)) return;
      e.preventDefault();
      voice.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice.active, voice.cancel]);

  useEffect(() => {
    if (!restorePrompt) return;
    const cur = inputRef.current?.getText() ?? "";
    if (cur.trim()) return;
    inputRef.current?.setText(restorePrompt);
    setDraftText(restorePrompt);
    captureSessionDraft(threadId, restorePrompt);
    if (outsideChatEditableHasFocus(wrapRef.current)) return;
    inputRef.current?.focus();
  }, [inputRef, restorePrompt, threadId]);

  // A draft restored before the model loaded has plain `#o…` refs; turn them into chips once parts arrive.
  useEffect(() => {
    if (!hasCadParts) return;
    const text = inputRef.current?.getText() ?? "";
    const chips =
      wrapRef.current?.querySelectorAll("[data-mention-suggestion-char]")
        .length ?? 0;
    // setText moves the caret, so only rebuild when some resolvable ref is still plain text.
    const refs = parseCadRefs(text).filter((hit) =>
      resolveCadRef(hit.ref, catalogParts, fileStem)
    );
    if (refs.length > chips) inputRef.current?.setText(text);
  }, [hasCadParts, inputRef]);

  const syncDraft = () => {
    const text = inputRef.current?.getText() ?? "";
    if (text) draftTouchedRef.current = true;
    if (text || draftTouchedRef.current) captureSessionDraft(threadId, text);
    setDraftText(text);
  };

  useLayoutEffect(() => {
    return () => {
      const text = inputRef.current?.getText() ?? "";
      if (text || draftTouchedRef.current) captureSessionDraft(threadId, text);
    };
  }, [inputRef, threadId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const started = Date.now();
    const tryFocus = () => {
      if (cancelled) return;
      if (outsideChatEditableHasFocus(wrapRef.current)) return;
      inputRef.current?.focus();
      if (wrapRef.current?.contains(document.activeElement)) return;
      if (Date.now() - started > 3000) return;
      timer = window.setTimeout(tryFocus, 16);
    };
    tryFocus();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inputRef, threadId]);

  const reason = sendDisabledReason({
    loadingModel,
    lockSend,
    askPlaceholder: placeholder,
    providerReason: sendBlockReason,
  });
  const inFlight = status === "submitted" || status === "streaming";
  const emptyPrompt = !draftText.trim();
  const sendReason =
    inFlight || canStop
      ? null
      : (reason ?? (emptyPrompt ? EMPTY_PROMPT_REASON : null));
  const submitStatus: ChatStatus =
    canStop && status !== "submitted" && status !== "streaming"
      ? "streaming"
      : status;
  const firstSetupHint = useFirstSetupHint(status, catalog);

  const submitButton = (
    <ChatInputSubmitButton
      disabled={inFlight || canStop ? undefined : Boolean(sendReason)}
      title={sendReason ?? "Send"}
    />
  );

  return (
    <div className="w-full" ref={wrapRef}>
      <ChatInput
        className={
          attached
            ? "rounded-none border-0 bg-transparent shadow-none dark:bg-transparent"
            : "rounded-2xl"
        }
        defaultValue={getSessionDraft(threadId)}
        disabled={disabled}
        mentions={mentions}
        onBlur={syncDraft}
        onInput={syncDraft}
        onStop={onStop}
        onSubmit={(parsed, { clear, focus }) => {
          if (voice.active) return;
          const trimmed = parsed.text.trim();
          if (
            !trimmed ||
            inFlight ||
            lockSend ||
            loadingModel ||
            sendBlockReason
          )
            return;
          setSessionDraft(threadId, "");
          setDraftText("");
          draftTouchedRef.current = false;
          clear();
          focus();
          Promise.resolve(onSubmit({ text: trimmed })).catch(() => undefined);
        }}
        ref={inputRef}
        status={submitStatus}
      >
        <ChatInputEditor
          className={voice.active ? "invisible pointer-events-none" : undefined}
          placeholder={placeholder}
        />
        <InputGroupAddon
          align="block-end"
          aria-hidden={voice.active}
          className={cn(
            "flex-wrap gap-y-1 pt-1 @[360px]/chat:flex-nowrap",
            voice.active && "invisible pointer-events-none"
          )}
        >
          <ModelPicker catalog={catalog} />
          <EffortSelect />
          <ChatInputMentionButton
            aria-label="Mention a part (#)"
            disabled={!hasCadParts}
            title={mentionTitle}
            variant="ghost"
          >
            <Hash />
          </ChatInputMentionButton>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={
                lockSend || status === "streaming" || status === "submitted"
              }
              aria-label="Start voice input"
              title={voice.error ?? "Click to talk"}
              onClick={() => void voice.start()}
            >
              <Mic />
            </Button>
            {sendReason ? (
              <span className="inline-flex" title={sendReason}>
                {submitButton}
              </span>
            ) : (
              submitButton
            )}
          </div>
        </InputGroupAddon>
        {voice.active ? (
          <div className="absolute inset-0 z-10">
            <VoiceRecordBar
              elapsedMs={voice.elapsedMs}
              error={voice.error}
              level={voice.level}
              recording={voice.recording}
              transcribing={voice.busy}
              onCancel={voice.cancel}
              onComplete={voice.complete}
            />
          </div>
        ) : null}
      </ChatInput>
      {voice.error && !voice.active ? (
        <p className="px-2 pt-1 text-xs text-error">{voice.error}</p>
      ) : firstSetupHint ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          {firstSetupHint}
        </p>
      ) : null}
    </div>
  );
}

export type GalleryChatHandle = {
  captureDraft: () => void;
  clear: () => void;
  focus: () => void;
  cancelVoice: () => void;
  isReady: () => boolean;
};

export function GalleryChatInput({
  disabled = false,
  onStop,
  onSubmit,
  status,
  pendingAsk = null,
  onAnswerAskUser,
  threadId,
  restorePrompt = null,
  canStop = false,
  loadingModel = false,
  modelLoaded = false,
  ref,
}: {
  disabled?: boolean;
  onStop?: () => void;
  onSubmit: (message: GalleryPromptMessage) => void | Promise<void>;
  status: ChatStatus;
  pendingAsk?: { toolCallId: string; input: AskUserQuestionsInput } | null;
  onAnswerAskUser?: (
    toolCallId: string,
    output: AskUserQuestionsOutput
  ) => void;
  threadId: string;
  restorePrompt?: string | null;
  canStop?: boolean;
  loadingModel?: boolean;
  modelLoaded?: boolean;
  ref?: Ref<GalleryChatHandle>;
}) {
  const askRef = useRef<AskUserQuestionsHandle>(null);
  const inputRef = useRef<ChatInputHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelVoiceRef = useRef<() => void>(() => {});
  const [activeQuestion, setActiveQuestion] = useState<AskUserQuestion | null>(
    pendingAsk?.input.questions[0] ?? null
  );
  const attached = Boolean(pendingAsk);
  const lockSend = attached && !activeQuestion?.allowFreeForm;
  const askPlaceholder = attached
    ? askUserComposerPlaceholder(
        activeQuestion ?? pendingAsk?.input.questions[0]
      )
    : null;
  const prompt = composerPlaceholder({
    askUser: askPlaceholder,
    loadingModel,
    modelLoaded,
  });
  const harness = usePrefs((s) => s.chatHarness);
  const catalog = useHarnesses();
  const info = catalog.harnesses.find((h) => h.id === harness);
  const sendBlockReason = providerSendBlockReason({
    ready: catalog.ready,
    label: HARNESS_LABEL[harness],
    status: info?.status,
    detail: info?.detail,
  });

  useImperativeHandle(
    ref,
    () => ({
      captureDraft: () => {
        const input = inputRef.current;
        if (input) captureSessionDraft(threadId, input.getText());
      },
      clear: () => {
        setSessionDraft(threadId, "");
        inputRef.current?.clear();
      },
      focus: () => {
        inputRef.current?.focus();
      },
      cancelVoice: () => {
        cancelVoiceRef.current();
      },
      isReady: () =>
        Boolean(
          rootRef.current?.querySelector("[data-slot=input-group-control]")
        ),
    }),
    [threadId]
  );

  return (
    <div
      className="relative bottom-0 z-10 w-full min-w-0 overflow-x-hidden bg-background pt-2"
      data-chat-composer
      ref={rootRef}
    >
      <div className="mx-auto w-full min-w-0 p-2 @[360px]/chat:px-4 @[360px]/chat:pb-4">
        <div
          className={cn(
            attached &&
              "overflow-hidden rounded-2xl border border-input shadow-xs dark:bg-input/30"
          )}
        >
          {pendingAsk && onAnswerAskUser ? (
            <AskUserQuestionsPanel
              key={pendingAsk.toolCallId}
              ref={askRef}
              disabled={disabled}
              input={pendingAsk.input}
              onActiveChange={setActiveQuestion}
              onAnswer={(output) =>
                onAnswerAskUser(pendingAsk.toolCallId, output)
              }
            />
          ) : null}
          <div className={cn(attached && "border-t border-border")}>
            <ChatInputInner
              attached={attached}
              canStop={canStop}
              catalog={catalog}
              cancelVoiceRef={cancelVoiceRef}
              disabled={disabled}
              inputRef={inputRef}
              loadingModel={loadingModel}
              lockSend={lockSend}
              onStop={onStop}
              onSubmit={(message) => {
                if (pendingAsk) {
                  if (askRef.current?.submitFreeform(message.text)) return;
                  return;
                }
                return onSubmit(message);
              }}
              placeholder={prompt}
              restorePrompt={restorePrompt}
              sendBlockReason={sendBlockReason}
              status={status}
              threadId={threadId}
            />
          </div>
        </div>
        <p className="hidden px-2 pt-1 text-[11px] text-muted-foreground @[360px]/chat:block">
          {COMPOSER_HINT}
        </p>
        <ProviderStatus catalog={catalog} />
      </div>
    </div>
  );
}
