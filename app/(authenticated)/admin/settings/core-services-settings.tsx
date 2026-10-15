"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Card } from "@/components/ui/card";

type CoreServiceState = "off" | "provisioned" | "conflict" | "missing-template" | "failed" | "retiring";

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
  retiring: "Retiring",
};

const STATE_VARIANT: Record<CoreServiceState, "success" | "warning" | "error" | "neutral"> = {
  provisioned: "success",
  off: "neutral",
  // Blocked by an app the admin owns, so it is theirs to clear.
  conflict: "warning",
  "missing-template": "error",
  failed: "error",
  retiring: "neutral",
};

export function CoreServicesSettings() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [services, setServices] = useState<CoreService[]>([]);
  const [diskMetricsEnabled, setDiskMetricsEnabled] = useState(false);
  const [savingDiskMetrics, setSavingDiskMetrics] = useState(false);

  const fetchServices = useCallback(async () => {
    const res = await fetch("/api/v1/admin/core-services");
    if (!res.ok) throw new Error("Couldn't fetch");
    const data = await res.json();
    setServices(data.services ?? []);
  }, []);

  const fetchDiskMetrics = useCallback(async () => {
    const res = await fetch("/api/v1/admin/metrics/disk-metrics");
    if (!res.ok) throw new Error("Couldn't fetch");
    const data = await res.json();
    setDiskMetricsEnabled(data.enabled ?? false);
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
      const res = await fetch("/api/v1/admin/metrics/disk-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Couldn't save that change");
        setDiskMetricsEnabled(!next);
        return;
      }
      toast.success(`Disk metrics ${next ? "on" : "off"}`);
    } catch {
      toast.error("Couldn't reach the server");
      setDiskMetricsEnabled(!next);
    } finally {
      setSavingDiskMetrics(false);
    }
  }

  // The Disk metrics row follows the last metrics service.
  const metricsOn = services.some((s) => s.flag === "metrics" && s.state !== "off");
  const lastMetricsService = services.findLast((s) => s.flag === "metrics" && s.state !== "retiring")?.name;

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
        <h2 className="type-h2">Built-in services</h2>
        <p className="text-sm text-muted-foreground">
          These run once for the whole instance. Each one watches every container on the host, so
          every organization reads the same service — there is no per-organization copy. Turn them
          on under{" "}
          <Link href="/admin/settings/feature-flags" className="underline underline-offset-4">
            Feature flags
          </Link>
          ; this page reports what provisioning did.
        </p>
      </div>

      <Card variant="surface" className="divide-y">
        {services.map((service) => (
          <Fragment key={service.name}>
          <div className="flex items-start justify-between gap-4 p-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{service.displayName}</span>
                <Badge variant={STATE_VARIANT[service.state]}>
                  {STATE_LABEL[service.state]}
                </Badge>
              </div>
              {service.state === "retiring" ? (
                service.detail && <div className="text-xs text-muted-foreground">{service.detail}</div>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground">
                    Turned on by the <span className="font-medium">{service.flag}</span> flag.
                    {service.organization && (
                      <> Installed in the {service.organization.name} organization.</>
                    )}
                  </div>
                  {service.detail && (
                    <div className="text-xs text-status-error">{service.detail}</div>
                  )}
                </>
              )}
            </div>
          </div>
          {service.name === lastMetricsService && metricsOn && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="space-y-1">
                <Label htmlFor="disk-metrics" className="text-sm font-medium">
                  Disk metrics
                </Label>
                <p className="text-xs text-muted-foreground">
                  Docker measures each container&apos;s writable layer about once an hour.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {savingDiskMetrics && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />
                )}
                <Switch
                  id="disk-metrics"
                  checked={diskMetricsEnabled}
                  disabled={savingDiskMetrics}
                  onCheckedChange={handleToggleDiskMetrics}
                />
              </div>
            </div>
          )}
          </Fragment>
        ))}
      </Card>

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
