"use client";

import { useState, useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
};

type ResourceStatus = {
  name: string;
  current: number;
  total: number;
  percent: number;
  unit: string;
  status: "ok" | "warning" | "critical";
};

type RuntimeInfo = {
  nodeVersion: string;
  nextVersion: string;
  platform: string;
  arch: string;
  uptime: number;
  memoryUsage: number;
  memoryHeapUsed: number;
  memoryHeapTotal: number;
  pid: number;
};

type OverviewData = {
  stats: {
    userCount: number;
    appCount: number;
    deploymentCount: number;
    templateCount: number;
  };
  services: ServiceStatus[];
  resources: ResourceStatus[];
  runtime: RuntimeInfo;
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "healthy" || status === "ok"
      ? "bg-status-success"
      : status === "unhealthy" || status === "critical"
        ? "bg-status-error"
        : status === "warning"
          ? "bg-status-warning"
          : "bg-status-neutral";
  return <span className={`size-2 rounded-full shrink-0 ${color}`} />;
}

function StatusLabel({ status }: { status: string }) {
  const color =
    status === "healthy" || status === "ok"
      ? "text-status-success"
      : status === "unhealthy" || status === "critical"
        ? "text-status-error"
        : status === "warning"
          ? "text-status-warning"
          : "text-muted-foreground";
  const label =
    status === "healthy"
      ? "Healthy"
      : status === "unhealthy"
        ? "Unhealthy"
        : status === "unconfigured"
          ? "Not configured"
          : status === "ok"
            ? "OK"
            : status === "warning"
              ? "Warning"
              : status === "critical"
                ? "Critical"
                : status;
  return <span className={`text-xs font-medium ${color}`}>{label}</span>;
}

export function OverviewSettings() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState(false);

  async function fetchData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/v1/admin/overview");
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setData({
        stats: json.stats,
        services: json.services ?? [],
        resources: json.resources ?? [],
        runtime: json.runtime ?? null,
      });
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading system overview</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Unable to load system overview.</p>
        <Button variant="outline" className="squircle" onClick={() => fetchData(true)}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Overview</h2>
          <p className="text-sm text-muted-foreground">
            System health and resource usage at a glance.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchData(true)}
          disabled={refreshing}
          aria-label="Refresh system overview"
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Users", value: data.stats.userCount },
          { label: "Apps", value: data.stats.appCount },
          { label: "Deployments", value: data.stats.deploymentCount },
          { label: "Templates", value: data.stats.templateCount },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border p-4 space-y-1">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Service health */}
      <div className="space-y-3">
        <p className="text-sm font-medium">Service health</p>
        <div className="rounded-lg border overflow-hidden divide-y">
          {data.services.length > 0 ? (
            data.services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <StatusDot status={svc.status} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{svc.name}</p>
                    <p className="text-xs text-muted-foreground">{svc.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {svc.latencyMs !== undefined && svc.status === "healthy" && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {svc.latencyMs}ms
                    </span>
                  )}
                  <StatusLabel status={svc.status} />
                </div>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Unable to load service status.
            </div>
          )}
        </div>
      </div>

      {/* Resource usage */}
      {data.resources.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Resource usage</p>
          <div className="rounded-lg border overflow-hidden divide-y">
            {data.resources.map((res) => (
              <div key={res.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <StatusDot status={res.status} />
                  <p className="text-sm font-medium">{res.name}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {res.unit === "bytes"
                      ? `${formatBytes(res.current)} / ${formatBytes(res.total)}`
                      : `${res.current}${res.unit} / ${res.total}${res.unit}`}
                  </span>
                  <span className="text-xs font-medium tabular-nums w-12 text-right">
                    {res.percent}%
                  </span>
                  <StatusLabel status={res.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Runtime info */}
      {data.runtime && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Runtime</p>
          <div className="rounded-lg border overflow-hidden divide-y">
            {[
              { label: "Node.js", value: data.runtime.nodeVersion },
              { label: "Next.js", value: `v${data.runtime.nextVersion}` },
              { label: "Platform", value: `${data.runtime.platform} / ${data.runtime.arch}` },
              { label: "Uptime", value: formatUptime(data.runtime.uptime) },
              { label: "Memory (RSS)", value: formatBytes(data.runtime.memoryUsage) },
              {
                label: "Heap",
                value: `${formatBytes(data.runtime.memoryHeapUsed)} / ${formatBytes(data.runtime.memoryHeapTotal)}`,
              },
              { label: "PID", value: String(data.runtime.pid) },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between px-4 py-2.5">
                <p className="text-sm text-muted-foreground">{item.label}</p>
                <p className="text-sm font-medium tabular-nums">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
