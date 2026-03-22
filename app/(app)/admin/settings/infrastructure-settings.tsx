"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
};

export function InfrastructureSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState(false);
  const [logs, setLogs] = useState(false);
  const [services, setServices] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [servicesRes, healthRes] = await Promise.all([
          fetch("/api/setup/services"),
          fetch("/api/v1/admin/health"),
        ]);

        if (servicesRes.ok) {
          const data = await servicesRes.json();
          setMetrics(!!data.metrics);
          setLogs(!!data.logs);
        }

        if (healthRes.ok) {
          const data = await healthRes.json();
          if (data.services) setServices(data.services);
        }
      } catch {
        // defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/setup/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metrics, logs }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Infrastructure settings saved");
    } catch {
      toast.error("Failed to save infrastructure settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading infrastructure settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="sys-metrics" className="text-sm font-medium">
              Container metrics
            </Label>
            <div className="text-xs text-muted-foreground">
              cAdvisor — CPU, memory, network stats per container
            </div>
          </div>
          <Switch
            id="sys-metrics"
            checked={metrics}
            onCheckedChange={setMetrics}
            aria-label="Enable container metrics"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="sys-logs" className="text-sm font-medium">
              Persistent logs
            </Label>
            <div className="text-xs text-muted-foreground">
              Loki + Promtail — searchable container logs
            </div>
          </div>
          <Switch
            id="sys-logs"
            checked={logs}
            onCheckedChange={setLogs}
            aria-label="Enable persistent logs"
          />
        </div>

        <Button type="submit" className="squircle" disabled={saving} aria-label="Save infrastructure settings">
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </form>

      {/* System status */}
      <div className="space-y-3">
        <p className="text-sm font-medium">System status</p>
        <div className="rounded-lg border overflow-hidden divide-y">
          {services.length > 0 ? (
            services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`size-2 rounded-full shrink-0 ${
                      svc.status === "healthy"
                        ? "bg-status-success"
                        : svc.status === "unhealthy"
                          ? "bg-status-error"
                          : "bg-status-neutral"
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{svc.name}</p>
                    <p className="text-xs text-muted-foreground">{svc.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {svc.latencyMs !== undefined && svc.status === "healthy" && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {svc.latencyMs}ms
                    </span>
                  )}
                  <span
                    className={`text-xs font-medium ${
                      svc.status === "healthy"
                        ? "text-status-success"
                        : svc.status === "unhealthy"
                          ? "text-status-error"
                          : "text-muted-foreground"
                    }`}
                  >
                    {svc.status === "healthy"
                      ? "Healthy"
                      : svc.status === "unhealthy"
                        ? "Unhealthy"
                        : "Not configured"}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Unable to load service status.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
