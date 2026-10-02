import { Container, Text } from "@react-three/uikit";
import { ChevronDown, Eye, EyeOff } from "@react-three/uikit-lucide";
import { useContext } from "react";
import type { Object3D } from "three";
import { useShallow } from "zustand/react/shallow";

import { namedKids } from "@/cad/tree";
import { useOpenOnSelect } from "@/hooks/useTreeNode";
import { useViewer } from "@/state/viewer";
import { FeedbackContext } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";

export function TreeRow({ obj, depth = 0 }: { obj: Object3D; depth?: number }) {
  const { review, selectedId, select, setVisible, hiddenIds } = useViewer(
    useShallow((s) => ({
      review: s.review,
      selectedId: s.selectedId,
      select: s.select,
      setVisible: s.setVisible,
      hiddenIds: s.hiddenIds,
    }))
  );
  const feedback = useContext(FeedbackContext);
  const theme = useXrTheme();
  const part = review?.partByObject.get(obj);
  const kids = review ? namedKids(obj, review) : [];
  const [open, setOpen] = useOpenOnSelect(obj);

  if (!review || !part) {
    return (
      <>
        {kids.map((child) => (
          <TreeRow key={child.uuid} obj={child} depth={depth} />
        ))}
      </>
    );
  }
  const shown = !hiddenIds.has(part.id);
  const selected = selectedId === part.id;
  return (
    <>
      <Container
        flexDirection="row"
        flexShrink={0}
        alignItems="center"
        gap={4}
        height={30}
        width="100%"
        paddingLeft={depth * 12}
      >
        {kids.length ? (
          <Container
            width={26}
            height={26}
            flexShrink={0}
            alignItems="center"
            justifyContent="center"
            borderRadius={4}
            backgroundColor={theme.muted}
            hover={{ backgroundColor: theme.active }}
            active={{ backgroundColor: theme.pressed }}
            onClick={() => {
              feedback.click();
              setOpen((v) => !v);
            }}
            onHoverChange={(hovered) =>
              feedback.hover(`toggle-${part.id}`, hovered)
            }
          >
            <ChevronDown
              width={12}
              height={12}
              color={theme.text}
              transformRotateZ={open ? 0 : 90}
            />
          </Container>
        ) : (
          <Container width={26} height={26} flexShrink={0} />
        )}
        <Container
          flexGrow={1}
          height={26}
          paddingX={6}
          justifyContent="center"
          borderRadius={4}
          backgroundColor={selected ? theme.selected : theme.muted}
          hover={{
            backgroundColor: selected ? theme.selectedHover : theme.active,
          }}
          active={{
            backgroundColor: selected ? theme.selectedActive : theme.pressed,
          }}
          onClick={() => {
            feedback.click();
            select(part.id);
          }}
          onHoverChange={(hovered) =>
            feedback.hover(`select-${part.id}`, hovered)
          }
        >
          <Text fontSize={13} color={theme.text}>
            {part.name.length > 18 ? `${part.name.slice(0, 17)}...` : part.name}
          </Text>
        </Container>
        <Container
          width={26}
          height={26}
          flexShrink={0}
          alignItems="center"
          justifyContent="center"
          borderRadius={4}
          backgroundColor={theme.muted}
          hover={{ backgroundColor: theme.active }}
          active={{ backgroundColor: theme.pressed }}
          onClick={() => {
            feedback.click();
            setVisible(part.id, !shown);
          }}
          onHoverChange={(hovered) => feedback.hover(`vis-${part.id}`, hovered)}
        >
          {shown ? (
            <Eye width={14} height={14} color={theme.text} />
          ) : (
            <EyeOff width={14} height={14} color={theme.text} />
          )}
        </Container>
      </Container>
      {open &&
        kids.map((child) => (
          <TreeRow key={child.uuid} obj={child} depth={depth + 1} />
        ))}
    </>
  );
}
