import { Axis3d, Focus, Home, Ruler, Scan } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";
import { useScene } from "@/state/scene";
import { useViewer } from "@/state/viewer";

type Props = {
  onHome: () => void;
  onFit: () => void;
};

export function Toolbar({ onHome, onFit }: Props) {
  const { review, selectedId, isolate, tool, setTool } = useViewer(
    useShallow((s) => ({
      review: s.review,
      selectedId: s.selectedId,
      isolate: s.isolate,
      tool: s.tool,
      setTool: s.setTool,
    }))
  );
  const fit = useScene((s) => s.fit);
  const { axesVisible, setAxesVisible } = usePrefs(
    useShallow((s) => ({
      axesVisible: s.axesVisible,
      setAxesVisible: s.setAxesVisible,
    }))
  );
  return (
    <div className="pointer-events-auto absolute top-4 left-1/2 z-20 flex -translate-x-1/2 gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-lg">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-9 w-9 p-0"
        title="Frame whole model"
        aria-label="Frame whole model"
        onClick={onHome}
      >
        <Home />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-9 w-9 p-0"
        title="Frame selection"
        aria-label="Frame selection"
        onClick={onFit}
      >
        <Scan />
      </Button>
      {/* Measure replaces the Selection panel, so Isolate has to stay on the toolbar. */}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-9 w-9 p-0"
        title="Isolate"
        aria-label="Isolate"
        disabled={selectedId === null}
        onClick={() => {
          if (selectedId === null) return;
          isolate(selectedId);
          const obj = review?.parts[selectedId]?.object;
          if (obj) fit?.(obj);
        }}
      >
        <Focus />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn("h-9 w-9 p-0", tool === "measure" && "bg-accent")}
        title="Measure"
        aria-label="Measure"
        onClick={() => setTool(tool === "measure" ? "select" : "measure")}
      >
        <Ruler />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn("h-9 w-9 p-0", axesVisible && "bg-accent")}
        title="World axes"
        aria-label="World axes"
        onClick={() => setAxesVisible((open) => !open)}
      >
        <Axis3d />
      </Button>
    </div>
  );
}
