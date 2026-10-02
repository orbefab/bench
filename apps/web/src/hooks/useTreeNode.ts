import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { Object3D } from "three";

import { useViewer } from "@/state/viewer";

/** Tree row open state that expands itself when the selection lives below `obj`. */
export function useOpenOnSelect(
  obj: Object3D
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const review = useViewer((s) => s.review);
  const selectedId = useViewer((s) => s.selectedId);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!review || selectedId === null) return;
    const selected = review.parts[selectedId]?.object;
    if (!selected || selected === obj) return;
    let cur: Object3D | null = selected;
    while (cur) {
      if (cur === obj) {
        setOpen(true);
        return;
      }
      cur = cur.parent;
    }
  }, [review, selectedId, obj]);
  return [open, setOpen];
}
