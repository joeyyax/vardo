"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageToolbar } from "@/components/page-toolbar";
import { AdminActions } from "./admin-actions";
import { OrgMetrics } from "@/app/(app)/metrics/org-metrics";
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
  orgId: string;
  appList: AppSummary[];
  initialSystem: SystemInfo | null;
  initialAppStats: (AppSummary & { containers: ContainerStatsSnapshot[] })[];
  initialDisk: { total: number; images: number; volumes: number; buildCache: number } | null;
};

export function AdminPanel({
  stats,
  orgId,
  appList,
  initialSystem,
  initialAppStats,
  initialDisk,
}: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState("overview");

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
            {[
              { label: "Users", value: stats.userCount },
              { label: "Apps", value: stats.appCount },
              { label: "Deployments", value: stats.deploymentCount },
              { label: "Templates", value: stats.templateCount },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg border bg-card p-4">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="text-2xl font-semibold tabular-nums mt-1">{stat.value}</p>
              </div>
            ))}
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
