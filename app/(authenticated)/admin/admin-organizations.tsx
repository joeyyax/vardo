"use client";

import { useState, useEffect } from "react";
import { Loader2, Building2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";

type OrgBreakdown = {
  id: string;
  name: string;
  slug: string;
  trusted: boolean;
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

import { formatBytes } from "@/lib/metrics/format";

export function AdminOrganizations() {
  const [orgs, setOrgs] = useState<OrgBreakdown[] | null>(null);
  const [savingTrusted, setSavingTrusted] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/v1/admin/organizations")
      .then((r) => r.json())
      .then((data) => setOrgs(data.organizations || []))
      .catch(() => setOrgs([]));
  }, []);

  async function handleTrustedChange(orgId: string, value: boolean) {
    setSavingTrusted((prev) => ({ ...prev, [orgId]: true }));
    setOrgs((prev) => prev?.map((o) => o.id === orgId ? { ...o, trusted: value } : o) ?? prev);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trusted: value }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }

      toast.success(value ? "Trusted environment enabled" : "Trusted environment disabled");
    } catch (err) {
      setOrgs((prev) => prev?.map((o) => o.id === orgId ? { ...o, trusted: !value } : o) ?? prev);
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingTrusted((prev) => ({ ...prev, [orgId]: false }));
    }
  }

  if (orgs === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Building2 className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No organizations yet</p>
          <p className="text-sm text-muted-foreground">
            Organizations are created when users sign up. Once someone creates an account, their organization will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="squircle rounded-lg border bg-card overflow-x-auto">
      <div className="grid grid-cols-[1fr_70px_70px_70px_90px_100px_80px_80px] gap-3 px-4 py-2 border-b text-xs text-muted-foreground whitespace-nowrap min-w-[800px]">
        <span>Organization</span>
        <span className="text-right">Members</span>
        <span className="text-right">Apps</span>
        <span className="text-right">Deploys</span>
        <span className="text-right">CPU</span>
        <span className="text-right">Memory</span>
        <span className="text-right">Containers</span>
        <span className="text-right">Trusted</span>
      </div>
      <div className="divide-y">
        {orgs.map((org) => (
          <div
            key={org.id}
            className="grid grid-cols-[1fr_70px_70px_70px_90px_100px_80px_80px] gap-3 px-4 py-3 items-center whitespace-nowrap min-w-[800px]"
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
            <div className="flex justify-end items-center gap-1.5">
              {savingTrusted[org.id] && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={org.trusted}
                onCheckedChange={(v) => handleTrustedChange(org.id, v)}
                disabled={savingTrusted[org.id]}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
