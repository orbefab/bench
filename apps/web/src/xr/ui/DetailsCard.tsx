import { Container, Text } from "@react-three/uikit";
import { Eye, EyeOff, Focus, Undo2 } from "@react-three/uikit-lucide";
import { useShallow } from "zustand/react/shallow";

import { formatMm, measureDelta } from "@/lib/measure";
import { useViewer } from "@/state/viewer";
import { ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";

export function DetailsCard() {
  const {
    review,
    selectedId,
    pickedRef,
    isolate,
    setVisible,
    hiddenIds,
    tool,
    measure,
    undoMeasure,
    clearMeasure,
  } = useViewer(
    useShallow((s) => ({
      review: s.review,
      selectedId: s.selectedId,
      pickedRef: s.pickedRef,
      isolate: s.isolate,
      setVisible: s.setVisible,
      hiddenIds: s.hiddenIds,
      tool: s.tool,
      measure: s.measure,
      undoMeasure: s.undoMeasure,
      clearMeasure: s.clearMeasure,
    }))
  );
  const part = selectedId !== null ? review?.parts[selectedId] : undefined;
  const theme = useXrTheme();

  if (tool === "measure") {
    const a = measure.a;
    const b = measure.b;
    const delta = measureDelta(a, b);
    return (
      <Container
        width={184}
        padding={8}
        gap={6}
        flexDirection="column"
        backgroundColor={theme.card}
        borderRadius={12}
        borderWidth={1}
        borderColor={theme.border}
        pixelSize={0.001}
        pointerEvents="auto"
      >
        <Text fontSize={13} color={theme.text}>
          Measure
        </Text>
        <Text fontSize={12} color={theme.subtle}>
          {`1 ${a?.cadRef ?? "-"}`}
        </Text>
        <Text fontSize={12} color={theme.subtle}>
          {`2 ${b?.cadRef ?? "-"}`}
        </Text>
        {delta ? (
          <>
            <Text fontSize={16} color={theme.text}>
              {formatMm(delta.dist)}
            </Text>
            <Text fontSize={11} color={theme.subtle}>
              {`dX ${formatMm(delta.dx)}  dY ${formatMm(delta.dy)}  dZ ${formatMm(delta.dz)}`}
            </Text>
          </>
        ) : (
          <Text fontSize={12} color={theme.subtle}>
            Click two places
          </Text>
        )}
        <Container flexDirection="row" gap={4} width="100%">
          <ToolBtn
            id="m-undo"
            icon={Undo2}
            grow={false}
            onClick={() => undoMeasure()}
          />
          <ToolBtn id="m-clear" label="Clear" onClick={() => clearMeasure()} />
        </Container>
      </Container>
    );
  }

  if (!part && !pickedRef) return null;
  const shown = part ? !hiddenIds.has(part.id) : true;
  const ref = pickedRef ?? part?.cadRef ?? null;
  return (
    <Container
      width={184}
      padding={8}
      gap={6}
      flexDirection="column"
      backgroundColor={theme.card}
      borderRadius={12}
      borderWidth={1}
      borderColor={theme.border}
      pixelSize={0.001}
      pointerEvents="auto"
    >
      {part ? (
        <Container flexDirection="row" alignItems="center" gap={6} width="100%">
          <Container
            width={10}
            height={10}
            flexShrink={0}
            borderRadius={2}
            backgroundColor={part.color}
          />
          <Text fontSize={13} color={theme.text}>
            {part.name.length > 16 ? `${part.name.slice(0, 15)}...` : part.name}
          </Text>
        </Container>
      ) : null}
      {ref && ref !== part?.name ? (
        <Text fontSize={12} color={theme.text}>
          {ref.length > 24 ? `${ref.slice(0, 23)}...` : ref}
        </Text>
      ) : null}
      {part ? (
        <Container flexDirection="row" gap={4} width="100%">
          <ToolBtn
            id="d-hide"
            icon={shown ? Eye : EyeOff}
            onClick={() => setVisible(part.id, !shown)}
          />
          <ToolBtn id="d-iso" icon={Focus} onClick={() => isolate(part.id)} />
        </Container>
      ) : null}
    </Container>
  );
}
