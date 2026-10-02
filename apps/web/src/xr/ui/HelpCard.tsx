import { Container, Text } from "@react-three/uikit";

import { useXrUi } from "@/state/xr";
import { ToolBtn } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Hands",
    rows: [
      ["Pinch", "Click what the ray points at"],
      ["Palm in, curl", "Grab and move the model"],
      ["Both hands", "Spread to scale"],
      ["Back of hand up", "Show wrist panels"],
      ["Left watch", "This card"],
      ["Right watch", "Tools"],
      ["Speaking orb", "Open or hide chat"],
      ["Mic beside orb", "Talk when chat is closed"],
    ],
  },
  {
    title: "Controllers",
    rows: [
      ["Trigger", "Click"],
      ["Grip", "Move (both grips: scale)"],
      ["Y", "This card"],
      ["B hold, slide", "Pick a tool"],
      ["A", "Axes"],
    ],
  },
  {
    title: "Model",
    rows: [
      ["Click selected", "Step up to its assembly"],
      ["Hide tool", "Click a part to hide it"],
      ["Measure", "Two clicks; label on the line"],
    ],
  },
];

export function HelpCard() {
  const setPage = useXrUi((s) => s.setPage);
  const theme = useXrTheme();
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
      <ToolBtn
        id="help-back"
        label="Back"
        onClick={() => setPage("settings")}
      />
      {SECTIONS.map((section) => (
        <Container
          key={section.title}
          flexDirection="column"
          gap={2}
          width="100%"
        >
          <Text fontSize={13} color={theme.text}>
            {section.title}
          </Text>
          {section.rows.map(([key, what]) => (
            <Container key={key} flexDirection="row" gap={6} width="100%">
              <Container width={72} flexShrink={0}>
                <Text fontSize={11} color={theme.text}>
                  {key}
                </Text>
              </Container>
              <Text fontSize={11} color={theme.subtle}>
                {what}
              </Text>
            </Container>
          ))}
        </Container>
      ))}
    </Container>
  );
}
