"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Container, Cpu, Loader2, Plus } from "lucide-react";
import { toast } from "@/lib/messenger";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { detectAppType } from "@/lib/ui/app-type";
import { Uptime } from "@/components/app-status";
import { useAppMetrics } from "@/components/app-metrics-card";
import { formatBytes } from "@/lib/metrics/format";
import { DependencySelector } from "./dependency-selector";
import type { App, Deployment, SlotStatus, Tag } from "./types";

function deployTypeLabel(deployType: string) {
  switch (deployType) {
    case "compose":
      return "Compose";
    case "dockerfile":
      return "Dockerfile";
    case "image":
      return "Image";
    case "static":
      return "Static";
    default:
      return deployType;
  }
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  active: { label: "Running", className: "text-status-success" },
  stopped: { label: "Stopped", className: "text-status-neutral" },
  error: { label: "Crashed", className: "text-status-error" },
  deploying: { label: "Deploying", className: "text-status-info" },
  missing: { label: "No container", className: "text-status-warning" },
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="type-label text-muted-foreground/60">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Persistent heading block for the app detail page: identity, at-a-glance
 * health stats, tags and deploy dependencies. Shown above every section.
 */
export function AppHeader({
  app,
  orgId,
  isChildService,
  deployments,
  allTags,
  siblings,
  onNavigate,
}: {
  app: App;
  orgId: string;
  isChildService: boolean;
  /** Deployments filtered to the selected environment. */
  deployments: Deployment[];
  allTags: Tag[];
  siblings: { id: string; name: string; displayName: string; status: string; dependsOn: string[] | null }[];
  onNavigate: (tab: string) => void;
}) {
  const router = useRouter();

  // Tag management
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);
  const appTagIds = new Set((app.appTags ?? []).map((pt) => pt.tag.id));

  async function handleToggleTag(tagId: string) {
    const isApplied = appTagIds.has(tagId);
    setTogglingTagId(tagId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/tags`,
        {
          method: isApplied ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagId }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update tag");
        return;
      }
      toast.success(isApplied ? "Tag removed" : "Tag added");
      router.refresh();
    } catch {
      toast.error("Failed to update tag");
    } finally {
      setTogglingTagId(null);
    }
  }

  // Live memory from the org metrics stream
  const { metrics } = useAppMetrics(orgId);
  const appMetrics = metrics.get(app.id);

  // Slot + standby availability
  const lastSuccess = deployments.find((d) => d.status === "success");
  const [slotStatus, setSlotStatus] = useState<SlotStatus | null>(null);
  const latestDeployId = deployments[0]?.id;
  useEffect(() => {
    if (isChildService || !latestDeployId) return;
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/slot-status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SlotStatus | null) => {
        if (!cancelled && data) setSlotStatus(data);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [orgId, app.id, isChildService, latestDeployId]);

  const status = STATUS_META[app.status] ?? { label: app.status, className: "text-muted-foreground" };
  const isRunning = app.status === "active";

  return (
    <div className="space-y-5">
      <div className="flex gap-5">
        {/* App icon */}
        {(() => {
          const { icon: iconUrl } = detectAppType({
            imageName: app.imageName,
            gitUrl: app.gitUrl,
            deployType: app.deployType,
            name: app.name,
            displayName: app.displayName,
          });
          return iconUrl ? (
            <img src={iconUrl} alt="" className="size-12 shrink-0 mt-0.5 opacity-60" />
          ) : (
            <div className="size-12 shrink-0 rounded-lg bg-muted/50 flex items-center justify-center mt-0.5">
              <Container className="size-6 text-muted-foreground/50" />
            </div>
          );
        })()}

        <div className="flex-1 min-w-0 space-y-3">
          {/* Description + domain */}
          {app.description && (
            <p className="text-sm text-muted-foreground">{app.description}</p>
          )}

          {app.domains.length > 0 && (
            <div className="flex items-center gap-2">
              {(() => {
                const primary = app.domains.find((d) => d.isPrimary) || app.domains[0];
                const rest = app.domains.length - 1;
                return (
                  <>
                    <a
                      href={`https://${primary.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {primary.domain}
                    </a>
                    {rest > 0 && (
                      <button
                        type="button"
                        onClick={() => onNavigate("networking")}
                        className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        +{rest}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Source line */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {app.source === "git" && app.gitUrl && (
              <span className="font-mono">
                {app.gitUrl.replace("https://github.com/", "").replace(".git", "")}
                {app.gitBranch && app.gitBranch !== "main" && (
                  <span className="text-muted-foreground/50">:{app.gitBranch}</span>
                )}
              </span>
            )}
            {app.deployType === "image" && app.imageName && (
              <span className="font-mono">{app.imageName}</span>
            )}
            {app.containerPort && (
              <span>:{app.containerPort}</span>
            )}
            <span className="text-muted-foreground/40">
              {deployTypeLabel(app.deployType)}
            </span>
            {app.gpuEnabled && (
              <span className="flex items-center gap-1 text-muted-foreground/70" title="GPU passthrough enabled">
                <Cpu className="size-3" aria-hidden="true" />
                GPU
              </span>
            )}
            {isChildService && (
              <span
                className="flex items-center gap-1 text-muted-foreground/70"
                title={`Decomposed service${app.composeService ? ` "${app.composeService}"` : ""} of a compose app — resources, GPU, volumes and logs are configured here; deploy and networking live on the parent`}
              >
                <Container className="size-3" aria-hidden="true" />
                Service
              </span>
            )}
            <span className="text-muted-foreground/40">
              Created {new Date(app.createdAt).toLocaleDateString()}
            </span>
          </div>

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(app.appTags ?? []).map(({ tag }) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}15`, color: tag.color }}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </span>
            ))}
            {allTags.length > 0 && (
              <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center justify-center size-5 rounded-full border border-dashed border-muted-foreground/20 text-muted-foreground/40 hover:text-muted-foreground hover:border-muted-foreground/40 transition-colors">
                    <Plus className="size-2.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-48 p-1.5">
                  {allTags.map((tag) => {
                    const isApplied = appTagIds.has(tag.id);
                    const isToggling = togglingTagId === tag.id;
                    return (
                      <button
                        key={tag.id}
                        disabled={isToggling}
                        onClick={() => handleToggleTag(tag.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                      >
                        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="flex-1 text-left truncate">{tag.name}</span>
                        {isToggling ? <Loader2 className="size-3 animate-spin" /> : isApplied ? <Check className="size-3" /> : null}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {/* At-a-glance stats */}
      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        <Stat label="Status">
          <span className={`flex items-center gap-1.5 ${status.className}`}>
            <span
              aria-hidden="true"
              className={`size-2 rounded-full bg-current ${isRunning ? "animate-pulse" : ""}`}
            />
            {status.label}
          </span>
        </Stat>
        {isRunning && lastSuccess && (
          <Stat label="Uptime">
            <Uptime since={lastSuccess.finishedAt || lastSuccess.startedAt} />
          </Stat>
        )}
        <Stat label="Memory">
          {appMetrics ? (
            <span className="tabular-nums">
              {formatBytes(appMetrics.memoryUsage)}
              {appMetrics.memoryLimit > 0 && (
                <span className="text-muted-foreground"> / {formatBytes(appMetrics.memoryLimit)}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </Stat>
        {slotStatus && (
          <Stat label="Slot">
            <span className="capitalize">{slotStatus.activeSlot}</span>
            <span className="text-muted-foreground">
              {" · "}
              {slotStatus.standbyAvailable ? "standby ready" : "no standby"}
            </span>
          </Stat>
        )}
        {!isChildService && lastSuccess && (
          <Stat label="Last deploy">
            <button
              type="button"
              onClick={() => onNavigate("deployments")}
              className="hover:text-foreground transition-colors text-left"
            >
              {new Date(lastSuccess.finishedAt || lastSuccess.startedAt).toLocaleDateString()}
              {lastSuccess.gitSha && (
                <span className="font-mono text-muted-foreground"> · {lastSuccess.gitSha.slice(0, 7)}</span>
              )}
            </button>
          </Stat>
        )}
      </dl>

      {/* Deploy dependencies — only for apps in a project with siblings */}
      {app.projectId && siblings.length > 0 && (
        <DependencySelector
          appId={app.id}
          appName={app.name}
          orgId={orgId}
          currentDeps={app.dependsOn ?? []}
          siblings={siblings}
        />
      )}
    </div>
  );
}
