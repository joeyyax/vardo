"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EntityLink } from "@/components/entity-link";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { RelativeTime } from "@/components/relative-time";
import {
  checkLabel,
  expectation,
  figureTiles,
  figureWithSince,
  formatMs,
  intervalLabel,
  reportNote,
  pathLabel,
  readingDetail,
  readingLabel,
  stateLabel,
  ERROR_TEXT,
} from "@/lib/uptime/format";
import { RANGE_LABELS } from "@/lib/uptime/core/range";
import type { MonitorDetail as Detail, UptimeRange, VantageView } from "@/lib/uptime/types";
import { CheckNote, HeavyNoticeCard, ReviewCard } from "./health-parts";
import { MonitorActions } from "./monitor-actions";
import { OutageList } from "./monitor-history";
import { DayTicks, StatePill, TargetLink, Tile } from "./parts";
import { BarsCaption, UptimeRangePicker } from "./range-controls";
import { ResponseChart } from "./response-chart";

const POLL_MS = 30_000;

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function MonitorDetail({
  orgId,
  initial,
  vantages,
  canManage,
}: {
  orgId: string;
  initial: Detail;
  vantages: VantageView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const apiBase = `/api/v1/organizations/${orgId}/uptime/monitors`;
  const url = `${apiBase}/${initial.id}`;
  const [m, setM] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [range, setRange] = useState<UptimeRange>(initial.range);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${url}?range=${range}`);
      if (res.ok) {
        setM((await res.json()).monitor);
        setNow(Date.now());
      }
    } catch {
      // Keep what's shown.
    }
  }, [url, range]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh]);

  const upcoming = m.maintenance.filter((w) => w.end > now);
  const active = m.maintenance.find((w) => w.start <= now && w.end > now);

  return (
    <div className="space-y-6">
      <Link href="/uptime" className="text-sm text-muted-foreground hover:text-foreground">
        ← Uptime
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-h1 truncate">{m.name}</h1>
            <StatePill state={m.enabled ? m.state : "unknown"}>{m.enabled ? stateLabel(m.state, m.downSince) : "Off"}</StatePill>
            {m.preview && <Chip tone="info" caps={false}>Preview</Chip>}
            {m.domainRemoved && <Chip tone="warn" caps={false}>Domain removed from app</Chip>}
            {m.overrides && <Chip tone="info" caps={false}>Edited</Chip>}
          </div>
          <p className="flex flex-wrap items-center gap-x-1 break-all font-mono text-xs text-muted-foreground">
            <TargetLink monitor={m} />
            <span>
              · {checkLabel(m.check)} · {intervalLabel(m.intervalSec)} · {expectation(m.check)}
            </span>
          </p>
          <CheckNote monitor={m} />
          {(m.appName || reportNote(m.report)) && (
            <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
              {m.appName && (
                <span>
                  App <EntityLink href={`/apps/${m.appName}`} className="text-foreground">{m.appName}</EntityLink>
                </span>
              )}
              {m.appName && m.domainId && (
                <EntityLink href={`/apps/${m.appName}/networking`} className="text-muted-foreground hover:text-foreground">
                  Domain settings
                </EntityLink>
              )}
              {reportNote(m.report)}
            </p>
          )}
        </div>
        {canManage && (
          <MonitorActions monitor={m} apiBase={apiBase} vantages={vantages} now={now} onChanged={refresh} onDeleted={() => router.push("/uptime")} />
        )}
      </div>

      <ReviewCard monitor={m} apiBase={apiBase} canManage={canManage} onAnswered={refresh} />
      <HeavyNoticeCard monitor={m} apiBase={apiBase} canManage={canManage} onChanged={refresh} />

      {m.reading && (
        <Card variant="surface" className="space-y-1 p-5">
          <p className="font-medium">{readingLabel(m.reading)}</p>
          <p className="text-sm text-muted-foreground">{readingDetail(m.reading)}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {figureTiles(m.createdAt, now, { h24: m.uptime24h, d30: m.uptime30, d90: m.uptime90d }).map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} />
        ))}
        <Tile label="Response, 24h median" value={formatMs(m.medianLatency24h)} />
      </div>

      <Card variant="surface" className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="type-h3">Last {RANGE_LABELS[range]}</h2>
            <p className="text-sm text-muted-foreground tabular-nums">{figureWithSince(m.rangeUptime, m.since, now)}</p>
          </div>
          <UptimeRangePicker value={range} onChange={setRange} />
        </div>
        <DayTicks days={m.bars} barMs={m.barMs} range={m.range} tall />
        <BarsCaption range={m.range} since={m.since} now={now} bars={m.bars.length} />
      </Card>

      <Card variant="surface" className="space-y-3 p-5">
        <h2 className="type-h3">Response time</h2>
        <ResponseChart series={m.latency24h} />
      </Card>

      <Card variant="surface" className="p-0">
        <div className="p-5 pb-3">
          <h2 className="type-h3">Vantage points</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-y text-left text-xs text-muted-foreground">
                <th className="px-5 py-2 font-medium">Where</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2 pr-3 font-medium">Last result</th>
                <th className="py-2 pr-5 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {m.vantages.map((v) => (
                <tr key={`${v.id}:${v.path}`} className="border-b last:border-0">
                  <td className="px-5 py-2.5">
                    <p className="font-medium">{v.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {pathLabel(v.kind, v.path)}
                      {v.kind === "external" && v.location ? ` · ${v.location}` : ""}
                    </p>
                  </td>
                  <td className="py-2.5 pr-3">{v.state === "up" ? "Up" : v.state === "failing" ? "Failing" : "No data"}</td>
                  <td className="py-2.5 pr-3 text-muted-foreground">
                    {v.lastResult ? (
                      <>
                        {v.lastResult.ok ? `${v.lastResult.latencyMs} ms` : ERROR_TEXT[v.lastResult.error ?? "unknown"]} · <RelativeTime date={v.lastResult.at} />
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2.5 pr-5 text-muted-foreground">{v.signedAt ? <>Summary <RelativeTime date={v.signedAt} /></> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="p-5 pt-3 text-xs text-muted-foreground">
          Public results from outside decide first, then this instance. Only public results count as public uptime.
          {m.localOnly && " Only the local vantage point is reporting, so this state is local only."}
        </p>
      </Card>

      <Card variant="surface" className="space-y-3 p-5">
        <h2 className="type-h3">Outages</h2>
        <OutageList outages={m.outages} />
      </Card>

      <Card variant="surface" className="space-y-2 p-5">
        <h2 className="type-h3">Maintenance and alerts</h2>
        {(m.muted || active) && <p className="text-sm">Alerts muted. Downtime still counts toward uptime.</p>}
        {upcoming.length > 0 && (
          <ul className="text-sm text-muted-foreground">
            {upcoming.map((w) => (
              <li key={w.start}>
                Maintenance {when.format(w.start)} to {when.format(w.end)}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          {m.muted
            ? "Alerts are muted for this monitor."
            : m.channels.length > 0
              ? `Alerts go to ${m.channels.join(", ")}.`
              : "No notification channel is set up for outages."}
        </p>
      </Card>

    </div>
  );
}
