"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export function InfrastructureSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState(false);
  const [logs, setLogs] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/setup/services");
        if (res.ok) {
          const data = await res.json();
          setMetrics(!!data.metrics);
          setLogs(!!data.logs);
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
    </div>
  );
}
