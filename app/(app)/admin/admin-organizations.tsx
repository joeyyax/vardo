"use client";

import { useState, useEffect } from "react";
import { Loader2, Building2 } from "lucide-react";
import Link from "next/link";
import { formatBytes } from "@/lib/metrics/format";

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

export function AdminOrganizations() {
  const [orgs, setOrgs] = useState<OrgBreakdown[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/organizations")
      .then((r) => r.json())
      .then((data) => setOrgs(data.organizations || []))
      .catch(() => setOrgs([]));
  }, []);

  if (orgs === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <Building2 className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No organizations yet.</p>
      </div>
    );
  }

  return (
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
        {orgs.map((org) => (
          <Link
            key={org.id}
            href="/projects"
            className="grid grid-cols-[1fr_70px_70px_70px_90px_100px_80px] gap-3 px-4 py-3 items-center whitespace-nowrap min-w-[700px] hover:bg-accent/50 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{org.name}</p>
              <p className="text-xs text-muted-foreground truncate">{org.slug}</p>
            </div>
            <span className="text-xs text-right tabular-nums text-muted-foreground">{org.memberCount}</span>
            <span className="text-xs text-right tabular-nums text-muted-foreground">{org.activeApps}/{org.appCount}</span>
            <span className="text-xs text-right tabular-nums text-muted-foreground">{org.deploymentCount}</span>
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
  );
}
