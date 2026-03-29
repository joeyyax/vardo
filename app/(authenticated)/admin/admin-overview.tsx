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

const statCardConfig = [
  { key: "userCount" as const, label: "Users", sparklineKey: "users", color: "oklch(0.65 0.18 290)" },
  { key: "appCount" as const, label: "Apps", sparklineKey: "apps", color: "oklch(0.68 0.16 175)" },
  { key: "deploymentCount" as const, label: "Deployments", sparklineKey: "deployments", color: "oklch(0.67 0.17 120)" },
  { key: "templateCount" as const, label: "Templates", sparklineKey: null, color: "oklch(0.65 0.16 335)" },
];

export function AdminOverview() {
  // Each section loads independently
  const [stats, setStats] = useState<Stats | null>(null);
  const [sparklines, setSparklines] = useState<Record<string, [number, number][]> | null>(null);
  const [resources, setResources] = useState<ResourceStatus[] | null>(null);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/overview")
      .then((r) => r.json())
      .then((data) => {
        // Set each piece as it arrives from the single response
        setStats(data.stats);
        setSparklines(data.sparklines);
        setResources(data.resources);
        setServices(data.services);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      {/* Stat cards — show structure immediately, fill in data */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCardConfig.map((stat) => {
          const sparklineData = sparklines && stat.sparklineKey
            ? sparklines[stat.sparklineKey]?.map(([, v]) => v)
            : null;
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
                <p className="text-2xl font-semibold tabular-nums mt-1">
                  {stats ? stats[stat.key] : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resource bars — show when ready */}
      <div className="grid gap-4 sm:grid-cols-3 mt-4">
        {resources ? (
          resources.map((res) => (
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
          ))
        ) : (
          // Skeleton cards
          ["CPU", "Memory", "Disk"].map((name) => (
            <div key={name} className="squircle rounded-lg border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-2">{name}</p>
              <div className="h-1.5 rounded-full bg-muted" />
              <div className="h-3 w-24 bg-muted rounded mt-2" />
            </div>
          ))
        )}
      </div>

      {/* Service dots */}
      <div className="flex flex-wrap items-center gap-3 mt-4 min-h-[20px]">
        {services ? (
          services.map((svc) => (
            <div key={svc.name} className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full shrink-0 ${
                svc.status === "healthy" ? "bg-status-success" :
                svc.status === "unhealthy" ? "bg-status-error" :
                "bg-status-neutral"
              }`} />
              <div>
                <span className="text-xs text-muted-foreground">{svc.name}</span>
                {svc.status === "unhealthy" && svc.error && (
                  <p className="text-xs text-muted-foreground/60">{svc.error}</p>
                )}
              </div>
            </div>
          ))
        ) : (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}
