"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Unplug, Plug, ExternalLink, Rocket } from "lucide-react";
import { toast } from "@/lib/messenger";

type Integration = {
  id: string;
  type: string;
  status: "connected" | "disconnected" | "degraded";
  appId: string | null;
  externalUrl: string | null;
  config: Record<string, unknown> | null;
};

type AppOption = {
  id: string;
  name: string;
  displayName: string;
};

const INTEGRATION_TYPES = [
  {
    type: "metrics",
    label: "Metrics",
    description: "Container resource metrics (CPU, memory, network, disk). Requires a cAdvisor-compatible source.",
    defaultPort: 8080,
    templateName: "cadvisor",
  },
  {
    type: "error_tracking",
    label: "Error Tracking",
    description: "Application error monitoring. Injects SENTRY_DSN into deployed apps. Requires GlitchTip or Sentry-compatible instance.",
    defaultPort: 8000,
    templateName: "glitchtip",
  },
  {
    type: "uptime",
    label: "Uptime Monitoring",
    description: "Auto-creates monitors for deployed apps and domains. Requires Uptime Kuma or compatible instance.",
    defaultPort: 3001,
    templateName: "uptime-kuma",
  },
  {
    type: "logging",
    label: "Log Aggregation",
    description: "Centralized log collection and search. Requires Grafana + Loki or compatible stack.",
    defaultPort: 3000,
    templateName: null,
  },
] as const;

function statusColor(status: string) {
  switch (status) {
    case "connected": return "default";
    case "degraded": return "secondary";
    default: return "outline";
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "connected": return "Connected";
    case "degraded": return "Degraded";
    default: return "Not configured";
  }
}

export function IntegrationsSettings() {
  const [loading, setLoading] = useState(true);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [apps, setApps] = useState<AppOption[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/admin/integrations").then((r) => r.json()),
      fetch("/api/v1/admin/organizations").then((r) => r.json()).catch(() => ({ organizations: [] })),
    ]).then(([intData]) => {
      setIntegrations(intData.integrations ?? []);
    }).finally(() => setLoading(false));

    // Fetch apps for the connect dialog
    fetch("/api/v1/admin/overview")
      .then((r) => r.json())
      .then((data) => {
        const allApps = data.apps ?? data.projects ?? [];
        setApps(allApps.map((a: AppOption) => ({ id: a.id, name: a.name, displayName: a.displayName })));
      })
      .catch(() => {});
  }, []);

  function getIntegration(type: string): Integration | undefined {
    return integrations.find((i) => i.type === type);
  }

  const [installing, setInstalling] = useState<string | null>(null);

  async function install(type: string, label: string) {
    setInstalling(type);
    const toastId = toast.loading(`Installing ${label}...`, { duration: Infinity });

    try {
      const res = await fetch("/api/v1/admin/integrations/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to install");
      }

      const data = await res.json();
      toast.dismiss(toastId);
      toast.success(`${label} installed and connected`, {
        description: `Deploying ${data.app.displayName} in the background`,
      });

      setIntegrations((prev) => {
        const existing = prev.findIndex((i) => i.type === type);
        const newIntegration: Integration = {
          id: data.integration.appId,
          type,
          status: "connected",
          appId: data.integration.appId,
          externalUrl: null,
          config: null,
        };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = newIntegration;
          return next;
        }
        return [...prev, newIntegration];
      });
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : "Failed to install");
    } finally {
      setInstalling(null);
    }
  }

  async function disconnect(type: string) {
    try {
      const res = await fetch(`/api/v1/admin/integrations?type=${type}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setIntegrations((prev) =>
        prev.map((i) => i.type === type ? { ...i, status: "disconnected" as const, appId: null, externalUrl: null } : i),
      );
      toast.success("Integration disconnected");
    } catch {
      toast.error("Failed to disconnect");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading integrations</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect infrastructure tools to enhance your platform. Deploy them as regular apps or point to external instances.
        </p>
      </div>

      <div className="space-y-3">
        {INTEGRATION_TYPES.map((def) => {
          const integration = getIntegration(def.type);
          const isConnected = integration?.status === "connected" || integration?.status === "degraded";

          return (
            <div key={def.type} className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-1 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{def.label}</span>
                  <Badge variant={isConnected ? statusColor(integration!.status) : "outline"}>
                    {isConnected ? statusLabel(integration!.status) : "Not configured"}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">{def.description}</div>
                {isConnected && integration?.appId && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Backed by app: <span className="font-mono">{integration.appId}</span>
                  </div>
                )}
                {isConnected && integration?.externalUrl && (
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <ExternalLink className="size-3" />
                    {integration.externalUrl}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 ml-4">
                {isConnected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="squircle"
                    onClick={() => disconnect(def.type)}
                  >
                    <Unplug className="size-3.5 mr-1.5" />
                    Disconnect
                  </Button>
                ) : (
                  <>
                    {def.templateName && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="squircle"
                        disabled={installing === def.type}
                        onClick={() => install(def.type, def.label)}
                      >
                        {installing === def.type ? (
                          <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <Rocket className="size-3.5 mr-1.5" />
                        )}
                        Install
                      </Button>
                    )}
                    <ConnectDialog
                      type={def.type}
                      label={def.label}
                      apps={apps}
                      onConnected={(integration) => {
                        setIntegrations((prev) => {
                          const existing = prev.findIndex((i) => i.type === def.type);
                          if (existing >= 0) {
                            const next = [...prev];
                            next[existing] = integration;
                            return next;
                          }
                          return [...prev, integration];
                        });
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConnectDialog({
  type,
  label,
  apps,
  onConnected,
}: {
  type: string;
  label: string;
  apps: AppOption[];
  onConnected: (integration: Integration) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"app" | "external">("app");
  const [appId, setAppId] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = mode === "app"
        ? { type, mode: "app", appId }
        : { type, mode: "external", externalUrl, apiToken: apiToken || undefined };

      const res = await fetch("/api/v1/admin/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to connect");
      }
      const data = await res.json();
      onConnected(data.integration);
      setOpen(false);
      toast.success(`${label} connected`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="squircle">
          <Plug className="size-3.5 mr-1.5" />
          Connect
        </Button>
      </DialogTrigger>
      <DialogContent className="squircle">
        <DialogHeader>
          <DialogTitle>Connect {label}</DialogTitle>
          <DialogDescription>
            Choose an existing Vardo app or enter an external URL.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleConnect} className="space-y-4">
          <div className="space-y-2">
            <Label>Connection mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "app" | "external")}>
              <SelectTrigger className="squircle">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="app">Vardo app</SelectItem>
                <SelectItem value="external">External URL</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "app" ? (
            <div className="space-y-2">
              <Label>App</Label>
              <Select value={appId} onValueChange={setAppId}>
                <SelectTrigger className="squircle">
                  <SelectValue placeholder="Select an app" />
                </SelectTrigger>
                <SelectContent>
                  {apps.map((app) => (
                    <SelectItem key={app.id} value={app.id}>
                      {app.displayName || app.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>URL</Label>
                <Input
                  className="squircle"
                  type="url"
                  placeholder="https://cadvisor.example.com:8080"
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>API token (optional)</Label>
                <Input
                  className="squircle"
                  type="password"
                  placeholder="Bearer token or API key"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
              </div>
            </>
          )}

          <DialogFooter>
            <Button type="submit" className="squircle" disabled={saving || (mode === "app" && !appId)}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
