"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

  const fetchServices = useCallback(async () => {
    const res = await fetch("/api/v1/admin/core-services");
    if (!res.ok) throw new Error("Failed to fetch");
    const data = await res.json();
    setServices(data.services ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await fetchServices();
      } catch {
        toast.error("Couldn't load core services");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchServices]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await fetchServices();
    } catch {
      toast.error("Couldn't load core services");
    } finally {
      setRefreshing(false);
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
