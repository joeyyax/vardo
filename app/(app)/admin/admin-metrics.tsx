"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { OrgMetrics } from "@/app/(app)/metrics/org-metrics";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";

type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

export function AdminMetrics({ orgId }: { orgId: string }) {
  const [apps, setApps] = useState<(AppSummary & { containers: ContainerStatsSnapshot[] })[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/stats")
      .then((r) => r.json())
      .then((data) => {
        setApps(
          (data.apps || []).map((a: AppSummary & { containers: Record<string, unknown>[] }) => ({
            ...a,
            containers: a.containers.map((c) => ({
              containerId: c.containerId || "",
              containerName: c.containerName || "",
              cpuPercent: (c.cpuPercent as number) || 0,
              memoryUsage: (c.memoryUsage as number) || 0,
              memoryLimit: (c.memoryLimit as number) || 0,
              memoryPercent: (c.memoryPercent as number) || 0,
              networkRx: (c.networkRx as number) || 0,
              networkTx: (c.networkTx as number) || 0,
              blockRead: 0,
              blockWrite: 0,
            })),
          }))
        );
      })
      .catch(() => setApps([]));
  }, []);

  if (apps === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <OrgMetrics
      orgId={orgId}
      apps={apps}
      initialAppStats={apps}
      adminMode
    />
  );
}
