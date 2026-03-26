"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";

type TraefikConfig = {
  externalRouting: boolean;
};

export function TraefikSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<TraefikConfig>({ externalRouting: false });
  const [saved, setSaved] = useState<TraefikConfig | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/traefik");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        setConfig(data);
        setSaved(data);
      } catch {
        // keep defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/traefik", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error("Failed to save");
      setSaved(config);
      toast.success("Traefik settings saved");
    } catch {
      toast.error("Failed to save Traefik settings");
    } finally {
      setSaving(false);
    }
  }

  const restartRequired =
    saved !== null && saved.externalRouting !== config.externalRouting;

  const envValue = config.externalRouting ? "" : "vardo-network";
  const envLine = config.externalRouting
    ? "TRAEFIK_DOCKER_NETWORK="
    : "TRAEFIK_DOCKER_NETWORK=vardo-network";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading Traefik settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Traefik</h2>
        <p className="text-sm text-muted-foreground">
          Configure how Vardo&apos;s reverse proxy discovers and routes traffic.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="external-routing" className="text-sm font-medium">
              Route to external containers
            </Label>
            <div className="text-xs text-muted-foreground">
              Allow Traefik to discover and route to containers outside of vardo-network.
              External containers must have <code className="font-mono">traefik.enable=true</code> set.
              Safe with <code className="font-mono">exposedbydefault=false</code> — only explicitly labeled containers are routed.
            </div>
          </div>
          <Switch
            id="external-routing"
            checked={config.externalRouting}
            onCheckedChange={(checked) =>
              setConfig((prev) => ({ ...prev, externalRouting: checked }))
            }
            aria-label={`${config.externalRouting ? "Disable" : "Enable"} external container routing`}
          />
        </div>

        <Button type="submit" className="squircle" disabled={saving} aria-label="Save Traefik settings">
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
      </form>

      <div className="rounded-lg border p-4 space-y-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Applying changes</p>
          <p className="text-xs text-muted-foreground">
            Traefik reads its provider configuration at startup. After saving, set{" "}
            <code className="font-mono">{envLine}</code> in your <code className="font-mono">.env</code> file
            and recreate the Traefik container to apply.
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">Run in your Vardo directory:</p>
          <pre className="text-xs bg-muted rounded px-3 py-2 font-mono overflow-x-auto select-all">
            {`${envLine}\ndocker compose up -d traefik`}
          </pre>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">
            Current <code className="font-mono">TRAEFIK_DOCKER_NETWORK</code> value for{" "}
            {config.externalRouting ? "external routing (no filter)" : "vardo-network only"}:
          </p>
          <pre className="text-xs bg-muted rounded px-3 py-2 font-mono overflow-x-auto select-all">
            {envValue === "" ? "(empty — no network filter)" : envValue}
          </pre>
        </div>
      </div>
    </div>
  );
}
