"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import { formatDuration, formatMs, formatPct, stateLabel } from "@/lib/uptime/format";
import type { AppUptime } from "@/lib/uptime/types";
import { DayTicks, StatePill, Tile } from "./parts";

const POLL_MS = 30_000;

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The app page's Uptime tab. */
export function AppUptimePanel({ orgId, appId, canManage }: { orgId: string; appId: string; canManage: boolean }) {
  const [data, setData] = useState<AppUptime | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/uptime/apps/${appId}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [orgId, appId]);

  useEffect(() => {
    // Loads on mount, then every 30 seconds.
    const first = setTimeout(load, 0);
    const id = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  async function toggle(monitorId: string, enabled: boolean) {
    const res = await fetch(`/api/v1/organizations/${orgId}/uptime/monitors/${monitorId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error || "Couldn't save the change");
    await load();
  }

  if (failed && !data) return <EmptyState title="Couldn't load uptime" body="Try again in a moment." />;
  if (!data) return <p className="text-sm text-muted-foreground">Loading uptime…</p>;
  if (data.monitors.length === 0) {
    return <EmptyState title="Nothing to monitor yet" body="Domains on this app are monitored automatically once they exist." />;
  }

  const single = data.monitors.length === 1 ? data.monitors[0].id : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatePill state={data.state}>
          {data.state === "down" ? (
            stateLabel("down", data.downSince)
          ) : data.state === "up" && data.lastCheckedAt ? (
            <>
              Up · checked <RelativeTime date={data.lastCheckedAt} /> from {data.vantageName === "This instance" ? "this instance" : data.vantageName}
            </>
          ) : (
            "No data yet"
          )}
        </StatePill>
        <Link href={single ? `/uptime/${single}` : "/uptime"} className="text-sm text-primary hover:underline">
          Open in Uptime
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="24 hours" value={formatPct(data.uptime24h)} />
        <Tile label="30 days" value={formatPct(data.uptime30d)} />
        <Tile label="90 days" value={formatPct(data.uptime90d)} />
        <Tile label="Response" value={formatMs(data.medianLatency24h)} sub="24h median" />
      </div>

      <Card variant="surface" className="space-y-3 p-5">
        <h2 className="type-h3">Last 90 days</h2>
        <DayTicks days={data.daily90} tall />
        <p className="text-xs text-muted-foreground">
          {data.lastOutage
            ? `Last outage: ${day.format(data.lastOutage.start)}${data.lastOutage.end ? `, ${formatDuration(data.lastOutage.end - data.lastOutage.start)}` : ", ongoing"}`
            : "No outages recorded."}
        </p>
      </Card>

      <Card variant="surface" className="p-0">
        <h2 className="type-h3 p-5 pb-3">Monitored domains</h2>
        <ul className="divide-y border-t">
          {data.monitors.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <Link href={`/uptime/${m.id}`} className="block truncate text-sm font-medium hover:underline">
                  {m.name}
                </Link>
                <p className="truncate font-mono text-xs text-muted-foreground">{m.target}</p>
                {m.preview && <p className="text-xs text-muted-foreground">Preview · removed with the preview</p>}
              </div>
              <Switch
                checked={m.enabled}
                disabled={!canManage}
                aria-label={`Monitor ${m.name}`}
                onCheckedChange={(on) => toggle(m.id, on)}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
