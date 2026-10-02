import type { CadReview } from "@/cad/review";
import { resolveCadRef } from "@/chat/cad-refs";
import { titleRefSegments } from "@/chat/history";
import { partLabelFileStem } from "@/lib/part-label";
import { useViewer } from "@/state/viewer";

// A stable empty list: a fresh `[]` from the selector re-renders forever when no model is open.
const NO_PARTS: CadReview["parts"] = [];

export function CadRefTitle({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  const parts = useViewer((s) => s.review?.parts ?? NO_PARTS);
  const fileLabel = useViewer((s) => s.title);
  const fileStem = partLabelFileStem(parts.length, fileLabel);
  const segments = titleRefSegments(
    title,
    (ref) => resolveCadRef(ref, parts, fileStem)?.label ?? null
  );
  return (
    <span className={className} title={title}>
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <span key={`${seg.ref}-${i}`} title={seg.ref}>
            {seg.label}
          </span>
        )
      )}
    </span>
  );
}
