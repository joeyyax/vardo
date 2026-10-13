"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Sparkline } from "@/components/app-metrics-card";
import { ServiceDot } from "./service-dot";
import type { ResourceStatus, ServiceStatus } from "@/lib/config/health";
import { Card } from "@/components/ui/card";
import type { SecurityOverview } from "@/lib/security/overview";
import { securityHref } from "@/lib/ui/hrefs";

type SecurityCardData = SecurityOverview & { bans: number; bansBreakdown: string; probes: number };

type Stats = {
  userCount: number;
  appCount: number;
  composeServiceCount: number;
  deploymentCount: number;
  templateCount: number;
};

// Figures cover the whole instance.
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

function SecurityCard({ data }: { data: SecurityCardData | null }) {
  if (!data) {
    return (
      <Card variant="surface" className="p-4 mt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading security status...
        </div>
      </Card>
    );
  }
  const { worst, totals } = data;
  const totalsText =
    totals.critical === 0 && totals.warning === 0
      ? "Clean across every app"
      : `${totals.critical} critical · ${totals.warning} warnings`;
  const findingsApps = worst.length;
  return (
    <Card variant="surface" className="mt-4">
      <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
        <div className="space-y-1">
          <p className="type-h4">Security</p>
          <p className="text-xs text-muted-foreground">Last scan per app, across every organization.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link className="text-xs underline-offset-2 hover:text-foreground hover:underline" href="/admin/security">
            Bans & activity
          </Link>
          <span className="text-xs text-muted-foreground/40">·</span>
          <Link className="text-xs underline-offset-2 hover:text-foreground hover:underline" href="/admin/probe-guard">
            Settings
          </Link>
        </div>
      </div>

      <div className="grid gap-px bg-border sm:grid-cols-3">
        <Link
          href="/admin/security"
          className="bg-card px-4 py-3 transition-colors hover:bg-muted/40"
        >
          <p className="text-xs text-muted-foreground">Findings across apps</p>
          <p className={`type-numeral text-2xl mt-1 ${totals.critical > 0 ? "text-status-error" : totals.warning > 0 ? "text-status-warning" : ""}`}>
            {totals.critical + totals.warning}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{totalsText} · {findingsApps} app{findingsApps === 1 ? "" : "s"}</p>
        </Link>
        <Link
          href="/admin/security"
          className="bg-card px-4 py-3 transition-colors hover:bg-muted/40"
        >
          <p className="text-xs text-muted-foreground">Active bans</p>
          <p className="type-numeral text-2xl mt-1">{data.bans.toLocaleString("en-US")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{data.bansBreakdown}</p>
        </Link>
        <Link
          href="/admin/security"
          className="bg-card px-4 py-3 transition-colors hover:bg-muted/40"
        >
          <p className="text-xs text-muted-foreground">Probes turned away</p>
          <p className="type-numeral text-2xl mt-1">{data.probes.toLocaleString("en-US")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">last 7 days, every app</p>
        </Link>
      </div>

      {worst.length > 0 ? (
        <ul className="divide-y">
          {worst.map((app) => (
            <li key={app.appId} className="flex items-center gap-4 px-4 py-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{app.appName}</p>
                  {app.criticalCount > 0 && (
                    <span className="inline-flex items-center rounded-full bg-status-error-muted px-2 py-0.5 text-xs font-medium text-status-error">
                      {app.criticalCount} critical
                    </span>
                  )}
                  {app.warningCount > 0 && (
                    <span className="inline-flex items-center rounded-full bg-status-warning-muted px-2 py-0.5 text-xs font-medium text-status-warning">
                      {app.warningCount} warning{app.warningCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {app.findings[0]?.description ?? "Open the app for details."}
                </p>
              </div>
              <Link
                href={securityHref(app.appSlug)}
                className="shrink-0 text-xs underline-offset-2 hover:text-foreground hover:underline"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">No apps have critical or warning findings.</p>
      )}
    </Card>
  );
}

export function AdminOverview() {
  // Each section loads independently
  const [stats, setStats] = useState<Stats | null>(null);
  const [sparklines, setSparklines] = useState<Record<string, [number, number][]> | null>(null);
  const [resources, setResources] = useState<ResourceStatus[] | null>(null);
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [security, setSecurity] = useState<SecurityCardData | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/overview")
      .then((r) => r.json())
      .then((data) => {
        setStats(data.stats);
        setSparklines(data.sparklines);
        setResources(data.resources);
        setServices(data.services);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/v1/admin/overview/security")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => live && data && setSecurity(data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <div>
      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCardConfig.map((stat) => {
          const sparklineData = sparklines && stat.sparklineKey
            ? sparklines[stat.sparklineKey]?.map(([, v]) => v)
            : null;
          return (
            <Card variant="surface" key={stat.label} className="relative p-4 overflow-hidden">
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
                  <p className="text-xs text-muted-foreground mt-0.5">{stat.scope(stats)}</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Resource bars */}
      <div className="grid gap-4 sm:grid-cols-3 mt-4">
        {resources ? (
          resources.map((res) => (
            <Card variant="surface" key={res.name} className="p-4">
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
            </Card>
          ))
        ) : (
          // Skeleton cards
          ["CPU", "Memory", "Disk"].map((name) => (
            <Card variant="surface" key={name} className="p-4">
              <p className="text-xs text-muted-foreground mb-2">{name}</p>
              <div className="h-1.5 rounded-full bg-muted" />
              <div className="h-3 w-24 bg-muted rounded mt-2" />
            </Card>
          ))
        )}
      </div>

      {/* Service dots */}
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

      <SecurityCard data={security} />
    </div>
  );
}