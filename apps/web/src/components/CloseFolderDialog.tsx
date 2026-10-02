import { useEffect, useState } from "react";

import { useViewerChat } from "@/components/chat/useViewerChat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useProjectSession } from "@/hooks/useProjectSession";
import {
  CLOSE_FOLDER_BODY,
  CLOSE_FOLDER_EVENT,
  closeFolderNeedsConfirm,
  closeFolderTitle,
} from "@/lib/motion";
import { closeTabProject, folderName } from "@/lib/project";
import { useViewer } from "@/state/viewer";

export function CloseFolderDialog() {
  const [open, setOpen] = useState(false);
  const path = useProjectSession().project.path;
  const url = useViewer((s) => s.url);
  const { tabStreaming } = useViewerChat();

  useEffect(() => {
    const onClose = () => {
      if (!path) return;
      if (
        closeFolderNeedsConfirm({
          hasModel: Boolean(url),
          replyInProgress: tabStreaming,
        })
      ) {
        setOpen(true);
        return;
      }
      closeTabProject();
    };
    window.addEventListener(CLOSE_FOLDER_EVENT, onClose);
    return () => window.removeEventListener(CLOSE_FOLDER_EVENT, onClose);
  }, [path, url, tabStreaming]);

  const confirm = () => {
    setOpen(false);
    closeTabProject();
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => setOpen(next)}>
      <AlertDialogContent className="max-w-sm gap-3">
        <AlertDialogTitle>
          {closeFolderTitle(folderName(path))}
        </AlertDialogTitle>
        <AlertDialogDescription>{CLOSE_FOLDER_BODY}</AlertDialogDescription>
        <div className="flex justify-end gap-2">
          <AlertDialogClose
            render={<Button type="button" size="sm" variant="outline" />}
          >
            Cancel
          </AlertDialogClose>
          <Button type="button" size="sm" onClick={confirm}>
            Close folder
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
