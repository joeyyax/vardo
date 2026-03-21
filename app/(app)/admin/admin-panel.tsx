"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageToolbar } from "@/components/page-toolbar";
import { AdminActions } from "./admin-actions";
import { OrgMetrics } from "@/app/(app)/metrics/org-metrics";
import { Sparkline } from "@/components/app-metrics-card";
import type { SystemInfo } from "@/lib/docker/client";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";

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
  initialSystem: SystemInfo | null;
  initialAppStats: (AppSummary & { containers: ContainerStatsSnapshot[] })[];
  initialDisk: { total: number; images: number; volumes: number; buildCache: number } | null;
};

export function AdminPanel({
  stats,
  sparklines,
  orgId,
  appList,
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
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4 space-y-6">
          {/* Stats */}
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

          {/* Actions */}
          <AdminActions />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <OrgMetrics
            orgId={orgId}
            apps={appList}
            initialSystem={initialSystem}
            initialAppStats={initialAppStats}
            initialDisk={initialDisk}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
