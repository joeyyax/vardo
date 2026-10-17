"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellOff, Bell, CalendarClock, Pencil, Trash2 } from "lucide-react";
import { EntityLink } from "@/components/entity-link";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { RelativeTime } from "@/components/relative-time";
import {
  checkLabel,
  expectation,
  formatDuration,
  formatMs,
  formatPct,
  intervalLabel,
  meshNote,
  pathLabel,
  readingDetail,
  readingLabel,
  stateLabel,
} from "@/lib/uptime/format";
import type { ErrorKind, MonitorDetail as Detail, VantageView } from "@/lib/uptime/types";
import { MaintenanceDialog } from "./maintenance-dialog";
import { MonitorSheet } from "./monitor-sheet";
import { DayTicks, StatePill, TargetLink, Tile } from "./parts";
import { ResponseChart } from "./response-chart";

const POLL_MS = 30_000;

const ERROR_TEXT: Record<ErrorKind, string> = {
  timeout: "timed out",
  dns: "DNS lookup failed",
  refused: "connection refused",
  reset: "connection reset",
  tls: "TLS error",
  "cert-expired": "certificate expired",
  "cert-expiring": "certificate expiring",
  status: "unexpected status",
  keyword: "keyword missing",
  invalid: "invalid target",
  "private-address": "private address, not checked",
  blocked: "address not allowed",
  unknown: "check failed",
};

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
  const [editing, setEditing] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        setM((await res.json()).monitor);
        setNow(Date.now());
      }
    } catch {
      // Keep what's shown.
    }
  }, [url]);

  useEffect(() => {
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function patch(path: string, body: unknown, method = "PATCH") {
    const res = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      toast.error((await res.json().catch(() => ({}))).error || "Couldn't save the change");
      return false;
    }
    await refresh();
    return true;
  }

  async function remove() {
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) {
      toast.success("Monitor deleted");
      router.push("/uptime");
    } else {
      toast.error((await res.json().catch(() => ({}))).error || "Couldn't delete the monitor");
      setDeleting(false);
    }
  }

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
          </div>
          <p className="flex flex-wrap items-center gap-x-1 break-all font-mono text-xs text-muted-foreground">
            <TargetLink monitor={m} />
            <span>
              · {checkLabel(m.check)} · {intervalLabel(m.intervalSec)} · {expectation(m.check)}
            </span>
          </p>
          {(m.appName || meshNote(m.meshBy)) && (
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
              {meshNote(m.meshBy)}
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => patch("/mute", { muted: !m.muted }, "POST")}>
              {m.muted ? <Bell /> : <BellOff />}
              {m.muted ? "Unmute alerts" : "Mute alerts"}
            </Button>
            <Button variant="outline" onClick={() => setMaintenance(true)}>
              <CalendarClock /> Schedule maintenance
            </Button>
            {m.source === "manual" ? (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="ghost" size="icon" aria-label="Delete monitor" onClick={() => setDeleting(true)}>
                  <Trash2 />
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => patch("", { enabled: !m.enabled })}>
                {m.enabled ? "Turn off" : "Turn on"}
              </Button>
            )}
          </div>
        )}
      </div>

      {m.reading && (
        <Card variant="surface" className="space-y-1 p-5">
          <p className="font-medium">{readingLabel(m.reading)}</p>
          <p className="text-sm text-muted-foreground">{readingDetail(m.reading)}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="24 hours" value={formatPct(m.uptime24h)} />
        <Tile label="30 days" value={formatPct(m.uptime30)} />
        <Tile label="90 days" value={formatPct(m.uptime90d)} />
        <Tile label="Response, 24h median" value={formatMs(m.medianLatency24h)} />
      </div>

      <Card variant="surface" className="space-y-3 p-5">
        <h2 className="type-h3">Last 90 days</h2>
        <DayTicks days={m.daily90} tall />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>90 days ago</span>
          <span>Today</span>
        </div>
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
          Public results from outside decide first, then mesh results, then this instance. Mesh and local results never count as public uptime.
          {m.localOnly && " Only the local vantage point is reporting, so this state is local only."}
        </p>
      </Card>

      <Card variant="surface" className="space-y-3 p-5">
        <h2 className="type-h3">Outages</h2>
        {m.outages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No outages in the last 14 days.</p>
        ) : (
          <ul className="divide-y">
            {m.outages.map((o) => (
              <li key={o.start} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span>
                  {when.format(o.start)} · {o.end ? `${formatDuration(o.durationMs)}` : `ongoing for ${formatDuration(o.durationMs)}`}
                </span>
                {o.incidentId && (
                  <Link href="/activity" className="text-primary hover:underline">
                    Open the incident
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
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

      <MonitorSheet open={editing} onOpenChange={setEditing} apiBase={apiBase} vantages={vantages} monitor={m} onSaved={refresh} />
      <MaintenanceDialog open={maintenance} onOpenChange={setMaintenance} url={url} windows={m.maintenance} now={now} onSaved={refresh} />
      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${m.name}?`}
        description="Its history is removed too."
        onConfirm={remove}
      />
    </div>
  );
}
