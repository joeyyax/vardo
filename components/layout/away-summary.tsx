"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { X } from "lucide-react";

import { groupNotable, subjectSummary, type AwayGroup } from "@/lib/away/group";
import { familyLabel, kindLabel, REASON_LABELS, REASON_TONE } from "@/lib/away/labels";
import type { AwayNotable, AwayReason, AwaySummary } from "@/lib/away/types";

/** Rows shown before the list has to be expanded. */
const COLLAPSED_ROWS = 4;

/** Group size that gets its subjects named inline rather than counted. */
const NAMED_SUBJECTS = 3;

const TONE_DOT: Record<"error" | "warning" | "neutral", string> = {
  error: "bg-status-error",
  warning: "bg-status-warning",
  neutral: "bg-status-neutral",
};

/** Wire shape — dates arrive as ISO strings. */
type WireSummary = Omit<AwaySummary, "since" | "now" | "notable"> & {
  since: string;
  now: string;
  notable: (Omit<AwayNotable, "firstAt" | "lastAt"> & {
    firstAt: string;
    lastAt: string;
  })[];
};

type NotableItem = WireSummary["notable"][number];

function Row({ group }: { group: AwayGroup<NotableItem> }) {
  const reason = group.reason as AwayReason;
  const [first] = group.items;
  const many = group.items.length > 1;
  const names = group.items.map((i) => i.subjectName);
  // Few enough to name outright reads better than a count plus a second line,
  // and stops two same-sized groups looking like duplicates of each other.
  const named = group.items.length <= NAMED_SUBJECTS;

  const body = (
    <>
      <span
        aria-hidden="true"
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${TONE_DOT[REASON_TONE[reason]]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="type-body block truncate font-medium text-foreground">
          {kindLabel(group.kind)}
          <span className="text-muted-foreground">
            {" · "}
            {named ? subjectSummary(names, NAMED_SUBJECTS) : `${group.items.length} apps`}
          </span>
          {!many && first.count > 1 && (
            <span className="text-muted-foreground"> ×{first.count}</span>
          )}
        </span>
        <span className="type-body-sm block truncate text-muted-foreground">
          {REASON_LABELS[reason]}
          {group.detail ? ` · ${group.detail}` : ""}
        </span>
        {!named && (
          <span className="type-body-sm block truncate text-muted-foreground/70">
            {subjectSummary(names)}
          </span>
        )}
      </span>
    </>
  );

  const className =
    "flex items-start gap-2.5 rounded-md px-2 py-1.5 -mx-2 transition-colors";

  // A group spans several subjects, so there is no single place to link to.
  return !many && first.href ? (
    <Link href={first.href} className={`${className} hover:bg-muted`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * Reports what needed attention while the user was away. Renders nothing until
 * the server says there is something worth reporting.
 */
export function AwaySummaryBanner({ orgId }: { orgId: string }) {
  const [summary, setSummary] = useState<WireSummary | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/organizations/${orgId}/away-summary`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSummary(data?.summary ?? null))
      .catch(() => {
        // A summary that cannot load is not worth reporting on.
      });
    return () => controller.abort();
  }, [orgId]);

  function dismiss() {
    setSummary(null);
    fetch(`/api/v1/organizations/${orgId}/away-summary`, { method: "POST" }).catch(
      () => {},
    );
    const main = document.querySelector<HTMLElement>("main");
    if (main) {
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      main.focus();
    }
  }

  if (!summary || summary.notable.length === 0) return null;

  const groups = groupNotable(summary.notable);
  const shown = expanded ? groups : groups.slice(0, COLLAPSED_ROWS);
  const hidden = groups.length - shown.length;
  const away = formatDistanceToNow(new Date(summary.since));

  return (
    <section
      aria-labelledby="away-summary-heading"
      className="border-b bg-card px-5 py-4 lg:px-10"
    >
      <div className="container mx-auto max-w-screen-xl px-0">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="away-summary-heading" className="type-h3 text-foreground">
              {summary.notable.length === 1
                ? "1 thing needs a look"
                : `${summary.notable.length} things need a look`}
            </h2>
            <p className="type-label mt-1 text-brass">Last {away}</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss summary"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <ul className="space-y-0.5">
          {shown.map((group) => (
            <li key={group.key}>
              <Row group={group} />
            </li>
          ))}
        </ul>

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={expanded}
            className="type-body-sm mt-2 text-muted-foreground underline underline-offset-2 transition-opacity hover:opacity-80"
          >
            Show {hidden} more
          </button>
        )}

        {(summary.routineCount > 0 || summary.unavailable.length > 0) && (
          <p className="type-body-sm mt-3 border-t pt-3 text-muted-foreground">
            {summary.routineCount > 0 && (
              <>
                Otherwise routine:{" "}
                {summary.routine
                  .map((r) => familyLabel(r.family, r.count))
                  .join(", ")}
                .
              </>
            )}
            {summary.unavailable.length > 0 && (
              <>
                {summary.routineCount > 0 ? " " : ""}
                Could not read: {summary.unavailable.join(", ")}.
              </>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
