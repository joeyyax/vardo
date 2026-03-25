"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, AlertTriangle, CheckCircle, Info } from "lucide-react";

type AlertEntry = {
  type: string;
  key: string;
  lastFired: string;
  count: number;
};

type AlertsData = {
  active: AlertEntry[];
  history: AlertEntry[];
  total: number;
};

type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
};

type ResourceStatus = {
  name: string;
  percent: number;
  status: "ok" | "warning" | "critical";
  current: number;
  total: number;
  unit: string;
};

type HealthData = {
  services: ServiceStatus[];
  resources: ResourceStatus[];
};

function alertTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "service-degraded": "Service Degraded",
    "disk-space": "Disk Space",
    "host-restarted": "Vardo Restarted",
    "cert-expiring": "Certificate Expiring",
    "update-available": "Update Available",
  };
  return labels[type] ?? type;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusBadge({ status }: { status: "healthy" | "unhealthy" | "unconfigured" | "ok" | "warning" | "critical" }) {
  if (status === "healthy" || status === "ok") {
    return <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50">OK</Badge>;
  }
  if (status === "unconfigured") {
    return <Badge variant="outline" className="text-gray-500 border-gray-200">Not configured</Badge>;
  }
  if (status === "warning") {
    return <Badge variant="outline" className="text-yellow-600 border-yellow-200 bg-yellow-50">Warning</Badge>;
  }
  return <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">Unhealthy</Badge>;
}

export function SystemAlertsPanel() {
  const [alertsData, setAlertsData] = useState<AlertsData | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.resolve();
    setError(null);
    try {
      const [alertsRes, healthRes] = await Promise.all([
        fetch("/api/v1/system/alerts"),
        fetch("/api/health/system"),
      ]);

      if (alertsRes.ok) {
        setAlertsData(await alertsRes.json());
      } else {
        setError(`Failed to load alerts (${alertsRes.status})`);
      }

      if (healthRes.ok) {
        const data = await healthRes.json();
        setHealthData({ services: data.services ?? [], resources: data.resources ?? [] });
      } else {
        // Preserve the first error; only set if not already set
        setError((prev) => prev ?? `Failed to load system health (${healthRes.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load system status");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      await Promise.resolve();
      setError(null);
      setLoading(true);
      try {
        const [alertsRes, healthRes] = await Promise.all([
          fetch("/api/v1/system/alerts", { signal: controller.signal }),
          fetch("/api/health/system", { signal: controller.signal }),
        ]);
        if (alertsRes.ok) {
          setAlertsData(await alertsRes.json());
        } else {
          setError(`Failed to load alerts (${alertsRes.status})`);
        }
        if (healthRes.ok) {
          const data = await healthRes.json();
          setHealthData({ services: data.services ?? [], resources: data.resources ?? [] });
        } else {
          setError((prev) => prev ?? `Failed to load system health (${healthRes.status})`);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load system status");
        }
      }
      if (!controller.signal.aborted) setLoading(false);
    };
    void run();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground animate-pulse">
        Loading system status...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
        <span className="font-medium">Error:</span> {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">System Health</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Infrastructure services and active alerts
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={refreshing}
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Services */}
      {healthData && healthData.services.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Services
          </h4>
          <div className="rounded-lg border divide-y">
            {healthData.services.map((service) => (
              <div
                key={service.name}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-2.5">
                  {service.status === "healthy" ? (
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                  ) : service.status === "unhealthy" ? (
                    <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                  ) : (
                    <Info className="h-4 w-4 text-gray-400 shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{service.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {service.description}
                      {service.latencyMs != null &&
                        service.status === "healthy" && (
                          <span className="ml-2 opacity-60">
                            {service.latencyMs}ms
                          </span>
                        )}
                    </p>
                  </div>
                </div>
                <StatusBadge status={service.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resources */}
      {healthData && healthData.resources.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Resources
          </h4>
          <div className="rounded-lg border divide-y">
            {healthData.resources.map((resource) => (
              <div
                key={resource.name}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-2.5">
                  <div>
                    <p className="text-sm font-medium">{resource.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {resource.percent.toFixed(1)}% used
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        resource.status === "critical"
                          ? "bg-red-500"
                          : resource.status === "warning"
                            ? "bg-yellow-500"
                            : "bg-green-500"
                      }`}
                      style={{ width: `${Math.max(0, Math.min(resource.percent, 100))}%` }}
                    />
                  </div>
                  <StatusBadge status={resource.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Alerts */}
      {alertsData && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Active Alerts
            {alertsData.active.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center h-4 w-4 rounded-full bg-red-100 text-red-700 text-xs font-semibold">
                {alertsData.active.length}
              </span>
            )}
          </h4>

          {alertsData.active.length === 0 ? (
            <div className="rounded-lg border px-4 py-6 text-center">
              <CheckCircle className="h-6 w-6 text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No active alerts</p>
            </div>
          ) : (
            <div className="rounded-lg border divide-y">
              {alertsData.active.map((alert) => (
                <div key={`${alert.type}:${alert.key}`} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">
                        {alertTypeLabel(alert.type)}
                      </p>
                      <p className="text-xs text-muted-foreground">{alert.key}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">
                      {formatRelativeTime(alert.lastFired)}
                    </p>
                    {alert.count > 1 && (
                      <p className="text-xs text-muted-foreground">
                        {alert.count}x
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Alert History */}
      {alertsData && alertsData.history.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Recent Alert History
          </h4>
          <div className="rounded-lg border divide-y">
            {alertsData.history.slice(0, 10).map((alert) => (
              <div
                key={`${alert.type}:${alert.key}`}
                className="flex items-center justify-between px-4 py-2.5"
              >
                <div>
                  <p className="text-sm">{alertTypeLabel(alert.type)}</p>
                  <p className="text-xs text-muted-foreground">{alert.key}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatRelativeTime(alert.lastFired)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
