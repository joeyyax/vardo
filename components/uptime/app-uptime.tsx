"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RANGE_LABELS } from "@/lib/uptime/core/range";
import { figureTiles, figureWithSince, formatDuration, formatMs, readingLabel, stateLabel } from "@/lib/uptime/format";
import type { AppUptime, UptimeRange } from "@/lib/uptime/types";
import { CheckCard } from "./check-card";
import { MonitorSheet, type CheckLink } from "./monitor-sheet";
import { DayTicks, StatePill, Tile } from "./parts";
import { BarsCaption, UptimeRangePicker } from "./range-controls";

const POLL_MS = 30_000;

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The app page's Uptime tab. Every check of the app is managed here: the domains' automatic checks and the ones added by hand.
 * The same monitors appear in the Uptime page, which renders the same components.
 */
export function AppUptimePanel({ orgId, appId, canManage }: { orgId: string; appId: string; canManage: boolean }) {
  const [data, setData] = useState<AppUptime | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<UptimeRange | null>(null);
  const [adding, setAdding] = useState(false);
  const apiBase = `/api/v1/organizations/${orgId}/uptime/monitors`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/uptime/apps/${appId}${range ? `?range=${range}` : ""}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
      setNow(Date.now());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [orgId, appId, range]);

  useEffect(() => {
    // Loads on mount, then every 30 seconds.
    const first = setTimeout(load, 0);
    const id = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  if (failed && !data) return <EmptyState title="Couldn't load uptime" body="Try again in a moment." />;
  if (!data) return <p className="text-sm text-muted-foreground">Loading uptime…</p>;

  const link: CheckLink = {
    appId,
    domains: data.monitors.filter((m) => m.source === "auto" && m.domainId && !m.preview).map((m) => ({ id: m.domainId!, host: m.name.split("/")[0] })),
  };
  const sheet = <MonitorSheet open={adding} onOpenChange={setAdding} apiBase={apiBase} vantages={[]} checkedFrom={data.vantageName ?? undefined} link={link} onSaved={load} />;

  if (data.monitors.length === 0) {
    return (
      <>
        <EmptyState
          title="Nothing to monitor yet"
          body="Domains on this app are monitored automatically once they exist. You can add a check by hand."
          action={canManage ? <Button onClick={() => setAdding(true)}>Add check</Button> : undefined}
        />
        {sheet}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatePill state={data.state}>
          {data.state === "down" ? (
            stateLabel("down", data.downSince)
          ) : data.state === "degraded" ? (
            (data.reading ? readingLabel(data.reading) : "Degraded")
          ) : data.state === "up" && data.lastCheckedAt ? (
            <>
              Up · checked <RelativeTime date={data.lastCheckedAt} /> from {data.vantageName}
            </>
          ) : (
            "No data yet"
          )}
        </StatePill>
        <div className="flex items-center gap-3">
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Add check
            </Button>
          )}
          <Link href="/uptime" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            View in Uptime
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {figureTiles(data.historyStart, now, { h24: data.uptime24h, d30: data.uptime30d, d90: data.uptime90d }).map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} />
        ))}
        <Tile label="Response" value={formatMs(data.medianLatency24h)} sub="24h median" />
      </div>

      <Card variant="surface" className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="type-h3">Last {RANGE_LABELS[data.range]}</h2>
            <p className="text-sm text-muted-foreground tabular-nums">{figureWithSince(data.rangeUptime, data.since, now)}</p>
          </div>
          <UptimeRangePicker value={data.range} onChange={setRange} />
        </div>
        <DayTicks days={data.bars} barMs={data.barMs} range={data.range} tall />
        <BarsCaption range={data.range} since={data.since} now={now} bars={data.bars.length} />
        <p className="text-xs text-muted-foreground">
          {data.lastOutage
            ? `Last outage: ${day.format(data.lastOutage.start)}${data.lastOutage.end ? `, ${formatDuration(data.lastOutage.end - data.lastOutage.start)}` : ", ongoing"}`
            : "No outages recorded."}
        </p>
      </Card>

      <Card variant="surface" className="p-0">
        <h2 className="type-h3 p-5 pb-3">Checks</h2>
        <ul className="divide-y border-t">
          {data.monitors.map((m) => (
            <CheckCard key={m.id} monitor={m} apiBase={apiBase} canManage={canManage} vantages={[]} checkedFrom={data.vantageName ?? undefined} now={now} onChanged={load} />
          ))}
        </ul>
      </Card>
      {sheet}
    </div>
  );
}
