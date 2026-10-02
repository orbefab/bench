import { Container, Text } from "@react-three/uikit";
import { useXR } from "@react-three/xr";
import { useContext } from "react";
import { useShallow } from "zustand/react/shallow";

import { requestAppearance } from "@/lib/appearance";
import { usePrefs } from "@/state/prefs";
import { useXrUi } from "@/state/xr";
import { FeedbackContext, ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";
import { enterAR, enterVR } from "@/xrStore";

export function SettingsCard() {
  const { axesVisible, setAxesVisible } = usePrefs(
    useShallow((s) => ({
      axesVisible: s.axesVisible,
      setAxesVisible: s.setAxesVisible,
    }))
  );
  const { setPage, appearance, setAppearance } = useXrUi(
    useShallow((s) => ({
      setPage: s.setPage,
      appearance: s.appearance,
      setAppearance: s.setAppearance,
    }))
  );
  const theme = useXrTheme();
  const session = useXR((s) => s.session);
  const mode = useXR((s) => s.mode);
  const feedback = useContext(FeedbackContext);
  const passthrough = mode === "immersive-ar";
  const studio = mode === "immersive-vr";
  const pickAppearance = (next: "light" | "dark") => {
    setAppearance(next);
    requestAppearance(next);
  };
  return (
    <Container
      width={192}
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
      <Container flexDirection="row" gap={4} width="100%">
        <ToolBtn id="back" label="Back" onClick={() => setPage("tree")} />
        <ToolBtn id="help" label="Controls" onClick={() => setPage("help")} />
      </Container>
      <Container flexDirection="row" gap={2} width="100%" flexShrink={0}>
        <ToolBtn
          id="passthrough"
          label="Pass"
          active={passthrough}
          onClick={() => {
            if (!passthrough) void enterAR();
          }}
        />
        <ToolBtn
          id="studio"
          label="Studio"
          active={studio}
          onClick={() => {
            if (!studio) void enterVR();
          }}
        />
      </Container>
      <Container flexDirection="row" gap={2} width="100%" flexShrink={0}>
        <ToolBtn
          id="light"
          label="Light"
          active={appearance === "light"}
          onClick={() => pickAppearance("light")}
        />
        <ToolBtn
          id="dark"
          label="Dark"
          active={appearance === "dark"}
          onClick={() => pickAppearance("dark")}
        />
      </Container>
      <ToolBtn
        id="axes"
        label={axesVisible ? "Axes on" : "Axes off"}
        active={axesVisible}
        onClick={() => setAxesVisible((open) => !open)}
      />
      <Container
        height={36}
        width="100%"
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        borderRadius={6}
        backgroundColor="#dc2626"
        hover={{ backgroundColor: "#b91c1c" }}
        active={{ backgroundColor: "#991b1b" }}
        onClick={() => {
          feedback.click();
          void session?.end();
        }}
        onHoverChange={(hovered) => feedback.hover("exit", hovered)}
      >
        <Text fontSize={15} color="#fafafa">
          Exit
        </Text>
      </Container>
    </Container>
  );
}
