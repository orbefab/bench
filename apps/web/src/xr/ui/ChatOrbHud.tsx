import { Container, Text } from "@react-three/uikit";
import { Check, Loader, Mic, Square, X } from "@react-three/uikit-lucide";

import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import { messagePlainText } from "@/components/chat/useViewerChat";
import { formatVoiceTime } from "@/hooks/useVoiceInput";
import { bandWidth, NEAR_PAD } from "@/xr/ui/chrome";
import { ORB_RADIUS } from "@/xr/ui/SpeakingOrb";
import { ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";
import { asciiSafe } from "@/xr/ui/UikitMarkdown";
import { useXrChatRuntime } from "@/xr/ui/XrChatRuntime";

const CLEAR = ORB_RADIUS + bandWidth(NEAR_PAD) + 0.008;
const TEXT_W = 240;
const MAX_CHARS = 280;
const MAX_ROWS = 4;

function clip(text: string) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS - 3)}...`;
}

function closedTextRows(messages: GalleryChatMessage[]) {
  const rows: { id: string; mine: boolean; text: string }[] = [];
  for (let i = messages.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
    const message = messages[i];
    const text = messagePlainText(message);
    if (!text) continue;
    rows.push({
      id: message.id,
      mine: message.role === "user",
      text: clip(text),
    });
  }
  return rows.reverse();
}

export function ChatOrbHud() {
  const runtime = useXrChatRuntime();
  const theme = useXrTheme();
  if (!runtime) return null;
  const { messages, busy, error, stop, voice } = runtime;
  const rows = closedTextRows(messages);
  const recording = voice.active;

  return (
    <>
      <group position={[CLEAR, 0, 0.02]}>
        <Container
          anchorX="left"
          anchorY="center"
          pixelSize={0.001}
          pointerEvents="auto"
          flexDirection="row"
          alignItems="center"
          gap={4}
          padding={recording ? 4 : 0}
          borderRadius={10}
          backgroundColor={recording ? theme.card : "#00000000"}
        >
          {recording ? (
            <>
              <ToolBtn
                id="xr-orb-voice-cancel"
                icon={X}
                tip="Cancel"
                grow={false}
                onClick={voice.cancel}
              />
              <Container width={40} alignItems="center" justifyContent="center">
                <Text fontSize={12} color={theme.subtle}>
                  {voice.busy ? "..." : formatVoiceTime(voice.elapsedMs)}
                </Text>
              </Container>
              <ToolBtn
                id="xr-orb-voice-done"
                icon={voice.busy ? Loader : Check}
                tip={voice.error ?? (voice.busy ? "Transcribing..." : "Send")}
                grow={false}
                onClick={() => {
                  if (voice.recording && !voice.busy) voice.complete();
                }}
              />
            </>
          ) : busy ? (
            <ToolBtn
              id="xr-orb-stop"
              icon={Square}
              tip="Stop"
              grow={false}
              onClick={() => stop()}
            />
          ) : (
            <ToolBtn
              id="xr-orb-mic"
              icon={Mic}
              tip={voice.error ?? "Tap to talk"}
              grow={false}
              onClick={() => void voice.start()}
            />
          )}
        </Container>
      </group>
      <group position={[0, -CLEAR, 0.02]}>
        <Container
          anchorX="center"
          anchorY="top"
          width={TEXT_W}
          pixelSize={0.001}
          pointerEvents="auto"
          flexDirection="column"
          alignItems="center"
          gap={6}
        >
          {rows.map((row) =>
            row.mine ? (
              <Container
                key={row.id}
                width="100%"
                flexDirection="row"
                justifyContent="flex-end"
              >
                <Container
                  maxWidth="80%"
                  padding={8}
                  borderRadius={10}
                  backgroundColor={theme.bubble}
                  flexShrink={0}
                >
                  <Text fontSize={13} color={theme.text} wordBreak="break-word">
                    {asciiSafe(row.text)}
                  </Text>
                </Container>
              </Container>
            ) : (
              <Container key={row.id} width="100%" flexShrink={0}>
                <Text fontSize={13} color={theme.text} wordBreak="break-word">
                  {asciiSafe(row.text)}
                </Text>
              </Container>
            )
          )}
          {error ? (
            <Text fontSize={11} color={theme.danger} wordBreak="break-word">
              {asciiSafe(error)}
            </Text>
          ) : null}
          {voice.error && !voice.active ? (
            <Text fontSize={11} color={theme.danger} wordBreak="break-word">
              {asciiSafe(voice.error)}
            </Text>
          ) : null}
        </Container>
      </group>
    </>
  );
}
