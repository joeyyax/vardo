"use client";

import { OrgMetrics } from "@/app/(authenticated)/metrics/org-metrics";

export function AdminMetrics({ orgId }: { orgId: string }) {
  return (
    <OrgMetrics
      orgId={orgId}
      apps={[]}
      adminMode
    />
  );
}
