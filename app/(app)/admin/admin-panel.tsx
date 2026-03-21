"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2, Check, X } from "lucide-react";
import type { FeatureFlagInfo } from "@/lib/config/features";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageToolbar } from "@/components/page-toolbar";
import { DockerPrune, UserManagement } from "./admin-actions";
import { OrgMetrics } from "@/app/(app)/metrics/org-metrics";
import { Sparkline } from "@/components/app-metrics-card";
import { formatBytes } from "@/lib/metrics/format";
import type { SystemInfo } from "@/lib/docker/client";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";

type OrgBreakdown = {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  appCount: number;
  activeApps: number;
  deploymentCount: number;
  cpu: number;
  memory: number;
  networkRx: number;
  networkTx: number;
  containers: number;
};

type Stats = {
  userCount: number;
  appCount: number;
  deploymentCount: number;
  templateCount: number;
};

type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

type AdminPanelProps = {
  stats: Stats;
  sparklines: Record<string, [number, number][]>;
  orgId: string;
  appList: AppSummary[];
  featureFlags: FeatureFlagInfo[];
  orgBreakdown: OrgBreakdown[];
  initialSystem: SystemInfo | null;
  initialAppStats: (AppSummary & { containers: ContainerStatsSnapshot[] })[];
  initialDisk: { total: number; images: number; volumes: number; buildCache: number } | null;
};

export function AdminPanel({
  stats,
  sparklines,
  featureFlags,
  orgId,
  appList,
  orgBreakdown,
  initialSystem,
  initialAppStats,
  initialDisk,
}: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState("overview");

  const statCards = [
    { label: "Users", value: stats.userCount, sparklineKey: "users", color: "oklch(0.65 0.18 290)" },
    { label: "Apps", value: stats.appCount, sparklineKey: "apps", color: "oklch(0.68 0.16 175)" },
    { label: "Deployments", value: stats.deploymentCount, sparklineKey: "deployments", color: "oklch(0.67 0.17 120)" },
    { label: "Templates", value: stats.templateCount, sparklineKey: null, color: "oklch(0.65 0.16 335)" },
  ];

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
      </PageToolbar>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="organizations">
            Organizations
            {orgBreakdown.length > 0 && (
              <span className="ml-1.5 tabular-nums text-muted-foreground">{orgBreakdown.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {statCards.map((stat) => {
              const data = stat.sparklineKey ? sparklines[stat.sparklineKey]?.map(([, v]) => v) : null;
              return (
                <div key={stat.label} className="squircle relative rounded-lg border bg-card p-4 overflow-hidden">
                  {data && data.length > 0 && (
                    <Sparkline
                      data={data}
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{ color: stat.color }}
                    />
                  )}
                  <div className="relative">
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="text-2xl font-semibold tabular-nums mt-1">{stat.value}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Feature flags */}
          <div className="squircle rounded-lg border bg-card overflow-hidden mt-4">
            <div className="px-4 py-2 border-b">
              <p className="text-xs text-muted-foreground">Feature Flags</p>
            </div>
            <div className="divide-y">
              {featureFlags.map(({ flag, enabled, label, description }) => (
                <div key={flag} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                  <div className={`inline-flex items-center gap-1 shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
                    enabled
                      ? "bg-status-success-muted text-status-success"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {enabled ? <Check className="size-3" /> : <X className="size-3" />}
                    {enabled ? "On" : "Off"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="organizations" className="pt-4">
          {orgBreakdown.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <Building2 className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No organizations yet.</p>
            </div>
          ) : (
            <div className="squircle rounded-lg border bg-card overflow-x-auto">
              <div className="grid grid-cols-[1fr_70px_70px_70px_90px_100px_80px] gap-3 px-4 py-2 border-b text-xs text-muted-foreground whitespace-nowrap min-w-[700px]">
                <span>Organization</span>
                <span className="text-right">Members</span>
                <span className="text-right">Apps</span>
                <span className="text-right">Deploys</span>
                <span className="text-right">CPU</span>
                <span className="text-right">Memory</span>
                <span className="text-right">Containers</span>
              </div>
              <div className="divide-y">
                {orgBreakdown.map((org) => (
                  <Link
                    key={org.id}
                    href={`/projects`}
                    className="grid grid-cols-[1fr_70px_70px_70px_90px_100px_80px] gap-3 px-4 py-3 items-center whitespace-nowrap min-w-[700px] hover:bg-accent/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{org.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{org.slug}</p>
                    </div>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.memberCount}
                    </span>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.activeApps}/{org.appCount}
                    </span>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.deploymentCount}
                    </span>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.cpu > 0 ? `${org.cpu.toFixed(1)}%` : "-"}
                    </span>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.memory > 0 ? formatBytes(org.memory) : "-"}
                    </span>
                    <span className="text-xs text-right tabular-nums text-muted-foreground">
                      {org.containers || "-"}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="users" className="pt-4">
          <UserManagement />
        </TabsContent>

        <TabsContent value="maintenance" className="pt-4 space-y-4">
          <DockerPrune />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <OrgMetrics
            orgId={orgId}
            apps={appList}
            initialSystem={initialSystem}
            initialAppStats={initialAppStats}
            initialDisk={initialDisk}
            adminMode
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
