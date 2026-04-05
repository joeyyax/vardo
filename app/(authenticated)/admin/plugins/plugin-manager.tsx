"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Blocks,
  Check,
  CircleDot,
  Filter,
  Globe,
  Info,
  Loader2,
  Package,
  Puzzle,
  Radio,
  Search,
  Settings2,
  ShieldAlert,
  Terminal,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { PluginManifest } from "@/lib/plugins/manifest";

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
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<PluginData | null>(null);
  const [detailTab, setDetailTab] = useState<"general" | "report">("general");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [compatibility, setCompatibility] = useState<Record<string, { compatible: boolean; issues: { type: string; severity: string; message: string; detail?: string; serviceName?: string }[] }>>({});
  const [provisioning, setProvisioning] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/plugins");
      if (!res.ok) throw new Error("Failed to load plugins");
      const data = await res.json();
      setPlugins(data.plugins);

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

  useEffect(() => {
    if (!loading && plugins.length > 0 && !plugins.some((p) => !p.builtIn)) {
      setShowBuiltIn(true);
    }
  }, [loading, plugins]);

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
        // Keep detail sheet in sync
        setDetailPlugin((prev) =>
          prev?.id === pluginId ? { ...prev, enabled } : prev
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

  const categories = useMemo(
    () => [...new Set(plugins.map((p) => p.category).filter(Boolean))].sort() as string[],
    [plugins],
  );

  const hasActiveFilters = search !== "" || categoryFilter !== null || statusFilter !== "all";

  const filteredPlugins = useMemo(() => {
    let result = plugins;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q),
      );
    }
    if (categoryFilter) {
      result = result.filter((p) => p.category === categoryFilter);
    }
    if (statusFilter !== "all") {
      result = result.filter((p) => (statusFilter === "enabled" ? p.enabled : !p.enabled));
    }
    if (!showBuiltIn) {
      result = result.filter((p) => !p.builtIn);
    }
    return result;
  }, [plugins, search, categoryFilter, statusFilter, showBuiltIn]);

  const clearFilters = useCallback(() => {
    setSearch("");
    setCategoryFilter(null);
    setStatusFilter("all");
  }, []);

  const enabledCount = plugins.filter((p) => p.enabled).length;
  const disabledCount = plugins.filter((p) => !p.enabled).length;
  const builtInCount = plugins.filter((p) => p.builtIn).length;

  function categoryCounts(cat: string) {
    return plugins.filter((p) => p.category === cat).length;
  }

  // Detail sheet helpers
  const detailManifest = detailPlugin?.manifest;
  const detailProvides = detailManifest?.provides ?? [];
  const detailRequiredFeatures = detailManifest?.requires?.features ?? [];
  const detailRequiredServices = detailManifest?.requires?.services ?? [];
  const detailConflicts = detailManifest?.conflicts ?? [];
  const detailHooks = detailManifest?.hooks ?? [];
  const detailEmits = detailManifest?.emits ?? [];
  const detailConsumers = detailManifest?.consumers ?? [];
  const detailApi = detailManifest?.api ?? [];
  const detailSlots = detailManifest?.ui?.slots ? Object.keys(detailManifest.ui.slots) : [];
  const detailNav = detailManifest?.ui?.nav ?? [];
  const detailRequiresRedis = detailManifest?.requires?.redis ?? false;
  const detailCompat = detailPlugin ? compatibility[detailPlugin.id] : undefined;

  function openDetail(plugin: PluginData) {
    setDetailPlugin(plugin);
    setDetailTab("general");
  }

  function renderSidebarContent() {
    return (
      <div className="space-y-6">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="squircle pl-9 h-9"
          />
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</h3>
          <div className="space-y-1">
            {([
              ["all", "All plugins", plugins.length],
              ["enabled", "Enabled", enabledCount],
              ["disabled", "Disabled", disabledCount],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  statusFilter === value
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {label}
                <span className="text-xs tabular-nums">{count}</span>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</h3>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                categoryFilter === null
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              All categories
              <span className="text-xs tabular-nums">{plugins.length}</span>
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  categoryFilter === cat
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {cat}
                <span className="text-xs tabular-nums">{categoryCounts(cat)}</span>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        <label className="flex items-center gap-2.5 cursor-pointer">
          <Checkbox
            checked={showBuiltIn}
            onCheckedChange={(checked) => setShowBuiltIn(checked === true)}
          />
          <span className="text-sm text-muted-foreground">
            Show built-in
            <span className="ml-1.5 text-xs tabular-nums">({builtInCount})</span>
          </span>
        </label>

        {hasActiveFilters && (
          <>
            <Separator />
            <button
              type="button"
              onClick={clearFilters}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-3" />
              Clear all filters
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="squircle gap-2 lg:hidden"
              onClick={() => setMobileFiltersOpen(true)}
            >
              <Filter className="size-4" />
              Filters
              {hasActiveFilters && (
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                  !
                </span>
              )}
            </Button>
            <Button variant="outline" size="sm" className="squircle gap-2" asChild>
              <Link href="/admin">
                <ArrowLeft className="size-4" />
                Back to admin
              </Link>
            </Button>
          </div>
        }
      >
        <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
      </PageToolbar>

      <div className="flex gap-8">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="sticky top-24">
            {renderSidebarContent()}
          </div>
        </aside>

        {/* Plugin grid */}
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="squircle animate-pulse">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="size-9 rounded-md bg-muted" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-4 w-24 rounded bg-muted" />
                        <div className="h-3 w-40 rounded bg-muted" />
                      </div>
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
          ) : filteredPlugins.length === 0 ? (
            <Card className="squircle">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Search className="size-10 text-muted-foreground mb-3" />
                <p className="text-muted-foreground">No plugins match your filters.</p>
                {hasActiveFilters && (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-2"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredPlugins.map((plugin) => {
                const manifest = plugin.manifest;
                const Icon = getCategoryIcon(plugin.category);
                const pluginIcon = manifest?.icon;
                const isToggling = toggling === plugin.id;

                return (
                  <Card
                    key={plugin.id}
                    className="squircle cursor-pointer transition-colors hover:bg-muted/50 py-0"
                    onClick={() => openDetail(plugin)}
                  >
                    <CardContent className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
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
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-medium truncate">
                              {plugin.name}
                            </h3>
                            <Switch
                              checked={plugin.enabled}
                              disabled={isToggling}
                              onCheckedChange={(checked) =>
                                handleToggle(plugin.id, checked)
                              }
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          {plugin.description && (
                            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                              {plugin.description}
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-1">
                            {plugin.category && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                {plugin.category}
                              </Badge>
                            )}
                            {plugin.builtIn && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                built-in
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Mobile filters sheet */}
      <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Filter plugins</SheetTitle>
            <SheetDescription>
              Narrow down the plugin list.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {renderSidebarContent()}
          </div>
        </SheetContent>
      </Sheet>

      {/* Plugin detail sheet */}
      <Sheet
        open={!!detailPlugin}
        onOpenChange={(open) => {
          if (!open) setDetailPlugin(null);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          {detailPlugin && (
            <>
              <SheetHeader>
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {detailManifest?.icon ? (
                      <img
                        src={detailManifest.icon}
                        alt=""
                        className="size-5 dark:invert"
                        loading="lazy"
                      />
                    ) : (
                      <Puzzle className="size-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pr-6">
                    <SheetTitle>{detailPlugin.name}</SheetTitle>
                    <SheetDescription>
                      v{detailPlugin.version}
                      {detailPlugin.category && ` · ${detailPlugin.category}`}
                      {detailPlugin.builtIn && " · built-in"}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>

              <div className="flex items-center border-b px-4 pt-2">
                <div className="flex gap-1">
                  {(["general", "report"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setDetailTab(tab)}
                      className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px capitalize ${
                        detailTab === tab
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2 pb-2">
                  <span className="text-xs text-muted-foreground">
                    {detailPlugin.enabled ? "Enabled" : "Disabled"}
                  </span>
                  <Switch
                    checked={detailPlugin.enabled}
                    disabled={toggling === detailPlugin.id}
                    onCheckedChange={(checked) =>
                      handleToggle(detailPlugin.id, checked)
                    }
                  />
                </div>
              </div>

              <div className="px-4 pb-6 pt-4 space-y-6">
                {detailTab === "general" ? (
                  <>
                    {detailPlugin.description && (
                      <p className="text-sm text-muted-foreground">
                        {detailPlugin.description}
                      </p>
                    )}

                    {detailProvides.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Check className="size-3" />
                          Provides
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {detailProvides.map((cap) => (
                            <Badge key={cap} variant="secondary" className="text-xs">
                              {cap}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {(detailRequiredFeatures.length > 0 ||
                      detailRequiredServices.length > 0) && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Info className="size-3" />
                          Requires
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {detailRequiredFeatures.map((feat) => (
                            <Badge key={feat} variant="outline" className="text-xs">
                              {feat}
                            </Badge>
                          ))}
                          {detailRequiredServices.map((svc) => (
                            <Badge key={svc.name} variant="outline" className="text-xs">
                              {svc.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailConflicts.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                          <ShieldAlert className="size-3" />
                          Conflicts with
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {detailConflicts.map((c) => (
                            <Badge
                              key={c}
                              className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-0"
                            >
                              {c}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailCompat?.issues?.length ? (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Compatibility
                        </h4>
                        <div className="space-y-2 rounded-md bg-muted/50 p-3">
                          {detailCompat.issues.map((issue, idx) => {
                            const isProvisionable =
                              issue.type === "service_unavailable" &&
                              issue.severity === "warning";
                            const serviceName = isProvisionable ? issue.serviceName : undefined;
                            const provKey = `${detailPlugin.id}:${serviceName}`;
                            const isProvisioning = provisioning === provKey;

                            return (
                              <div
                                key={idx}
                                className={`text-sm ${
                                  issue.severity === "error"
                                    ? "text-destructive"
                                    : "text-amber-600 dark:text-amber-400"
                                }`}
                              >
                                <span className="font-medium">{issue.message}</span>
                                {issue.detail && (
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    {issue.detail}
                                  </p>
                                )}
                                {serviceName && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="squircle mt-2 gap-1.5"
                                    disabled={isProvisioning}
                                    onClick={() =>
                                      handleProvision(detailPlugin.id, serviceName)
                                    }
                                  >
                                    {isProvisioning ? (
                                      <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                      <Package className="size-3.5" />
                                    )}
                                    Provision {serviceName}
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    <Separator />
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <dt className="text-muted-foreground">Version</dt>
                      <dd>{detailPlugin.version}</dd>
                      {detailPlugin.category && (
                        <>
                          <dt className="text-muted-foreground">Category</dt>
                          <dd>{detailPlugin.category}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Type</dt>
                      <dd>{detailPlugin.builtIn ? "Built-in" : "Community"}</dd>
                      <dt className="text-muted-foreground">Installed</dt>
                      <dd>{new Date(detailPlugin.installedAt).toLocaleDateString()}</dd>
                    </dl>
                  </>
                ) : (
                  <>
                    {detailHooks.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Webhook className="size-3" />
                          Hooks
                        </h4>
                        <div className="space-y-1">
                          {detailHooks.map((hook) => (
                            <div
                              key={`${hook.event}:${hook.handler}`}
                              className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                              <code className="text-xs">{hook.event}</code>
                              <div className="flex items-center gap-2">
                                {hook.priority !== undefined && hook.priority !== 100 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    pri {hook.priority}
                                  </span>
                                )}
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1.5 py-0"
                                >
                                  {hook.failMode ?? "warn"}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailEmits.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Radio className="size-3" />
                          Emits
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {detailEmits.map((event) => (
                            <Badge key={event} variant="outline" className="text-xs font-mono">
                              {event}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailApi.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Globe className="size-3" />
                          API endpoints
                        </h4>
                        <div className="space-y-1">
                          {detailApi.map((route) => (
                            <div
                              key={`${route.method}:${route.path}`}
                              className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono shrink-0">
                                {route.method}
                              </Badge>
                              <code className="text-xs truncate">{route.path}</code>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailConsumers.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Terminal className="size-3" />
                          Stream consumers
                        </h4>
                        <div className="space-y-1">
                          {detailConsumers.map((consumer) => (
                            <div
                              key={`${consumer.stream}:${consumer.group}`}
                              className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                              <code className="text-xs">{consumer.stream}</code>
                              <span className="text-[10px] text-muted-foreground">{consumer.group}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(detailSlots.length > 0 || detailNav.length > 0) && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Settings2 className="size-3" />
                          UI contributions
                        </h4>
                        <div className="space-y-1">
                          {detailSlots.map((slot) => (
                            <div
                              key={slot}
                              className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                              <span className="text-[10px] text-muted-foreground shrink-0">slot</span>
                              <code className="text-xs">{slot}</code>
                            </div>
                          ))}
                          {detailNav.map((nav) => (
                            <div
                              key={nav.path}
                              className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground shrink-0">nav</span>
                                <span className="text-xs">{nav.label}</span>
                              </div>
                              <code className="text-[10px] text-muted-foreground">{nav.path}</code>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailRequiresRedis && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Infrastructure
                        </h4>
                        <Badge variant="outline" className="text-xs">Redis</Badge>
                      </div>
                    )}

                    {!detailHooks.length && !detailEmits.length && !detailApi.length &&
                      !detailConsumers.length && !detailSlots.length && !detailNav.length &&
                      !detailRequiresRedis && (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No technical details declared in this plugin&apos;s manifest.
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
