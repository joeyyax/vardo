"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Blocks,
  Check,
  CircleDot,
  Code2,
  Info,
  Loader2,
  Package,
  Puzzle,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PluginSettingsForm } from "@/components/plugins/settings-form";
import type { PluginManifest, PluginSettingField } from "@/lib/plugins/manifest";

const PLUGIN_BUNDLES = [
  {
    id: "dev",
    name: "Development",
    description: "Git integration, previews, and terminal access for local development",
    icon: Code2,
    plugins: ["git-integration", "terminal", "cron"],
  },
  {
    id: "homelab",
    name: "Homelab",
    description: "Backups, monitoring, and basic alerts for home servers",
    icon: Server,
    plugins: ["backups", "monitoring", "notifications", "metrics-cadvisor", "cron"],
  },
  {
    id: "production",
    name: "Production",
    description: "Full stack — backups, monitoring, SSL, security scanning, and notifications",
    icon: Shield,
    plugins: ["backups", "monitoring", "notifications", "metrics-cadvisor", "ssl", "security-scanner", "cron", "git-integration", "domain-monitoring"],
  },
] as const;

type PluginData = {
  id: string;
  name: string;
  version: string;
  description: string | null;
  category: string | null;
  enabled: boolean;
  builtIn: boolean;
  manifest: PluginManifest;
  installedAt: string;
};

const categoryIcons: Record<string, typeof Puzzle> = {
  core: Blocks,
  monitoring: CircleDot,
  deployment: Zap,
  security: ShieldAlert,
};

function getCategoryIcon(category: string | null) {
  if (!category) return Puzzle;
  return categoryIcons[category] ?? Puzzle;
}

