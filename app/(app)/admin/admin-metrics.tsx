"use client";

import { OrgMetrics } from "@/app/(app)/metrics/org-metrics";

export function AdminMetrics({ orgId }: { orgId: string }) {
  return (
    <OrgMetrics
      orgId={orgId}
      apps={[]}
      adminMode
    />
  );
}
