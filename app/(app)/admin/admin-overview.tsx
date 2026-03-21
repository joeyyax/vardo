"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Sparkline } from "@/components/app-metrics-card";
import { formatBytes } from "@/lib/metrics/format";
import type { ResourceStatus, ServiceStatus } from "@/lib/config/health";

type Stats = {
  userCount: number;
  appCount: number;
  deploymentCount: number;
  templateCount: number;
};

type OverviewData = {
  stats: Stats;
  sparklines: Record<string, [number, number][]>;
  resources: ResourceStatus[];
  services: ServiceStatus[];
};

const statCardConfig = [
  { key: "userCount" as const, label: "Users", sparklineKey: "users", color: "oklch(0.65 0.18 290)" },
  { key: "appCount" as const, label: "Apps", sparklineKey: "apps", color: "oklch(0.68 0.16 175)" },
  { key: "deploymentCount" as const, label: "Deployments", sparklineKey: "deployments", color: "oklch(0.67 0.17 120)" },
  { key: "templateCount" as const, label: "Templates", sparklineKey: null, color: "oklch(0.65 0.16 335)" },
];

export function AdminOverview() {
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/overview")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCardConfig.map((stat) => {
          const sparklineData = stat.sparklineKey ? data.sparklines[stat.sparklineKey]?.map(([, v]) => v) : null;
          return (
            <div key={stat.label} className="squircle relative rounded-lg border bg-card p-4 overflow-hidden">
              {sparklineData && sparklineData.length > 0 && (
                <Sparkline
                  data={sparklineData}
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  style={{ color: stat.color }}
                />
              )}
              <div className="relative">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="text-2xl font-semibold tabular-nums mt-1">{data.stats[stat.key]}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resource bars */}
      {data.resources.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3 mt-4">
          {data.resources.map((res) => (
            <div key={res.name} className="squircle rounded-lg border bg-card p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-muted-foreground">{res.name}</p>
                <span className={`text-xs font-medium ${
                  res.status === "critical" ? "text-status-error" :
                  res.status === "warning" ? "text-status-warning" :
                  "text-status-success"
                }`}>{res.percent}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    res.status === "critical" ? "bg-status-error" :
                    res.status === "warning" ? "bg-status-warning" :
                    "bg-status-success"
                  }`}
                  style={{ width: `${Math.min(res.percent, 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 tabular-nums">
                {res.unit === "bytes"
                  ? `${formatBytes(res.current)} / ${formatBytes(res.total)}`
                  : `${res.current}${res.unit} / ${res.total}${res.unit}`}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Service dots */}
      <div className="flex flex-wrap items-center gap-3 mt-4">
        {data.services.map((svc) => (
          <div key={svc.name} className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${
              svc.status === "healthy" ? "bg-status-success" :
              svc.status === "unhealthy" ? "bg-status-error" :
              "bg-status-neutral"
            }`} />
            <span className="text-xs text-muted-foreground">{svc.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
