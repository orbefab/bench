import { useEffect, useState } from "react";

import { projectFileUrl } from "@/cad/loadCadReview";
import { apiFetch } from "@/lib/api";

/** Read-only source. The file is not edited here, and nothing is compiled. */
export function SourceView({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    void apiFetch(projectFileUrl(path), { cache: "no-store" })
      .then(async (res) => {
        const body = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.trim() || "Could not read that file");
          return;
        }
        setText(body);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read that file");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-1 font-mono text-xs text-muted-foreground">
        {path}
      </div>
      {error ? (
        <p className="px-3 py-2 text-sm text-error">{error}</p>
      ) : text === null ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">Reading…</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}