export function PluginManager() {
  const [plugins, setPlugins] = useState<PluginData[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [installingBundle, setInstallingBundle] = useState<string | null>(null);
  const [bundleProgress, setBundleProgress] = useState<{ current: number; total: number } | null>(null);
  const [settingsPlugin, setSettingsPlugin] = useState<PluginData | null>(null);
  const [compatibility, setCompatibility] = useState<Record<string, { compatible: boolean; issues: { type: string; severity: string; message: string; detail?: string }[] }>>({});

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/plugins");
      if (!res.ok) throw new Error("Failed to load plugins");
      const data = await res.json();
      setPlugins(data.plugins);

      // Fetch compatibility for disabled plugins
      const disabled = (data.plugins as PluginData[]).filter((p) => !p.enabled);
      const checks = await Promise.all(
        disabled.map(async (p) => {
          try {
            const r = await fetch(`/api/v1/plugins/${p.id}/compatibility`);
            if (!r.ok) return [p.id, null] as const;
            return [p.id, await r.json()] as const;
          } catch {
            return [p.id, null] as const;
          }
        }),
      );
      const compat: typeof compatibility = {};
      for (const [id, result] of checks) {
        if (result) compat[id] = result;
      }
      setCompatibility(compat);
    } catch {
      toast.error("Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  const handleToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      setToggling(pluginId);
      try {
        const res = await fetch("/api/v1/plugins", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId, enabled }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to update plugin");
        }
        setPlugins((prev) =>
          prev.map((p) => (p.id === pluginId ? { ...p, enabled } : p))
        );
        toast.success(`${enabled ? "Enabled" : "Disabled"} plugin`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update plugin");
      } finally {
        setToggling(null);
      }
    },
    []
  );

  const handleInstallBundle = useCallback(
    async (bundleId: string, bundlePlugins: readonly string[]) => {
      const toEnable = bundlePlugins.filter(
        (pid) => !plugins.find((p) => p.id === pid && p.enabled)
      );

      if (toEnable.length === 0) {
        toast.success("All plugins in this bundle are already enabled");
        return;
      }

      setInstallingBundle(bundleId);
      setBundleProgress({ current: 0, total: toEnable.length });

      let succeeded = 0;
      let failed = 0;

      for (let i = 0; i < toEnable.length; i++) {
        setBundleProgress({ current: i + 1, total: toEnable.length });
        try {
          const res = await fetch("/api/v1/plugins", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pluginId: toEnable[i], enabled: true }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            console.error(`Failed to enable ${toEnable[i]}:`, data.error);
            failed++;
          } else {
            succeeded++;
          }
        } catch {
          failed++;
        }
      }

      setInstallingBundle(null);
      setBundleProgress(null);
      await fetchPlugins();

      if (failed === 0) {
        toast.success(`Enabled ${succeeded} plugin${succeeded !== 1 ? "s" : ""}`);
      } else {
        toast.error(
          `Enabled ${succeeded} plugin${succeeded !== 1 ? "s" : ""}, ${failed} failed`
        );
      }
    },
    [plugins, fetchPlugins]
  );

  const [provisioning, setProvisioning] = useState<string | null>(null);

  const handleProvision = useCallback(
    async (pluginId: string, serviceName: string) => {
      const key = `${pluginId}:${serviceName}`;
      setProvisioning(key);
      try {
        const res = await fetch(`/api/v1/plugins/${pluginId}/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceName }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Provisioning failed");
        }
        toast.success(`Provisioning ${serviceName} — deploy started`);
        await fetchPlugins();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : `Failed to provision ${serviceName}`
        );
      } finally {
        setProvisioning(null);
      }
    },
    [fetchPlugins]
  );

  const settingsFields: PluginSettingField[] =
    settingsPlugin?.manifest?.ui?.settings ?? [];

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <Button variant="outline" size="sm" className="squircle gap-2" asChild>
            <Link href="/admin">
              <ArrowLeft className="size-4" />
              Back to admin
            </Link>
          </Button>
        }
      >
        <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
      </PageToolbar>

      {!loading && plugins.length > 0 && (
        <>
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Quick start</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PLUGIN_BUNDLES.map((bundle) => {
                const BundleIcon = bundle.icon;
                const isInstalling = installingBundle === bundle.id;
                const enabledCount = bundle.plugins.filter(
                  (pid) => plugins.find((p) => p.id === pid && p.enabled)
                ).length;
                const allEnabled = enabledCount === bundle.plugins.length;

                return (
                  <Card key={bundle.id} className="squircle border bg-muted/30">
                    <CardContent className="flex flex-col gap-3 p-5">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <BundleIcon className="size-5 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold">{bundle.name}</h3>
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              {bundle.plugins.length} plugins
                            </Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                            {bundle.description}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {enabledCount}/{bundle.plugins.length} enabled
                        </span>
                        <Button
                          size="sm"
                          className="squircle gap-2"
                          variant={allEnabled ? "outline" : "default"}
                          disabled={isInstalling || allEnabled || installingBundle !== null}
                          onClick={() => handleInstallBundle(bundle.id, bundle.plugins)}
                        >
                          {isInstalling && bundleProgress ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Enabling {bundleProgress.current} of {bundleProgress.total}...
                            </>
                          ) : allEnabled ? (
                            <>
                              <Check className="size-3.5" />
                              Installed
                            </>
                          ) : (
                            "Install"
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or choose individually</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="squircle animate-pulse">
              <CardHeader>
                <div className="h-5 w-32 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="h-4 w-full rounded bg-muted" />
                  <div className="h-4 w-2/3 rounded bg-muted" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : plugins.length === 0 ? (
        <Card className="squircle">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Puzzle className="size-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No plugins registered.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plugins.map((plugin) => {
            const manifest = plugin.manifest;
            const Icon = getCategoryIcon(plugin.category);
            const pluginIcon = manifest?.icon;
            const hasSettings =
              manifest?.ui?.settings && manifest.ui.settings.length > 0;
            const provides = manifest?.provides ?? [];
            const requiredFeatures = manifest?.requires?.features ?? [];
            const requiredServices = manifest?.requires?.services ?? [];
            const conflicts = manifest?.conflicts ?? [];
            const isToggling = toggling === plugin.id;

            return (
              <Card key={plugin.id} className="squircle">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        {pluginIcon ? (
                          <img
                            src={pluginIcon}
                            alt=""
                            className="size-4 dark:invert"
                            loading="lazy"
                          />
                        ) : (
                          <Icon className="size-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-sm truncate">
                          {plugin.name}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">
                          v{plugin.version}
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={plugin.enabled}
                      disabled={isToggling}
                      onCheckedChange={(checked) =>
                        handleToggle(plugin.id, checked)
                      }
                    />
                  </div>
                </CardHeader>

                <CardContent className="space-y-3">
                  {plugin.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {plugin.description}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    {plugin.category && (
                      <Badge variant="secondary" className="text-[11px] px-2 py-0.5">
                        {plugin.category}
                      </Badge>
                    )}
                    {plugin.builtIn && (
                      <Badge variant="outline" className="text-[11px] px-2 py-0.5">
                        built-in
                      </Badge>
                    )}
                    <Badge
                      variant={plugin.enabled ? "default" : "outline"}
                      className="text-[11px] px-2 py-0.5"
                    >
                      {plugin.enabled ? "enabled" : "disabled"}
                    </Badge>
                  </div>

                  {provides.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Check className="size-3" />
                        Provides
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {provides.map((cap) => (
                          <span
                            key={cap}
                            className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {(requiredFeatures.length > 0 ||
                    requiredServices.length > 0) && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Info className="size-3" />
                        Requires
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {requiredFeatures.map((feat) => (
                          <span
                            key={feat}
                            className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {feat}
                          </span>
                        ))}
                        {requiredServices.map((svc) => (
                          <span
                            key={svc.name}
                            className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {svc.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {conflicts.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <ShieldAlert className="size-3" />
                        Conflicts with
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {conflicts.map((c) => (
                          <span
                            key={c}
                            className="inline-block rounded bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {!plugin.enabled && compatibility[plugin.id]?.issues?.length > 0 && (
                    <div className="space-y-1.5 rounded-md bg-muted/50 px-3 py-2">
                      {compatibility[plugin.id].issues.map((issue, idx) => {
                        const isProvisionable =
                          issue.type === "service_unavailable" &&
                          issue.severity === "warning";
                        const serviceMatch = isProvisionable
                          ? issue.message.match(/Service "([^"]+)"/)
                          : null;
                        const serviceName = serviceMatch?.[1];
                        const provKey = `${plugin.id}:${serviceName}`;
                        const isProvisioning = provisioning === provKey;

                        return (
                          <div key={idx} className={`text-[11px] ${issue.severity === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400"}`}>
                            <span className="font-medium">{issue.message}</span>
                            {issue.detail && (
                              <p className="mt-0.5 text-muted-foreground">{issue.detail}</p>
                            )}
                            {serviceName && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="squircle mt-1.5 h-7 gap-1.5 text-[11px]"
                                disabled={isProvisioning}
                                onClick={() =>
                                  handleProvision(plugin.id, serviceName)
                                }
                              >
                                {isProvisioning ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Package className="size-3" />
                                )}
                                Provision {serviceName}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {hasSettings && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="squircle mt-1 w-full gap-2"
                      onClick={() => setSettingsPlugin(plugin)}
                      disabled={!plugin.enabled}
                    >
                      <Settings2 className="size-3.5" />
                      Configure
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Sheet
        open={!!settingsPlugin}
        onOpenChange={(open) => {
          if (!open) setSettingsPlugin(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{settingsPlugin?.name} Settings</SheetTitle>
            <SheetDescription>
              Configure {settingsPlugin?.name?.toLowerCase()} plugin options.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4 overflow-y-auto flex-1">
            {settingsPlugin && settingsFields.length > 0 && (
              <PluginSettingsForm
                pluginId={settingsPlugin.id}
                fields={settingsFields}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
