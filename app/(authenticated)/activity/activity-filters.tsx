"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  clearChips,
  filtersToQuery,
  hasActiveFilters,
  toggleFamily,
  toggleOutcome,
} from "@/lib/activity/filter";
import { FAMILY_LABELS } from "@/lib/activity/taxonomy";
import { OUTCOME_LABELS } from "@/lib/activity/labels";
import type {
  ActivityFamily,
  ActivityFilters,
  ActivityOutcome,
} from "@/lib/activity/types";

type ActivityFiltersProps = {
  filters: ActivityFilters;
  /** Families with rows in the loaded set, so no chip leads to an empty view. */
  available: ActivityFamily[];
  counts: Record<ActivityOutcome, number>;
};

const OUTCOME_CHIPS: ActivityOutcome[] = ["failure", "success"];

const CHIP_BASE =
  "squircle inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

function Chip({
  href,
  active,
  children,
  tone = "neutral",
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  tone?: "neutral" | "error" | "success";
}) {
  const activeClass =
    tone === "error"
      ? "border-status-error/40 bg-status-error-muted text-status-error"
      : tone === "success"
        ? "border-status-success/40 bg-status-success-muted text-status-success"
        : "border-foreground/20 bg-muted text-foreground";

  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`${CHIP_BASE} ${
        active
          ? activeClass
          : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

export function ActivityFilterBar({
  filters,
  available,
  counts,
}: ActivityFiltersProps) {
  const pathname = usePathname();

  const hrefFor = (next: ActivityFilters) => {
    const query = filtersToQuery(next);
    return query ? `${pathname}?${query}` : pathname;
  };

  // Keep a chip visible when it is on but its rows fell outside the window.
  const families = available
    .concat(filters.families.filter((f) => !available.includes(f)))
    .sort();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by outcome">
        {/* A zero-count chip can only ever produce an empty list. It stays when
            already selected, so turning it off is still possible. */}
        {OUTCOME_CHIPS.filter(
          (outcome) => counts[outcome] > 0 || filters.outcomes.includes(outcome),
        ).map((outcome) => (
          <Chip
            key={outcome}
            href={hrefFor(toggleOutcome(filters, outcome))}
            active={filters.outcomes.includes(outcome)}
            tone={outcome === "failure" ? "error" : "success"}
          >
            {OUTCOME_LABELS[outcome]}
            <span className="tabular-nums opacity-60">{counts[outcome]}</span>
          </Chip>
        ))}
      </div>

      {families.length > 1 && (
        <>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by family">
            {families.map((family) => (
              <Chip
                key={family}
                href={hrefFor(toggleFamily(filters, family))}
                active={filters.families.includes(family)}
              >
                {FAMILY_LABELS[family]}
              </Chip>
            ))}
          </div>
        </>
      )}

      {hasActiveFilters({ ...filters, since: null }) && (
        <Link
          href={hrefFor(clearChips(filters))}
          scroll={false}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Clear filters
        </Link>
      )}
    </div>
  );
}
