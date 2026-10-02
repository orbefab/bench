import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Desktop serial log for one board. TX from the shared run, plus a line
 * input. Quest does not mount it.
 */
export function SerialConsole({
  title,
  text,
  fault,
  notice,
  onNoticeClear,
  onSend,
}: {
  title: string;
  text: string;
  fault?: string;
  /** This tab's rejected send. Not a world failure. */
  notice?: string;
  onNoticeClear?: () => void;
  onSend: (line: string) => void;
}) {
  const [line, setLine] = useState("");
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <pre
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground"
        aria-label={`${title} serial output`}
      >
        {text || (fault ? "" : "Waiting for serial…")}
      </pre>
      {fault ? (
        <p className="shrink-0 px-3 pb-1 text-xs text-error">{fault}</p>
      ) : null}
      <form
        className="flex shrink-0 gap-2 border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = line;
          if (!next || fault) return;
          setLine("");
          onSend(next.endsWith("\n") ? next : `${next}\n`);
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="Serial input"
          value={line}
          placeholder="Send a line"
          disabled={Boolean(fault)}
          onChange={(event) => {
            setLine(event.target.value);
            if (notice) onNoticeClear?.();
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={Boolean(fault)}
        >
          Send
        </Button>
      </form>
      {notice ? (
        <p className="shrink-0 px-3 pb-2 text-xs text-error">{notice}</p>
      ) : null}
    </div>
  );
}
