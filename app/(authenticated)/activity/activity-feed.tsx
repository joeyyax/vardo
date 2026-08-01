"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PageToolbar } from "@/components/page-toolbar";
import { toast } from "@/lib/messenger";
import { classifyAll } from "@/lib/activity/taxonomy";
import {
  describeWindow,
  filtersToQuery,
  hasActiveFilters,
} from "@/lib/activity/filter";
import { groupActivities } from "@/lib/activity/group";
import type {
  ActivityFacets,
  ActivityFilters,
  ActivityGroup,
  ActivityRow as ActivityRowData,
} from "@/lib/activity/types";
import { ActivityFilterBar } from "./activity-filters";
import { ActivityRow } from "./activity-row";

type ActivityFeedProps = {
  rows: ActivityRowData[];
  orgId: string;
  filters: ActivityFilters;
  /** Counted across the window, not the loaded page, so chips stay switchable. */
  facets: ActivityFacets;
  /** Events matching the filters, of which `rows` is the first page. */
  total: number;
};

const PAGE_SIZE = 50;

function dayLabel(date: Date, now: Date): string {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  if (date >= todayStart) return "Today";
  if (date >= yesterdayStart) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function byDay(groups: ActivityGroup[], now: Date) {
  const days: { label: string; items: ActivityGroup[] }[] = [];
  for (const group of groups) {
    const label = dayLabel(group.lastAt, now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(group);
    else days.push({ label, items: [group] });
  }
  return days;
}

/** States the window a `since` link opened, and offers a way out of it. */
function WindowHeader({
  since,
  filters,
  matched,
}: {
  since: Date;
  filters: ActivityFilters;
  matched: number;
}) {
  const pathname = usePathname();
  const withoutWindow = filtersToQuery({ ...filters, since: null });

  return (
    <div className="squircle rounded-lg border border-border bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">
          While you were away
          <span className="ml-2 font-normal text-muted-foreground">
            the last {describeWindow(since)}
          </span>
        </h2>
        <Link
          href={withoutWindow ? `${pathname}?${withoutWindow}` : pathname}
          scroll={false}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Show all activity
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {matched === 0
          ? "Nothing happened in this window."
          : `${matched} event${matched === 1 ? "" : "s"} since ${since.toLocaleString()}.`}
      </p>
    </div>
  );
}

export function ActivityFeed({
  rows: initialRows,
  orgId,
  filters,
  facets,
  total,
}: ActivityFeedProps) {
  const [rows, setRows] = useState(initialRows);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(initialRows.length >= total);

  // Day boundaries depend on the reader's timezone, so grouping happens here
  // rather than on the server.
  const now = useMemo(() => new Date(), []);

  const classified = useMemo(() => classifyAll(rows), [rows]);
  const groups = useMemo(() => groupActivities(classified), [classified]);
  const days = useMemo(() => byDay(groups, now), [groups, now]);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(filtersToQuery(filters));
      params.set("offset", String(rows.length));
      params.set("limit", String(PAGE_SIZE));

      const res = await fetch(
        `/api/v1/organizations/${orgId}/activities?${params}`
      );
      if (!res.ok) {
        toast.error("Could not load more activity");
        return;
      }
      const data = await res.json();
      setRows((prev) => [...prev, ...data.activities]);
      if (!data.pagination.hasMore) setExhausted(true);
    } catch {
      toast.error("Could not load more activity");
    } finally {
      setLoading(false);
    }
  }, [orgId, rows.length, filters]);

  const filtered = hasActiveFilters({ ...filters, since: null });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Activity</h1>
      </PageToolbar>

      <ActivityFilterBar
        filters={filters}
        available={facets.families}
        counts={facets.outcomes}
      />

      {filters.since && (
        <WindowHeader since={filters.since} filters={filters} matched={total} />
      )}

      {groups.length === 0 ? (
        <div className="squircle flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
          <div className="space-y-1 text-center">
            <p className="text-sm font-medium">
              {filtered || filters.since
                ? "Nothing matches this view"
                : "No activity yet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {filtered || filters.since
                ? "Try widening the filters or the time window."
                : "Deployments, configuration changes, and team actions will appear here as they happen."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {days.map((day) => (
            <section key={day.label}>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {day.label}
              </h2>
              <div className="space-y-1">
                {day.items.map((group) => (
                  <ActivityRow key={group.id} group={group} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!exhausted && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={loading}
          >
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
