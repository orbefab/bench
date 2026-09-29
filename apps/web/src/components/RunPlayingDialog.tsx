import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * The ask a playing run gets before something drops or restarts it. The
 * caller says what will happen; Stay and Stop and continue are the same
 * everywhere.
 */
export function RunPlayingDialog({
  description,
  onStay,
  onStop,
}: {
  description: string;
  onStay: () => void;
  onStop: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>This run is still playing</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onStay}>
            Stay
          </Button>
          <Button type="button" onClick={onStop}>
            Stop and continue
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
