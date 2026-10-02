import { Container, Text } from "@react-three/uikit";
import { useXRInputSourceState } from "@react-three/xr";
import {
  type ComponentType,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { pulseClick, pulseHover } from "@/xr/haptics";
import { useXrTheme } from "@/xr/ui/theme";

export type Feedback = {
  /** Called on hover enter/leave; pulses once per distinct button entered. */
  hover: (key: string, hovered: boolean) => void;
  /** Called on click; a firmer pulse than hover. */
  click: () => void;
};

export const FeedbackContext = createContext<Feedback>({
  hover: () => {},
  click: () => {},
});

/** Delay before a hovered button shows its tooltip. */
const TIP_DELAY_MS = 450;

/** Haptic feedback bound to one input source (a no-op for hands, which have no actuator). */
export function useFeedback(source: XRInputSource | undefined): Feedback {
  const last = useRef<string | null>(null);
  const ref = useRef(source);
  ref.current = source;
  return useMemo(
    () => ({
      hover: (key, hovered) => {
        if (!hovered) {
          if (last.current === key) last.current = null;
          return;
        }
        if (last.current === key) return;
        last.current = key;
        pulseHover(ref.current);
      },
      click: () => pulseClick(ref.current),
    }),
    []
  );
}

/** Feedback for the right controller, which owns the ray in controller mode. */
export function useRightControllerFeedback(): Feedback {
  const right = useXRInputSourceState("controller", "right");
  return useFeedback(right?.inputSource);
}

type Icon = ComponentType<{ width?: number; height?: number; color?: string }>;

export function ToolBtn({
  id,
  icon: Icon,
  label,
  tip,
  onClick,
  active,
  grow = true,
  round = false,
  onHover,
  backgroundColor,
  hoverColor,
  name,
  disabled = false,
}: {
  id: string;
  icon?: Icon;
  label?: string;
  tip?: string;
  onClick: () => void;
  active?: boolean;
  grow?: boolean;
  round?: boolean;
  onHover?: (hovered: boolean) => void;
  backgroundColor?: string;
  hoverColor?: string;
  /** Object3D name, so a controller ray can be aimed at this button. */
  name?: string;
  /** No click, no haptic, no pressed style. The tooltip still shows. */
  disabled?: boolean;
}) {
  const theme = useXrTheme();
  const idle = backgroundColor ?? theme.muted;
  const hover = hoverColor ?? theme.hover;
  const feedback = useContext(FeedbackContext);
  const fg = disabled ? theme.subtle : theme.text;
  const [tipShown, setTipShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTip = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTipShown(false);
  };
  return (
    <Container
      ref={(node) => {
        if (node && name) node.name = name;
      }}
      flexGrow={grow ? 1 : 0}
      flexShrink={0}
      width={grow ? undefined : round ? 18 : 32}
      height={round ? 18 : 32}
      alignItems="center"
      justifyContent="center"
      borderRadius={round ? 9 : 6}
      backgroundColor={disabled || !active ? idle : theme.active}
      hover={disabled ? undefined : { backgroundColor: hover }}
      active={disabled ? undefined : { backgroundColor: theme.pressed }}
      onClick={() => {
        if (disabled) return;
        clearTip();
        feedback.click();
        onClick();
      }}
      onHoverChange={(hovered) => {
        if (!disabled) {
          feedback.hover(id, hovered);
          onHover?.(hovered);
        }
        if (!tip) return;
        if (hovered) {
          timer.current = setTimeout(() => setTipShown(true), TIP_DELAY_MS);
        } else {
          clearTip();
        }
      }}
    >
      {Icon ? (
        <Icon width={round ? 12 : 16} height={round ? 12 : 16} color={fg} />
      ) : (
        <Text fontSize={14} color={fg}>
          {label}
        </Text>
      )}
      {tip && tipShown ? (
        // Tooltip floats above the button, centred on it. The outer strip spans
        // the button width; the pill inside may be wider and overflows evenly.
        <Container
          positionType="absolute"
          positionBottom="100%"
          positionLeft={0}
          positionRight={0}
          marginBottom={6}
          alignItems="center"
          pointerEvents="none"
          zIndexOffset={10}
        >
          <Container
            flexShrink={0}
            paddingX={8}
            paddingY={4}
            borderRadius={6}
            backgroundColor={theme.tooltipBg}
          >
            <Text fontSize={11} color={theme.tooltipFg} whiteSpace="pre">
              {tip}
            </Text>
          </Container>
        </Container>
      ) : null}
    </Container>
  );
}
