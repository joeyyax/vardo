"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BatteryCharging, Loader2 } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { RangePicker } from "@/components/range-picker";
import { TooltipFrame, TooltipRow } from "@/components/metrics-chart";
import { CHART_COLORS, chartTickStyle, type TimeRange } from "@/lib/metrics/constants";
import { formatRelativeTime } from "@/lib/ui/relative-time";
import type { UpsHistoryPoint } from "@/lib/ups/history";
import { HEALTH_LABEL, HEALTH_TONE, fetchUpsServers, formatRuntime, type UpsServerView } from "./ups-format";

const REFRESH_MS = 15_000;

const RANGES = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
] as const satisfies readonly { value: TimeRange; label: string }[];

type Range = (typeof RANGES)[number]["value"];

const SERIES = [
  { key: "charge", label: "Charge", color: CHART_COLORS.cpu },
  { key: "load", label: "Load", color: CHART_COLORS.memory },
] as const;

const clock = (ms: number, range: Range) =>
  new Date(ms).toLocaleString([], range === "7d" ? { weekday: "short", hour: "numeric" } : { hour: "numeric", minute: "2-digit" });

export function UpsStatus() {
  const [servers, setServers] = useState<UpsServerView[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchUpsServers().then((list) => {
        if (!live) return;
        if (list) {
          setServers(list.filter((s) => s.enabled));
          setNow(Date.now());
          setError(false);
        } else setError(true);
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!servers) {
    return error ? (
      <p className="text-sm text-muted-foreground">Unable to load UPS status.</p>
    ) : (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading UPS status</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-h2">Power</h2>
          <p className="text-sm text-muted-foreground">The UPSes this host runs on, read from their NUT servers every 15 seconds.</p>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link href="/admin/settings/power">Manage UPSes</Link>
        </Button>
      </div>

      {servers.length === 0 ? (
        <EmptyState
          icon={BatteryCharging}
          title="No UPS watched yet"
          body="Add the NUT server your UPS reports to and its status shows here."
          action={
            <Button size="sm" asChild>
              <Link href="/admin/settings/power">Add UPS</Link>
            </Button>
          }
        />
      ) : (
        servers.map((s) => <UpsCard key={s.id} server={s} now={now} />)
      )}
    </div>
  );
}

function Stat({ label, value, hot = false }: { label: string; value: string; hot?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`type-numeral mt-1 text-2xl ${hot ? "text-status-error" : ""}`}>{value}</p>
    </div>
  );
}

function UpsCard({ server, now }: { server: UpsServerView; now: number }) {
  const state = server.state;
  const r = state?.reading ?? null;
  const onBattery = server.health === "on-battery" || server.health === "low-battery";
  const lastOk = state?.lastOkAt ? Date.parse(state.lastOkAt) : null;
  const flags = r?.flags ?? [];

  return (
    <Card variant="surface" className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="type-h3 truncate">{server.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {[r?.mfr, r?.model].filter(Boolean).join(" ") || server.upsName}
            <span className="font-mono"> · {server.host}:{server.port}</span>
          </p>
        </div>
        <div className="sm:text-right">
          <StatusDot tone={HEALTH_TONE[server.health]}>{HEALTH_LABEL[server.health]}</StatusDot>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {r?.status && <span className="font-mono">{r.status}</span>}
            {lastOk && <span> · read {formatRelativeTime(Math.min(lastOk, now), new Date(now))}</span>}
          </p>
        </div>
      </div>

      {server.health === "lost-contact" && (
        <Callout variant="warning" label="No reply">
          {state?.failedPolls} polls in a row failed{state?.lastError ? `: ${state.lastError}` : ""}. The figures below are from the last good reading.
        </Callout>
      )}
      {onBattery && state?.onBatterySince && (
        <Callout variant="error" label="On battery">
          Since {new Date(state.onBatterySince).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
        </Callout>
      )}
      {flags.includes("RB") && <Callout variant="warning" label="Battery">The UPS reports its battery needs replacing.</Callout>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Charge" value={r?.charge != null ? `${r.charge}%` : "—"} hot={onBattery} />
        <Stat label="Runtime" value={formatRuntime(r?.runtime)} hot={onBattery} />
        <Stat label="Load" value={r?.load != null ? `${r.load}%` : "—"} />
        <Stat label="Power" value={r?.realpower != null ? `${Math.round(r.realpower)} W` : "—"} />
        <Stat label="Input" value={r?.inputVoltage != null ? `${r.inputVoltage} V` : "—"} />
      </div>

      <UpsHistory serverId={server.id} />

      {r?.testResult && (
        <p className="text-xs text-muted-foreground">
          Last self-test: {r.testResult}
          {r.vars["ups.test.date"] ? ` (${r.vars["ups.test.date"]})` : ""}
        </p>
      )}
    </Card>
  );
}

function UpsHistory({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<Range>("6h");
  const [points, setPoints] = useState<UpsHistoryPoint[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/v1/admin/ups/${serverId}/history?range=${range}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => live && setPoints(json?.points ?? []))
        .catch(() => live && setPoints([]));
    load();
    const timer = setInterval(load, REFRESH_MS * 2);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [serverId, range]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <RangePicker options={RANGES} value={range} onChange={setRange} label="History range" />
      </div>
      {points && points.length < 2 ? (
        <Card variant="inset" className="flex h-[160px] items-center justify-center">
          <p className="text-xs text-muted-foreground">History builds up as Vardo polls the UPS.</p>
        </Card>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={points ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="at" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => clock(v, range)} tick={chartTickStyle} />
            <YAxis width={40} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={chartTickStyle} />
            <Tooltip
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipFrame label={clock(Number(label), "1h")}>
                    {payload.map((p) => (
                      <TooltipRow key={String(p.dataKey)} color={String(p.color)} label={SERIES.find((s) => s.key === p.dataKey)?.label} value={`${p.value}%`} />
                    ))}
                  </TooltipFrame>
                ) : null
              }
            />
            {SERIES.map((s) => (
              <Line key={s.key} dataKey={s.key} type="monotone" stroke={s.color} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
