"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { EntityLink } from "@/components/entity-link";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageToolbar } from "@/components/page-toolbar";
import { RangePicker } from "@/components/range-picker";
import { averageUptime, checkLabel, formatMs, formatPct, intervalLabel, intervalPhrase, meshNote, readingLabel, vantageNames } from "@/lib/uptime/format";
import { sinceLabel } from "@/lib/uptime/core/range";
import type { MonitorSummary, UptimeRange, VantageView } from "@/lib/uptime/types";
import { CheckNote } from "./health-parts";
import { UptimeRangePicker } from "./range-controls";
import { DayTicks, StateMark, TargetLink, Tile } from "./parts";
import { MonitorSheet } from "./monitor-sheet";

type Filter = "all" | "down" | "review" | "muted" | "previews";

const POLL_MS = 30_000;

export function UptimeMonitors({
  orgId,
  initialMonitors,
  vantages,
  canManage,
}: {
  orgId: string;
  initialMonitors: MonitorSummary[];
  vantages: VantageView[];
  canManage: boolean;
}) {
  const apiBase = `/api/v1/organizations/${orgId}/uptime/monitors`;
  const [monitors, setMonitors] = useState(initialMonitors);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<UptimeRange>(initialMonitors[0]?.range ?? "30d");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}?range=${range}`);
      if (res.ok) {
        setMonitors((await res.json()).monitors);
        setNow(Date.now());
      }
    } catch {
      // Keep what's shown.
    }
  }, [apiBase, range]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh]);

  const active = monitors.filter((m) => m.enabled);
  const down = active.filter((m) => m.state === "down" || m.state === "degraded").length;
  const up = active.filter((m) => m.state === "up").length;
  const counts: Record<Filter, number> = {
    all: monitors.length,
    down,
    review: active.filter((m) => m.state === "review").length,
    muted: monitors.filter((m) => m.muted).length,
    previews: monitors.filter((m) => m.preview).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return monitors.filter((m) => {
      if (filter === "down" && !(m.enabled && (m.state === "down" || m.state === "degraded"))) return false;
      if (filter === "review" && !(m.enabled && m.state === "review")) return false;
      if (filter === "muted" && !m.muted) return false;
      if (filter === "previews" && !m.preview) return false;
      return !q || m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q);
    });
  }, [monitors, filter, query]);

  const interval = monitors.reduce((min, m) => Math.min(min, m.intervalSec), 60);
  const hasExternal = vantages.some((v) => v.kind === "external");

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          canManage && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add monitor
            </Button>
          )
        }
      >
        <div>
          <h1 className="type-h1">Uptime</h1>
          <p className="type-body-sm mt-1 text-muted-foreground">
            Checked {intervalPhrase(interval)} from {vantageNames(vantages)}.
          </p>
        </div>
      </PageToolbar>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Down" value={down} tone={down > 0 ? "text-danger" : undefined} />
        <Tile label="Up" value={up} />
        <Tile label={`Uptime, ${range}`} value={formatPct(averageUptime(active.map((m) => m.rangeUptime)))} />
        <Tile label="Vantage points" value={vantages.length} sub={hasExternal ? undefined : "Local only"} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker
          label="Filter monitors"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "down", label: counts.down ? `Down ${counts.down}` : "Down" },
            ...(counts.review ? [{ value: "review" as const, label: `Needs review ${counts.review}` }] : []),
            { value: "muted", label: counts.muted ? `Muted ${counts.muted}` : "Muted" },
            { value: "previews", label: counts.previews ? `Previews ${counts.previews}` : "Previews" },
          ]}
        />
        <UptimeRangePicker value={range} onChange={setRange} />
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search monitors" className="pl-9" aria-label="Search monitors" />
        </div>
      </div>

      {monitors.length === 0 ? (
        <EmptyState
          title="No monitors yet"
          body="Apps with a domain get one automatically once their checks start. You can also add any URL or port."
          action={canManage ? <Button onClick={() => setAdding(true)}>Add monitor</Button> : undefined}
        />
      ) : shown.length === 0 ? (
        <EmptyState title="No monitors match" body="Change the filter or the search." />
      ) : (
        <div className="squircle overflow-x-auto rounded-lg bg-card shadow-card dark:border">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-8 py-2.5 pl-4 font-medium"><span className="sr-only">State</span></th>
                <th className="py-2.5 pr-3 font-medium">Monitor</th>
                <th className="hidden w-64 py-2.5 pr-3 font-medium lg:table-cell">Last {range}</th>
                <th className="py-2.5 pr-3 text-right font-medium">Uptime</th>
                <th className="py-2.5 pr-3 text-right font-medium">Response</th>
                <th className="hidden py-2.5 pr-4 font-medium md:table-cell">Check</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id} className="relative border-b last:border-0 hover:bg-row-hover">
                  <td className="py-3 pl-4">
                    <StateMark state={m.enabled ? m.state : "unknown"} />
                  </td>
                  <td className="max-w-[18rem] py-3 pr-3">
                    <Link href={`/uptime/${m.id}`} className="flex items-center gap-2 font-medium before:absolute before:inset-0 hover:underline">
                      <span className="truncate">{m.name}</span>
                      {m.preview && <Chip tone="info" caps={false}>Preview</Chip>}
                      {m.muted && <Chip tone="neutral" caps={false}>Muted</Chip>}
                      {!m.enabled && <Chip tone="neutral" caps={false}>Off</Chip>}
                      {m.overrides && <Chip tone="info" caps={false}>Edited</Chip>}
                      {m.domainRemoved && <Chip tone="warn" caps={false}>Domain removed from app</Chip>}
                    </Link>
                    <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex min-w-0 font-mono">
                        <TargetLink monitor={m} />
                      </span>
                      {m.appName && (
                        <EntityLink href={`/apps/${m.appName}`} className="relative z-10 shrink-0">
                          {m.appName}
                        </EntityLink>
                      )}
                    </p>
                    <CheckNote monitor={m} />
                    {(m.reading || m.meshBy.length > 0) && (
                      <p className="truncate text-xs text-muted-foreground">{[m.reading && readingLabel(m.reading), meshNote(m.meshBy)].filter(Boolean).join(" · ")}</p>
                    )}
                  </td>
                  <td className="hidden py-3 pr-3 lg:table-cell">
                    <DayTicks days={m.bars} barMs={m.barMs} range={m.range} />
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums" title={m.since !== null ? `Since ${sinceLabel(m.since, now)}` : undefined}>
                    {formatPct(m.rangeUptime)}
                    {m.since !== null && <span className="block text-xs text-muted-foreground">since {sinceLabel(m.since, now)}</span>}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-muted-foreground">{formatMs(m.latencyMs)}</td>
                  <td className="hidden py-3 pr-4 text-muted-foreground md:table-cell">
                    {checkLabel(m.check)} · {intervalLabel(m.intervalSec)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MonitorSheet open={adding} onOpenChange={setAdding} apiBase={apiBase} vantages={vantages} onSaved={refresh} />
    </div>
  );
}
