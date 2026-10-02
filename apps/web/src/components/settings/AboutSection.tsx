import { useEffect, useState } from "react";

import { useAppearancePrefs } from "@/components/theme/appearance-prefs";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useProjectSession } from "@/hooks/useProjectSession";
import { APP_DISPLAY_NAME, APP_VERSION } from "@/lib/crash-report";
import { folderName } from "@/lib/project";
import { copyText, formatDebugReport } from "@/lib/settings";
import { useViewer } from "@/state/viewer";

type CopyFlash = "copied" | "failed" | null;

export function AboutSection({ host }: { host: boolean }) {
  const { theme } = useTheme();
  const { textSize } = useAppearancePrefs();
  const projectPath = useProjectSession().project.path;
  const title = useViewer((s) => s.title);
  const error = useViewer((s) => s.error);
  const { harnesses } = useHarnesses();
  const [flash, setFlash] = useState<CopyFlash>(null);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 1500);
    return () => window.clearTimeout(id);
  }, [flash]);

  const copyReport = () => {
    const text = formatDebugReport({
      appName: APP_DISPLAY_NAME,
      version: APP_VERSION,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      principalKind: host ? "loopback" : "paired",
      folderName: projectPath ? folderName(projectPath) : null,
      fileBasename: title && title !== "No model" ? title : null,
      projectPath,
      harnesses: harnesses.map((row) => ({
        label: row.label,
        status: row.status,
      })),
      theme,
      textSize,
      loadError: error,
    });
    void copyText(text).then((ok) => setFlash(ok ? "copied" : "failed"));
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">{APP_DISPLAY_NAME}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {APP_VERSION}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-8"
        onClick={copyReport}
      >
        {flash === "copied"
          ? "Copied"
          : flash === "failed"
            ? "Couldn't copy"
            : "Copy debug report"}
      </Button>
    </div>
  );
}
