"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "@/lib/messenger";

type CoreServiceState = "off" | "provisioned" | "conflict" | "missing-template" | "failed";

type CoreService = {
  name: string;
  displayName: string;
  flag: string;
  state: CoreServiceState;
  detail: string | null;
  appId: string | null;
  organization: { id: string; name: string; slug: string } | null;
};

const STATE_LABEL: Record<CoreServiceState, string> = {
  off: "Off",
  provisioned: "Installed",
  conflict: "Name conflict",
  "missing-template": "Unavailable",
  failed: "Failed",
};

function stateVariant(state: CoreServiceState) {
  if (state === "provisioned") return "default" as const;
  if (state === "off") return "outline" as const;
  return "destructive" as const;
}

export function CoreServicesSettings() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [services, setServices] = useState<CoreService[]>([]);
  const [diskMetricsEnabled, setDiskMetricsEnabled] = useState(true);
  const [savingDiskMetrics, setSavingDiskMetrics] = useState(false);

  const fetchServices = useCallback(async () => {
    const res = await fetch("/api/v1/admin/core-services");
    if (!res.ok) throw new Error("Failed to fetch");
    const data = await res.json();
    setServices(data.services ?? []);
  }, []);

  const fetchDiskMetrics = useCallback(async () => {
    const res = await fetch("/api/v1/admin/core-services/cadvisor-disk-metrics");
    if (!res.ok) throw new Error("Failed to fetch");
    const data = await res.json();
    setDiskMetricsEnabled(data.diskMetricsEnabled ?? true);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([fetchServices(), fetchDiskMetrics()]);
      } catch {
        toast.error("Couldn't load core services");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchServices, fetchDiskMetrics]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([fetchServices(), fetchDiskMetrics()]);
    } catch {
      toast.error("Couldn't load core services");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggleDiskMetrics(next: boolean) {
    setSavingDiskMetrics(true);
    setDiskMetricsEnabled(next);
    try {
      const res = await fetch("/api/v1/admin/core-services/cadvisor-disk-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diskMetricsEnabled: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Couldn't save that change");
        setDiskMetricsEnabled(!next);
        return;
      }
      if (!data.installed) {
        toast.success(`Disk metrics ${next ? "on" : "off"}`, {
          description: "Applies once cAdvisor is installed.",
        });
      } else if (data.redeployed) {
        toast.success(`Disk metrics ${next ? "on" : "off"}`, {
          description: "cAdvisor redeployed.",
        });
        void fetchServices();
      } else {
        toast.error("Saved, but the redeploy failed", {
          description: "Restart cAdvisor from Maintenance to apply it.",
        });
      }
    } catch {
      toast.error("Couldn't reach the server");
      setDiskMetricsEnabled(!next);
    } finally {
      setSavingDiskMetrics(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading core services</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Core services</h2>
        <p className="text-sm text-muted-foreground">
          These run once for the whole instance. Each one watches every container on the host, so
          every organization reads the same service — there is no per-organization copy. Turn them
          on under{" "}
          <Link href="/admin/settings/feature-flags" className="underline underline-offset-4">
            Feature flags
          </Link>
          ; this page reports what provisioning actually did.
        </p>
      </div>

      <div className="squircle divide-y rounded-lg border">
        {services.map((service) => (
          <div key={service.name} className="flex items-start justify-between gap-4 p-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{service.displayName}</span>
                <Badge
                  variant={stateVariant(service.state)}
                  className={service.state === "off" ? "text-muted-foreground" : ""}
                >
                  {STATE_LABEL[service.state]}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                Turned on by the <span className="font-medium">{service.flag}</span> flag.
                {service.organization && (
                  <> Installed in the {service.organization.name} organization.</>
                )}
              </div>
              {service.detail && (
                <div className="text-xs text-status-error">{service.detail}</div>
              )}
              {service.name === "cadvisor" && (
                <div className="flex items-center gap-2 pt-1">
                  {savingDiskMetrics && (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />
                  )}
                  <Switch
                    id="cadvisor-disk-metrics"
                    size="sm"
                    checked={diskMetricsEnabled}
                    disabled={savingDiskMetrics}
                    onCheckedChange={handleToggleDiskMetrics}
                    aria-label={`${diskMetricsEnabled ? "Disable" : "Enable"} disk metrics collection`}
                  />
                  <Label htmlFor="cadvisor-disk-metrics" className="text-xs font-normal text-muted-foreground">
                    Disk metrics — walks every container&apos;s filesystem; off drops cAdvisor to 256m
                  </Label>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          &ldquo;Installed&rdquo; means the app row exists and a deploy was requested. For whether
          it is answering right now, see the service health on the{" "}
          <Link href="/admin" className="underline underline-offset-4">
            admin overview
          </Link>
          .
        </p>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-4" aria-hidden />
          )}
          Refresh
        </Button>
      </div>
    </div>
  );
}
