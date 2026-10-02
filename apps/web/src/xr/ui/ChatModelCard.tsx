import { Container, Input, Text } from "@react-three/uikit";
import { useContext, useEffect, useMemo, useState } from "react";

import { harnessModelName, useHarnesses } from "@/hooks/useHarnesses";
import {
  CHAT_EFFORT_LABEL,
  CHAT_EFFORTS,
  type ChatEffort,
  HARNESS_IDS,
  type HarnessId,
  type HarnessModel,
  harnessSupportsEffort,
} from "@/lib/harness";
import { usePrefs } from "@/state/prefs";
import { FeedbackContext, ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";
import { asciiSafe } from "@/xr/ui/UikitMarkdown";
import { XrProviderMark } from "@/xr/ui/XrProviderMark";
import { XR_CHAT_OVERLAY_H, XR_CHAT_OVERLAY_W } from "@/xr/ui/xrChatChrome";

export function ChatModelCard({ onClose }: { onClose: () => void }) {
  const chatHarness = usePrefs((s) => s.chatHarness);
  const chatModel = usePrefs((s) => s.chatModel);
  const chatEffort = usePrefs((s) => s.chatEffort);
  const setChatSelection = usePrefs((s) => s.setChatSelection);
  const setChatEffort = usePrefs((s) => s.setChatEffort);
  const { harnesses, ready, error } = useHarnesses();
  const [rail, setRail] = useState<HarnessId>(chatHarness);
  const [query, setQuery] = useState("");
  const feedback = useContext(FeedbackContext);
  const theme = useXrTheme();

  useEffect(() => {
    setRail(chatHarness);
  }, [chatHarness]);

  const active = harnesses.find((h) => h.id === rail);
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const models = (active?.models ?? []).filter((m) => {
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.slug.toLowerCase().includes(q) ||
        (m.group ?? "").toLowerCase().includes(q)
      );
    });
    const byGroup = new Map<string, HarnessModel[]>();
    for (const m of models) {
      const key = m.group ?? active?.label ?? "";
      const list = byGroup.get(key) ?? [];
      list.push(m);
      byGroup.set(key, list);
    }
    return [...byGroup.entries()];
  }, [active, q]);

  const notReady = active != null && active.status !== "ready";

  return (
    <Container
      width={XR_CHAT_OVERLAY_W}
      height={XR_CHAT_OVERLAY_H}
      padding={8}
      gap={6}
      flexDirection="column"
      backgroundColor={theme.card}
      borderRadius={12}
      borderWidth={1}
      borderColor={theme.border}
      pixelSize={0.001}
      opacity={1}
      zIndexOffset={10}
      pointerEvents="auto"
    >
      <Container flexDirection="row" gap={4} width="100%" flexShrink={0}>
        <ToolBtn id="chat-model-back" label="Back" onClick={onClose} />
      </Container>
      <Container flexDirection="row" flexShrink={0} gap={4} width="100%">
        {HARNESS_IDS.map((id) => {
          const info = harnesses.find((h) => h.id === id);
          const dim = info != null && info.status !== "ready";
          const selected = rail === id;
          return (
            <Container
              key={id}
              width={36}
              height={36}
              flexShrink={0}
              alignItems="center"
              justifyContent="center"
              borderRadius={8}
              backgroundColor={selected ? theme.active : theme.muted}
              hover={{ backgroundColor: selected ? theme.active : theme.hover }}
              active={{ backgroundColor: theme.pressed }}
              opacity={dim ? 0.45 : 1}
              onHoverChange={(hovered: boolean) =>
                feedback.hover(`model-rail-${id}`, hovered)
              }
              onClick={() => {
                feedback.click();
                setRail(id);
                setQuery("");
              }}
            >
              <XrProviderMark id={id} size={18} />
            </Container>
          );
        })}
      </Container>
      {harnessSupportsEffort(rail) ? (
        <Container flexDirection="row" flexShrink={0} gap={4} width="100%">
          {CHAT_EFFORTS.map((value) => {
            const selected = chatEffort === value;
            return (
              <Container
                key={value}
                flexGrow={1}
                height={28}
                alignItems="center"
                justifyContent="center"
                borderRadius={8}
                backgroundColor={selected ? theme.active : theme.muted}
                hover={{
                  backgroundColor: selected ? theme.active : theme.hover,
                }}
                active={{ backgroundColor: theme.pressed }}
                onHoverChange={(hovered: boolean) =>
                  feedback.hover(`effort-${value}`, hovered)
                }
                onClick={() => {
                  feedback.click();
                  setChatEffort(value as ChatEffort);
                }}
              >
                <Text fontSize={11} color={theme.text}>
                  {asciiSafe(CHAT_EFFORT_LABEL[value])}
                </Text>
              </Container>
            );
          })}
        </Container>
      ) : null}
      <Container
        width="100%"
        height={32}
        flexShrink={0}
        borderRadius={8}
        backgroundColor={theme.muted}
        paddingX={8}
      >
        <Input
          value={query}
          onValueChange={(value: string) => setQuery(value)}
          placeholder="Search models..."
          width="100%"
          height="100%"
          fontSize={13}
          color={theme.text}
        />
      </Container>
      <Container
        flexGrow={1}
        minHeight={0}
        width="100%"
        overflow="scroll"
        gap={2}
        flexDirection="column"
      >
        {!ready ? (
          <>
            {Array.from({ length: 6 }, (_, i) => (
              <Container
                key={i}
                width="100%"
                height={24}
                flexShrink={0}
                borderRadius={6}
                backgroundColor={theme.hover}
              />
            ))}
          </>
        ) : error ? (
          <Text fontSize={12} color={theme.subtle}>
            Could not load models
          </Text>
        ) : notReady ? (
          <Text fontSize={12} color={theme.subtle}>
            {asciiSafe(active.detail ?? active.status)}
          </Text>
        ) : groups.length === 0 ? (
          <Text fontSize={12} color={theme.subtle}>
            No matches
          </Text>
        ) : (
          groups.map(([group, models]) => (
            <Container
              key={group}
              width="100%"
              flexShrink={0}
              flexDirection="column"
              gap={2}
            >
              {group ? (
                <Text fontSize={11} color={theme.subtle}>
                  {asciiSafe(group)}
                </Text>
              ) : null}
              {models.map((m) => {
                const selected = rail === chatHarness && m.slug === chatModel;
                return (
                  <Container
                    key={m.slug}
                    width="100%"
                    minWidth={0}
                    flexShrink={0}
                    padding={6}
                    borderRadius={8}
                    backgroundColor={selected ? theme.active : theme.muted}
                    hover={{
                      backgroundColor: selected ? theme.active : theme.hover,
                    }}
                    active={{ backgroundColor: theme.pressed }}
                    onHoverChange={(hovered: boolean) =>
                      feedback.hover(`model-${m.slug}`, hovered)
                    }
                    onClick={() => {
                      feedback.click();
                      setChatSelection(rail, m.slug);
                      onClose();
                    }}
                  >
                    <Text
                      fontSize={13}
                      color={theme.text}
                      wordBreak="break-word"
                    >
                      {asciiSafe(m.name)}
                    </Text>
                  </Container>
                );
              })}
            </Container>
          ))
        )}
      </Container>
    </Container>
  );
}

export function ChatModelChip({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const chatHarness = usePrefs((s) => s.chatHarness);
  const chatModel = usePrefs((s) => s.chatModel);
  const { harnesses } = useHarnesses();
  const name = asciiSafe(harnessModelName(harnesses, chatHarness, chatModel));
  const feedback = useContext(FeedbackContext);
  const theme = useXrTheme();
  return (
    <Container
      flexDirection="row"
      flexShrink={0}
      alignItems="center"
      gap={6}
      height={28}
      maxWidth="100%"
      minWidth={0}
      paddingX={8}
      borderRadius={8}
      backgroundColor={active ? theme.active : theme.muted}
      hover={{ backgroundColor: active ? theme.active : theme.hover }}
      active={{ backgroundColor: theme.pressed }}
      onHoverChange={(hovered: boolean) =>
        feedback.hover("xr-chat-model", hovered)
      }
      onClick={() => {
        feedback.click();
        onClick();
      }}
    >
      <XrProviderMark id={chatHarness} size={14} />
      <Text fontSize={12} color={theme.text} wordBreak="break-word">
        {name}
      </Text>
    </Container>
  );
}
