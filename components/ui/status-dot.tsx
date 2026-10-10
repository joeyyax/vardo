import type { ReactNode } from "react";
import type { ChipTone } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

/** Chip tones plus `stopped`: deliberately off, drawn as the media stop square. */
export type StatusDotTone = Exclude<ChipTone, "value"> | "stopped";

// The mark's shape changes with the state, so meaning never rides on color alone.
const MARK_COLOR: Record<StatusDotTone, string> = {
  issue: "text-danger",
  warn: "text-warning",
  good: "text-success",
  neutral: "text-muted-foreground/50",
  signal: "text-primary",
  info: "text-info",
  stopped: "text-muted-foreground",
};

/** The mark alone, for a row that carries its own text. */
export function StatusMark({ tone, pending = false }: { tone: StatusDotTone; pending?: boolean }) {
  const color = pending && tone === "neutral" ? "text-muted-foreground" : MARK_COLOR[tone];
  return (
    <svg aria-hidden viewBox="0 0 12 12" className={cn("size-3 shrink-0 self-center", color)} fill="currentColor">
      {pending ? (
        <circle cx="6" cy="6" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : tone === "issue" ? (
        <path
          fillRule="evenodd"
          d="M6 1.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9ZM5.3 3.4h1.4v3.5H5.3ZM5.3 7.8h1.4v1.3H5.3Z"
        />
      ) : tone === "warn" ? (
        <path d="M6 1.6 10.6 9.6H1.4Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      ) : tone === "stopped" ? (
        <rect x="3.25" y="3.25" width="5.5" height="5.5" rx="1.25" />
      ) : (
        <circle cx="6" cy="6" r="3" />
      )}
    </svg>
  );
}

/** "at risk" → "At risk". Chips set labels in small caps; a dot label reads in sentence case. */
export function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A state in its own column: a mark and a label on every row. Neutral and stopped labels are muted. */
export function StatusDot({
  tone = "neutral",
  pending = false,
  children,
  className,
  title,
}: {
  tone?: StatusDotTone;
  /** A ring: waiting on something, not yet settled. */
  pending?: boolean;
  /** A plain string is set in sentence case. */
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm", className)} title={title}>
      <StatusMark tone={tone} pending={pending} />
      <span className={tone === "neutral" || tone === "stopped" ? "text-muted-foreground" : "text-foreground"}>
        {typeof children === "string" ? sentenceCase(children) : children}
      </span>
    </span>
  );
}
