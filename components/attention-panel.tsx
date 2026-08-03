"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { isInlineRow, type AttentionRow, type AttentionTone } from "@/lib/ui/attention";

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

/** Kind column, wide enough for the longest label. Subjects stack under it on phones. */
const LABEL_WIDTH = "sm:w-40";
const LABEL_COL = `w-full shrink-0 ${LABEL_WIDTH}`;

/**
 * The rows behind the attention bar. Short rows list their subjects outright;
 * long ones collapse so one broken domain does not scroll past forty updates.
 */
export function AttentionRowList({ rows }: { rows: AttentionRow[] }) {
  return (
    <div className="divide-y">
      {rows.map((row) =>
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
        {row.items.map((item) => {
          const content = (
            <>
              <span className="font-medium">{item.name}</span>
              {item.detail && <span className="text-muted-foreground">{item.detail}</span>}
              {item.since && (
                <span className="text-xs text-muted-foreground/70">
                  for {formatDistanceToNowStrict(new Date(item.since))}
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
          {row.action && (
            <Link
              href={row.action.href}
              className="ml-1 text-foreground underline underline-offset-2"
            >
              {row.action.label}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
