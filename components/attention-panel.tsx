"use client";

import Link from "next/link";
import { AlertTriangle, ChevronDown } from "lucide-react";

export type AttentionTone = "error" | "warning" | "neutral";

export type AttentionItem = {
  id: string;
  name: string;
  href: string;
  /** Occurrences for this subject, shown only when more than one. */
  count?: number;
  /** Per-subject specifics, shown on hover. */
  detail?: string;
};

export type AttentionRow = {
  key: string;
  label: string;
  tone: AttentionTone;
  items: AttentionItem[];
  /** Sentence under the chips — what to do about it. */
  footer?: React.ReactNode;
};

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
        {present.map((row) => (
          <details key={row.key} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[row.tone]}`} />
              <span className={LABEL[row.tone]}>{row.label}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{row.items.length}</span>
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="space-y-2 bg-background-deep px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                {row.items.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    title={item.detail}
                    className="squircle rounded-md bg-card px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    {item.name}
                    {item.count !== undefined && item.count > 1 && (
                      <span className="ml-1 tabular-nums text-muted-foreground">{item.count}</span>
                    )}
                  </Link>
                ))}
              </div>
              {row.footer && <p className="text-xs text-muted-foreground">{row.footer}</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
