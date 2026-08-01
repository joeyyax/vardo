"use client";

import Link from "next/link";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { isInlineRow, type AttentionRow, type AttentionTone } from "@/lib/ui/attention";

const TONE_RANK: Record<AttentionTone, number> = { error: 0, warning: 1, neutral: 2 };

const DOT: Record<AttentionTone, string> = {
  error: "bg-status-error",
  warning: "bg-status-warning",
  neutral: "bg-muted-foreground/40",
};

const LABEL: Record<AttentionTone, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  neutral: "text-foreground",
};

/** Kind column, wide enough for the longest label. Subjects stack under it on phones. */
const LABEL_WIDTH = "sm:w-40";
const LABEL_COL = `w-full shrink-0 ${LABEL_WIDTH}`;

/**
 * Every fleet-wide notice in one place, worst first. Faults are counted in the
 * header; an available update is a fact, not a fault, so it is listed without
 * being counted.
 */
export function AttentionPanel({ rows }: { rows: AttentionRow[] }) {
  const present = rows
    .filter((r) => r.items.length > 0)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.label.localeCompare(b.label));

  if (present.length === 0) return null;

  const faults = present
    .filter((r) => r.tone !== "neutral")
    .reduce((n, r) => n + r.items.length, 0);
  const worst = present[0].tone;

  return (
    <section
      id="attention"
      aria-label="Needs attention"
      className={`squircle scroll-mt-24 overflow-hidden rounded-lg border bg-card text-sm ${
        worst === "error"
          ? "border-status-error/40"
          : worst === "warning"
            ? "border-status-warning/40"
            : "border-border"
      }`}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        {faults > 0 && (
          <AlertTriangle
            aria-hidden="true"
            className={`size-4 shrink-0 ${worst === "error" ? "text-status-error" : "text-status-warning"}`}
          />
        )}
        <h2 className="font-medium">
          {faults === 0
            ? "Nothing needs attention"
            : `${faults} thing${faults === 1 ? "" : "s"} need${faults === 1 ? "s" : ""} attention`}
        </h2>
      </header>

      <div className="divide-y">
        {present.map((row) =>
          isInlineRow(row) ? (
            <div key={row.key} className="flex flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2">
              <span className={`${LABEL_COL} flex items-center gap-2 ${LABEL[row.tone]}`}>
                <Dot tone={row.tone} />
                {row.label}
              </span>
              <Subjects row={row} />
            </div>
          ) : (
            <details key={row.key} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <Dot tone={row.tone} />
                <span className={LABEL[row.tone]}>{row.label}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {row.items.length}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="flex items-start gap-x-2 px-3 pb-2.5">
                <span aria-hidden="true" className={`hidden shrink-0 sm:block ${LABEL_WIDTH}`} />
                <Subjects row={row} wide />
              </div>
            </details>
          ),
        )}
      </div>
    </section>
  );
}

function Dot({ tone }: { tone: AttentionTone }) {
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />;
}

/** One line per subject: who, what is wrong, and how long it has been wrong. */
function Subjects({ row, wide = false }: { row: AttentionRow; wide?: boolean }) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5 pl-4 sm:pl-0">
      <ul className={wide ? "gap-x-8 sm:columns-2 xl:columns-3" : "space-y-1"}>
        {row.items.map((item) => (
          <li key={item.id} className={wide ? "mb-1 break-inside-avoid" : undefined}>
            <Link
              href={item.href}
              className="squircle -mx-1.5 flex flex-wrap items-baseline gap-x-2 rounded-md px-1.5 transition-colors hover:bg-muted/60"
            >
              <span className="font-medium">{item.name}</span>
              {item.detail && <span className="text-muted-foreground">{item.detail}</span>}
              {item.since && (
                <span className="text-xs text-muted-foreground/70">
                  for {formatDistanceToNowStrict(new Date(item.since))}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {row.footer && <p className="text-xs text-muted-foreground">{row.footer}</p>}
    </div>
  );
}
