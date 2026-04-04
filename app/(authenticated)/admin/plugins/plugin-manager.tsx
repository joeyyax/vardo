"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Blocks,
  Check,
  CircleDot,
  Info,
  Puzzle,
  Settings2,
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
  const [settingsPlugin, setSettingsPlugin] = useState<PluginData | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/plugins");
      if (!res.ok) throw new Error("Failed to load plugins");
      const data = await res.json();
      setPlugins(data.plugins);
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
                        <Icon className="size-4 text-muted-foreground" />
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
