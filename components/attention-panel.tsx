"use client";

import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import Link from "next/link";
import {  } from "lucide-react";

import { isInlineRow, type AttentionRow, type AttentionTone } from "@/lib/ui/attention";
import { formatSpan } from "@/lib/ui/relative-time";
import { AttentionActionLink } from "./attention-action";
import { cn } from "@/lib/utils";

const DOT: Record<AttentionTone, string> = {
  error: "bg-status-error",
  warning: "bg-status-warning",
  neutral: "bg-muted-foreground/40",
  activity: "bg-status-info",
};

const LABEL: Record<AttentionTone, string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  neutral: "text-foreground",
  activity: "text-status-info",
};

/** Kind column width. Subjects stack under it on phones. */
const LABEL_WIDTH = "sm:w-40";
const LABEL_COL = `w-full shrink-0 ${LABEL_WIDTH}`;

/** The rows behind the attention bar. Long rows collapse. */
export function AttentionRowList({ rows, highlight = null }: { rows: AttentionRow[]; highlight?: string | null }) {
  const mark = (key: string) => (key === highlight ? "rounded-lg bg-brass-muted" : undefined);
  return (
    <div className="divide-y">
      {rows.map((row) =>
        isInlineRow(row) ? (
          <div
            key={row.key}
            data-attention-target={row.key}
            className={cn("flex scroll-mt-4 flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2", mark(row.key))}
          >
            <span className={`${LABEL_COL} flex items-center gap-2 ${LABEL[row.tone]}`}>
              <Dot tone={row.tone} />
              {row.label}
            </span>
            <Subjects row={row} />
          </div>
        ) : (
          <details
            key={row.key}
            data-attention-target={row.key}
            open={row.key === highlight || undefined}
            className={cn("group scroll-mt-4", mark(row.key))}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
              <Dot tone={row.tone} />
              <span className={LABEL[row.tone]}>{row.label}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {row.items.length}
              </span>
              <DisclosureChevron />
            </summary>
            <div className="flex items-start gap-x-2 px-3 pb-2.5">
              <span aria-hidden="true" className={`hidden shrink-0 sm:block ${LABEL_WIDTH}`} />
              <Subjects row={row} wide />
            </div>
          </details>
        ),
      )}
    </div>
  );
}

function Dot({ tone }: { tone: AttentionTone }) {
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />;
}

/** One line per subject: who, what is wrong and how long it has been wrong. */
function Subjects({ row, wide = false }: { row: AttentionRow; wide?: boolean }) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5 pl-4 sm:pl-0">
      <ul className={wide ? "gap-x-8 sm:columns-2 xl:columns-3" : "space-y-1"}>
        {row.items.map((item) => {
          const content = (
            <>
              <span className="font-medium">{item.name}</span>
              {item.detail && <span className="text-muted-foreground">{item.detail}</span>}
              {item.since && (
                <span className="text-xs text-muted-foreground/70">
                  for {formatSpan(item.since)}
                </span>
              )}
            </>
          );
          const className =
            "squircle -mx-1.5 flex flex-wrap items-baseline gap-x-2 rounded-md px-1.5 transition-colors hover:bg-muted/60";
          return (
            <li key={item.id} className={wide ? "mb-1 break-inside-avoid" : undefined}>
              {!item.href ? (
                <span className={className}>{content}</span>
              ) : item.external ? (
                <a href={item.href} target="_blank" rel="noopener noreferrer" className={className}>
                  {content}
                </a>
              ) : (
                <Link href={item.href} className={className}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {(row.footer || row.action) && (
        <p className="text-xs text-muted-foreground">
          {row.footer}
          {row.action && <AttentionActionLink action={row.action} />}
        </p>
      )}
    </div>
  );
}
