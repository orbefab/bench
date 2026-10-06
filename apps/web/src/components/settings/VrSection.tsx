import { Headset } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEnterStudio } from "@/hooks/useEnterStudio";

export function VrSection({
  host,
  onEnterQuest,
}: {
  host: boolean;
  onEnterQuest: () => void;
}) {
  const studio = useEnterStudio();
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Studio</div>
        <Button
          type="button"
          size="sm"
          disabled={!studio.available}
          title={studio.title}
          onClick={studio.enter}
        >
          <Headset />
          {studio.label}
        </Button>
      </div>
      {host ? (
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Quest</div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onEnterQuest}
          >
            <Headset />
            Enter Quest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
