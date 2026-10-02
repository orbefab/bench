import { Container, Text } from "@react-three/uikit";
import {
  FolderOpen,
  LayoutGrid,
  LocateFixed,
  Minus,
  Pause,
  Play,
  Plus,
  Settings,
} from "@react-three/uikit-lucide";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { treeTops } from "@/cad/tree";
import { sendWorldCommand } from "@/hooks/useWorldRun";
import { catalogLabel } from "@/lib/viewer-snapshot";
import {
  formatSimTime,
  formatXrIssueLine,
  visibleAssetIssues,
} from "@/lib/world-issues";
import { useScene } from "@/state/scene";
import { useViewer } from "@/state/viewer";
import { useWorld } from "@/state/world";
import { useXrUi } from "@/state/xr";
import { ToolBtn } from "@/xr/ui/ToolBtn";
import { TreeRow } from "@/xr/ui/TreeRow";
import { useXrTheme } from "@/xr/ui/theme";
import { asciiSafe } from "@/xr/ui/UikitMarkdown";

function WorldRunRow() {
  const theme = useXrTheme();
  const {
    playing,
    simTime,
    connection,
    notice,
    runErrors,
    runMessage,
    assetIssues,
  } = useWorld(
    useShallow((s) => ({
      playing: s.playing,
      simTime: s.simTime,
      connection: s.connection,
      notice: s.notice,
      runErrors: s.runErrors,
      runMessage: s.runMessage,
      assetIssues: s.assetIssues,
    }))
  );
  const blocked = runErrors.length > 0;
  const live = connection === "live" && !blocked;
  const status =
    connection === "reconnecting"
      ? "Reconnecting..."
      : connection === "connecting"
        ? "Connecting..."
        : null;
  const errorLine = formatXrIssueLine(
    runErrors,
    visibleAssetIssues(assetIssues, runErrors),
    runMessage
  );
  const tip = blocked
    ? "This world can't run"
    : status
      ? status
      : playing
        ? "Pause"
        : "Play";
  return (
    <Container flexDirection="column" flexShrink={0} gap={4} width="100%">
      <Container
        flexDirection="row"
        flexShrink={0}
        alignItems="center"
        gap={6}
        width="100%"
      >
        <ToolBtn
          id="world-play"
          name="xr-world-play"
          icon={playing ? Pause : Play}
          tip={tip}
          grow={false}
          active={playing && live}
          disabled={!live}
          onClick={() => sendWorldCommand(playing ? "pause" : "play")}
        />
        <Text fontSize={11} color={theme.subtle}>
          {status ?? formatSimTime(simTime)}
        </Text>
      </Container>
      {notice ? (
        <Text fontSize={11} color={theme.text} width="100%">
          {asciiSafe(notice)}
        </Text>
      ) : null}
      {errorLine ? (
        <Text
          fontSize={11}
          color={theme.danger}
          width="100%"
          wordBreak="break-word"
        >
          {asciiSafe(errorLine)}
        </Text>
      ) : null}
    </Container>
  );
}

export function CardBody({
  width = 204,
  height = 340,
  filesOpen = false,
  onToggleFiles,
}: {
  width?: number;
  height?: number;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
}) {
  const { review, title, url, showAll } = useViewer(
    useShallow((s) => ({
      review: s.review,
      title: s.title,
      url: s.url,
      showAll: s.showAll,
    }))
  );
  const worldPath = useWorld((s) => s.path);
  const heading = worldPath ? catalogLabel(worldPath) : url ? title : "No file";
  const { page, setPage } = useXrUi(
    useShallow((s) => ({
      page: s.page,
      setPage: s.setPage,
    }))
  );
  const { bumpScale, resetScale, modelScale, recenter } = useScene(
    useShallow((s) => ({
      bumpScale: s.bumpScale,
      resetScale: s.resetScale,
      modelScale: s.modelScale,
      recenter: s.recenter,
    }))
  );
  const scaleLabel = `${modelScale >= 10 ? modelScale.toFixed(0) : modelScale.toFixed(modelScale >= 1 ? 1 : 2)}x`;
  const tops = useMemo(() => (review ? treeTops(review) : []), [review]);
  const theme = useXrTheme();

  return (
    <Container
      width={width}
      height={height}
      padding={8}
      gap={4}
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
        <ToolBtn
          id="show-all"
          icon={LayoutGrid}
          tip="Show all"
          onClick={() => showAll()}
        />
        <ToolBtn
          id="files"
          icon={FolderOpen}
          tip="Open"
          active={filesOpen}
          onClick={() => onToggleFiles?.()}
        />
        <ToolBtn
          id="settings"
          icon={Settings}
          tip="Settings"
          active={page === "settings"}
          onClick={() => setPage(page === "settings" ? "tree" : "settings")}
        />
      </Container>
      <Text fontSize={12} color={theme.subtle} width="100%">
        {asciiSafe(heading)}
      </Text>
      <Container
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={theme.border}
      />
      <Container
        flexGrow={1}
        width="100%"
        overflow="scroll"
        gap={2}
        flexDirection="column"
      >
        {tops.length > 0 ? (
          tops.map((obj) => <TreeRow key={obj.uuid} obj={obj} />)
        ) : worldPath ? null : (
          <Text fontSize={12} color={theme.subtle} width="100%">
            Open a file. Run a model under cad/src to see it here.
          </Text>
        )}
      </Container>
      {worldPath ? <WorldRunRow /> : null}
      <Container
        width="100%"
        height={1}
        flexShrink={0}
        backgroundColor={theme.border}
      />
      <Container
        flexDirection="row"
        flexShrink={0}
        alignItems="center"
        gap={4}
        width="100%"
      >
        <ToolBtn
          id="minus"
          icon={Minus}
          tip="Zoom out"
          onClick={() => bumpScale(1 / 1.25)}
        />
        <ToolBtn
          id="scale"
          label={scaleLabel}
          tip="Reset to 1:1"
          onClick={() => resetScale()}
        />
        <ToolBtn
          id="plus"
          icon={Plus}
          tip="Zoom in"
          onClick={() => bumpScale(1.25)}
        />
        <Container
          width={1}
          height={16}
          flexShrink={0}
          backgroundColor={theme.divider}
        />
        <ToolBtn
          id="recenter"
          icon={LocateFixed}
          grow={false}
          tip="Bring the model back in front of you"
          onClick={() => recenter?.()}
        />
      </Container>
    </Container>
  );
}
