"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Sparkline } from "@/components/app-metrics-card";
import { ServiceDot } from "./service-dot";
import type { ResourceStatus, ServiceStatus } from "@/lib/config/health";

type Stats = {
  userCount: number;
  appCount: number;
  composeServiceCount: number;
  deploymentCount: number;
  templateCount: number;
};

// Each figure covers the whole instance — the subtitle says so, since the same
// names on /metrics and /projects count one org.
const statCardConfig = [
  {
    key: "userCount" as const, label: "Users", sparklineKey: "users", color: "oklch(0.65 0.18 290)",
    scope: () => "all organizations",
  },
  {
    key: "appCount" as const, label: "Apps", sparklineKey: "apps", color: "oklch(0.68 0.16 175)",
    scope: (s: Stats) =>
      `${s.appCount - s.composeServiceCount} top-level · ${s.composeServiceCount} compose services · all orgs`,
  },
  {
    key: "deploymentCount" as const, label: "Deployments", sparklineKey: "deployments", color: "oklch(0.67 0.17 120)",
    scope: () => "all time, all organizations",
  },
  {
    key: "templateCount" as const, label: "Templates", sparklineKey: null, color: "oklch(0.65 0.16 335)",
    scope: () => "available to install",
  },
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
                <p className="type-numeral text-2xl mt-1">
                  {stats ? stats[stat.key] : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
                </p>
                {stats && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{stat.scope(stats)}</p>
                )}
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
                }`}>{res.headline}</span>
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
                {res.detail}
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

      {/* Service dots — each one opens its own check detail */}
      <div className="flex flex-wrap items-center gap-3 mt-4 min-h-[20px]">
        {services ? (
          services.map((svc) => (
            <ServiceDot
              key={svc.name}
              service={svc}
              onChecked={(next) =>
                setServices((prev) =>
                  (prev ?? []).map((s) => (s.name === next.name ? next : s)),
                )
              }
            />
          ))
        ) : (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}
