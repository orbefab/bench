/** Small pieces every inspector card shares: the section frame, a field row, the warning list, and the readout texts. */
import type { ReactNode } from "react";
import type { PathWarning } from "@/lib/world-warnings";

export function SoaLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="mb-1.5 break-words font-mono text-[12px] text-amber-800 dark:text-amber-400">
      {text}
    </p>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5 min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[12px]" title={value}>
        {value}
      </div>
    </div>
  );
}

export function pulseText(us: number | null): string {
  if (us === null) return "No signal";
  return `${Math.round(us)} µs`;
}

export function commandText(deg: number | null): string {
  if (deg === null) return "—";
  const shown = Math.round(deg * 10) / 10;
  return `${shown.toFixed(1)}°`;
}

export function voltsText(voltage: number): string {
  return `${voltage.toFixed(2)} V`;
}

export function socText(soc: number): string {
  return `${(soc * 100).toFixed(1)}%`;
}

export function motionText(state: string | undefined): string {
  if (state === "idle" || state === "moving" || state === "stall") return state;
  return "—";
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="mb-1 text-[11px] text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

export function WarningList({ rows }: { rows: readonly PathWarning[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title="Warnings">
      {rows.map((row) => (
        <p
          key={`${row.code ?? ""}:${row.message}`}
          className="mb-1.5 min-w-0 break-words text-[12px]"
        >
          {row.message}
        </p>
      ))}
    </Section>
  );
}
