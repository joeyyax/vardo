"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  RefreshCw,
  ArrowUpCircle,
  HardDrive,
  Server,
  AlertCircle,
  Trash2,
  PackageX,
  FileCheck,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { formatBytes } from "@/lib/metrics/format";
import { containerStateVariant } from "@/lib/ui/container-state";

type ServiceStatus = {
  name: string;
  containerId: string;
  status: string;
  state: string;
  image: string;
};

type MaintenanceStatus = {
  services: ServiceStatus[];
  hasVardoDir: boolean;
};

type BuildCacheStatus = {
  size: number | null;
  reclaimable: number | null;
};

type MountPair = { source: string; destination: string };

type PlannedImage = { image: string; safety: string; bytes: number; present: boolean };

type ReclaimCandidate = {
  appId: string;
  appName: string;
  displayName: string;
  idleDays: number;
  thresholdDays: number;
  images: PlannedImage[];
  estimatedBytes: number;
};

type ReclaimSkip = {
  appId: string;
  appName: string;
  displayName: string;
  reason: string;
  explanation: string;
  image?: string;
};

type ReclaimState = {
  config: { enabled: boolean; idleDays: number };
  lastRun: {
    finishedAt: string;
    imagesRemoved: number;
    appsAffected: number;
    estimatedBytesFreed: number;
    failures: number;
    apps: string[];
  } | null;
  plan: {
    defaultIdleDays: number;
    candidates: ReclaimCandidate[];
    skipped: ReclaimSkip[];
    estimatedBytes: number;
  } | null;
};

/** Exclusions worth showing by default — the rest are routine. */
const NOTABLE_SKIPS = new Set([
  "stateful-floating",
  "floating-tag",
  "builds-locally",
  "compose-unavailable",
]);

type OwnerGap = {
  appName: string;
  dir: string;
  reason: "unreadable" | "orphaned" | "ambiguous" | "failed";
  detail: string;
};

type OwnerReport = {
  total: number;
  stamped: number;
  alreadyOwned: number;
  exempt: number;
  gaps: OwnerGap[];
  dryRun: boolean;
};

const GAP_LABELS: Record<OwnerGap["reason"], string> = {
  unreadable: "Marker could not be read",
  orphaned: "No app owns this directory",
  ambiguous: "More than one app claims the name",
  failed: "Could not be checked",
};

type MountsConfig = {
  vardoData: MountPair;
  vardoProjects: MountPair;
  vardoMount1: MountPair;
  vardoMount2: MountPair;
};

function stateLabel(state: string): string {
  if (state === "running") return "Running";
  if (state === "exited") return "Exited";
  if (state === "restarting") return "Restarting";
  if (state === "paused") return "Paused";
  if (state === "dead") return "Dead";
  return state || "Unknown";
}

export function MaintenanceSettings() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingMounts, setLoadingMounts] = useState(true);
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [mounts, setMounts] = useState<MountsConfig>({
    vardoData: { source: "", destination: "" },
    vardoProjects: { source: "", destination: "" },
    vardoMount1: { source: "", destination: "" },
    vardoMount2: { source: "", destination: "" },
  });
  const [restarting, setRestarting] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [savingMounts, setSavingMounts] = useState(false);
  const [buildCache, setBuildCache] = useState<BuildCacheStatus | null>(null);
  const [loadingBuildCache, setLoadingBuildCache] = useState(true);
  const [reclaiming, setReclaiming] = useState(false);
  const [images, setImages] = useState<ReclaimState | null>(null);
  const [loadingImages, setLoadingImages] = useState(true);
  const [idleDaysInput, setIdleDaysInput] = useState("30");
  const [savingImages, setSavingImages] = useState(false);
  const [reclaimingImages, setReclaimingImages] = useState(false);
  const [showAllSkips, setShowAllSkips] = useState(false);
  const [owners, setOwners] = useState<OwnerReport | null>(null);
  const [loadingOwners, setLoadingOwners] = useState(true);
  const [stampingOwners, setStampingOwners] = useState(false);

  useEffect(() => {
    void fetchStatus();
    void fetchMounts();
    void fetchBuildCache();
    void fetchImages();
    void fetchOwners();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/v1/admin/maintenance");
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch {
      // silently fail — service list stays empty
    } finally {
      setLoadingStatus(false);
    }
  }

  async function fetchMounts() {
    try {
      const res = await fetch("/api/v1/admin/maintenance/mounts");
      if (res.ok) {
        const data = await res.json();
        setMounts({
          vardoData: data.vardoData ?? { source: "", destination: "" },
          vardoProjects: data.vardoProjects ?? { source: "", destination: "" },
          vardoMount1: data.vardoMount1 ?? { source: "", destination: "" },
          vardoMount2: data.vardoMount2 ?? { source: "", destination: "" },
        });
      }
    } catch {
      // keep defaults
    } finally {
      setLoadingMounts(false);
    }
  }

  async function fetchBuildCache() {
    try {
      const res = await fetch("/api/v1/admin/maintenance/build-cache");
      if (res.ok) {
        setBuildCache(await res.json());
      }
    } catch {
      // leave buildCache as-is — unknown, not zero
    } finally {
      setLoadingBuildCache(false);
    }
  }

  async function handleReclaimBuildCache() {
    setReclaiming(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/build-cache", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to reclaim build cache");
        return;
      }
      toast.success(`Reclaimed ${formatBytes(data.reclaimed)}`);
      void fetchBuildCache();
    } catch {
      toast.error("Failed to reclaim build cache");
    } finally {
      setReclaiming(false);
    }
  }

  async function fetchImages() {
    try {
      const res = await fetch("/api/v1/admin/maintenance/image-reclaim");
      if (res.ok) {
        const data: ReclaimState = await res.json();
        setImages(data);
        setIdleDaysInput(String(data.config.idleDays));
      }
    } catch {
      // leave images null — the card shows that the plan is unavailable
    } finally {
      setLoadingImages(false);
    }
  }

  async function handleSaveImageConfig(enabled: boolean) {
    setSavingImages(true);
    try {
      const idleDays = Number(idleDaysInput);
      if (!Number.isInteger(idleDays) || idleDays < 1 || idleDays > 3650) {
        toast.error("Idle threshold must be between 1 and 3650 days");
        return;
      }
      const res = await fetch("/api/v1/admin/maintenance/image-reclaim", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, idleDays }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Failed to save");
        return;
      }
      toast.success(enabled ? "Scheduled reclamation on" : "Scheduled reclamation off");
      void fetchImages();
    } catch {
      toast.error("Failed to save reclamation settings");
    } finally {
      setSavingImages(false);
    }
  }

  async function handleReclaimImages() {
    setReclaimingImages(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/image-reclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to reclaim images");
        return;
      }
      const freed = data.result.reclaimed.filter((r: { freedLayers: boolean }) => r.freedLayers).length;
      toast.success(`Removed ${freed} image${freed === 1 ? "" : "s"}`, {
        description: `Up to ${formatBytes(data.result.estimatedBytesFreed)} freed. Volumes were not touched.`,
      });
      void fetchImages();
    } catch {
      toast.error("Failed to reclaim images");
    } finally {
      setReclaimingImages(false);
    }
  }

  async function fetchOwners() {
    try {
      const res = await fetch("/api/v1/admin/maintenance/app-dir-owners");
      if (res.ok) {
        setOwners(await res.json());
      }
    } catch {
      // leave owners null — the card shows that coverage is unknown
    } finally {
      setLoadingOwners(false);
    }
  }

  async function handleStampOwners() {
    setStampingOwners(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/app-dir-owners", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to stamp app directories");
        return;
      }
      const report: OwnerReport = data;
      const owned = report.stamped + report.alreadyOwned;
      toast.success(`${owned} of ${report.total} directories own a marker`, {
        description:
          report.gaps.length > 0
            ? `${report.stamped} stamped. ${report.gaps.length} still need attention.`
            : `${report.stamped} stamped.`,
      });
      setOwners(report);
    } catch {
      toast.error("Failed to stamp app directories");
    } finally {
      setStampingOwners(false);
    }
  }

  async function handleRestart(service?: string) {
    const key = service ?? "__all__";
    setRestarting(key);
    try {
      const res = await fetch("/api/v1/admin/maintenance/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(service ? { service } : {}),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast.success(data.message ?? "Restart initiated");
      if (!service || service === "vardo-frontend") {
        // Keep the button disabled through the reload window — don't clear restarting
        setTimeout(() => window.location.reload(), 6000);
        return;
      }
      // Re-fetch status so per-service badge reflects the new state
      void fetchStatus();
    } catch {
      toast.error(service ? `Failed to restart ${service}` : "Failed to restart services");
    } finally {
      // Only clear restarting if we're not waiting on a page reload
      if (service && service !== "vardo-frontend") {
        setRestarting(null);
      }
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      const res = await fetch("/api/v1/admin/maintenance/update", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Update failed");
        return;
      }
      toast.success("Update initiated", {
        description: "Rebuilding and restarting in the background. The page will refresh automatically.",
      });
      setTimeout(() => window.location.reload(), 30000);
    } catch {
      toast.error("Failed to initiate update");
    } finally {
      setUpdating(false);
    }
  }

  async function handleSaveMounts(e: React.FormEvent) {
    e.preventDefault();
    setSavingMounts(true);
    try {
      // Send all fields — empty string clears the mount, non-empty sets it.
      // Fields that aren't valid source:destination pairs are omitted to avoid a 400.
      const payload: Record<string, string> = {};
      if (mounts.vardoData.source && mounts.vardoData.destination) {
        payload.vardoData = `${mounts.vardoData.source}:${mounts.vardoData.destination}`;
      }
      if (mounts.vardoProjects.source && mounts.vardoProjects.destination) {
        payload.vardoProjects = `${mounts.vardoProjects.source}:${mounts.vardoProjects.destination}`;
      }
      if (mounts.vardoMount1.source && mounts.vardoMount1.destination) {
        payload.vardoMount1 = `${mounts.vardoMount1.source}:${mounts.vardoMount1.destination}`;
      }
      if (mounts.vardoMount2.source && mounts.vardoMount2.destination) {
        payload.vardoMount2 = `${mounts.vardoMount2.source}:${mounts.vardoMount2.destination}`;
      }

      const res = await fetch("/api/v1/admin/maintenance/mounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Failed to save mounts");
        return;
      }
      toast.success("Mount configuration saved", {
        description: "Restart the stack to apply the new mounts.",
      });
    } catch {
      toast.error("Failed to save mount configuration");
    } finally {
      setSavingMounts(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Maintenance</h2>
        <p className="text-sm text-muted-foreground">
          Manage the Vardo stack — service status, restarts, updates, and volume mounts.
        </p>
      </div>

      {/* Service overview */}
      <Card className="squircle">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="size-4" aria-hidden="true" />
            Services
          </CardTitle>
          <div className="flex items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="squircle"
                  disabled={restarting !== null || updating}
                  aria-label="Restart all services"
                >
                  {restarting === "__all__" ? (
                    <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-3" aria-hidden="true" />
                  )}
                  {restarting === "__all__" ? "Restarting..." : "Restart all"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Restart all services?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will restart the entire Vardo stack and interrupt all active sessions.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleRestart()}>
                    Restart
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent>
          {loadingStatus ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
            </div>
          ) : !status?.services.length ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              No Vardo services found. Make sure the docker socket is mounted.
            </div>
          ) : (
            <ul className="divide-y">
              {status.services.map((svc) => (
                <li
                  key={svc.containerId}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-mono">{svc.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{svc.status}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <Badge variant={containerStateVariant(svc.state)} className="text-xs">
                      {stateLabel(svc.state)}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="squircle h-7 px-2"
                      onClick={() => void handleRestart(svc.name)}
                      disabled={restarting !== null || updating}
                      aria-label={`Restart ${svc.name}`}
                    >
                      {restarting === svc.name ? (
                        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="size-3" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* One-click update */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ArrowUpCircle className="size-4" aria-hidden="true" />
            Update Vardo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pull the latest code from git, rebuild the frontend image, and restart the stack.
            The current session will be interrupted while the container restarts.
          </p>
          {!loadingStatus && !status?.hasVardoDir && (
            <div className="flex items-start gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <code className="text-xs font-mono">VARDO_HOME_DIR</code> is not set. Update requires
                access to the installation directory.
              </span>
            </div>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={updating || restarting !== null || loadingStatus || !status?.hasVardoDir}
                className="squircle"
              >
                {updating ? (
                  <>
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Updating...
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="size-4" aria-hidden="true" />
                    Pull &amp; rebuild
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Pull and rebuild?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will run git pull, rebuild the frontend image, and restart the stack.
                  All active sessions will be interrupted during the restart.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleUpdate()}>
                  Update
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* Build cache */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trash2 className="size-4" aria-hidden="true" />
            Build Cache
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Docker build cache accumulates with every app build. Reclaiming it removes
            unused layers and does not affect running services.
          </p>
          {loadingBuildCache ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking reclaimable space...
            </div>
          ) : buildCache?.reclaimable === null || buildCache?.reclaimable === undefined ? (
            <div className="flex items-center gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              Reclaimable space is unknown — Docker did not report build cache usage.
            </div>
          ) : (
            <p className="text-sm">
              <span className="font-medium">{formatBytes(buildCache.reclaimable)}</span>{" "}
              <span className="text-muted-foreground">reclaimable</span>
              {buildCache.size !== null && (
                <span className="text-muted-foreground"> of {formatBytes(buildCache.size)} total</span>
              )}
            </p>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={reclaiming || loadingBuildCache}
                className="squircle"
              >
                {reclaiming ? (
                  <>
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Reclaiming...
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Reclaim build cache
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Reclaim build cache?</AlertDialogTitle>
                <AlertDialogDescription>
                  {buildCache?.reclaimable != null
                    ? `This will remove all unused build cache, freeing approximately ${formatBytes(buildCache.reclaimable)}. This cannot be undone.`
                    : "Reclaimable space is currently unknown. This will remove all unused build cache. This cannot be undone."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleReclaimBuildCache()}>
                  Reclaim
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* Idle app images */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PackageX className="size-4" aria-hidden="true" />
            Idle App Images
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Removes the images of apps that have not run for a while. Each app pulls its
            image again the next time it starts. Volumes are never touched.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="reclaim-idle-days" className="text-xs text-muted-foreground">
                Idle for at least (days)
              </Label>
              <Input
                id="reclaim-idle-days"
                type="number"
                min={1}
                max={3650}
                value={idleDaysInput}
                onChange={(e) => setIdleDaysInput(e.target.value)}
                className="w-28 font-mono text-sm"
              />
            </div>
            <Button
              variant="outline"
              disabled={savingImages || loadingImages}
              onClick={() => void handleSaveImageConfig(images?.config.enabled ?? false)}
            >
              {savingImages && (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              )}
              Save threshold
            </Button>
            <Button
              variant={images?.config.enabled ? "secondary" : "outline"}
              disabled={savingImages || loadingImages}
              onClick={() => void handleSaveImageConfig(!(images?.config.enabled ?? false))}
            >
              {images?.config.enabled ? "Daily sweep: on" : "Daily sweep: off"}
            </Button>
          </div>

          {loadingImages ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking which apps are idle...
            </div>
          ) : !images?.plan ? (
            <div className="flex items-center gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              Could not read the image list — the plan is unavailable.
            </div>
          ) : images.plan.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is eligible right now.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">{images.plan.candidates.length}</span>{" "}
                <span className="text-muted-foreground">
                  app{images.plan.candidates.length === 1 ? "" : "s"} eligible, up to{" "}
                </span>
                <span className="font-medium">{formatBytes(images.plan.estimatedBytes)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  — an upper bound, since images share layers.
                </span>
              </p>
              <ul className="divide-y rounded-md border">
                {images.plan.candidates.map((c) => (
                  <li key={c.appId} className="flex items-start justify-between gap-4 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-medium">{c.displayName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {c.images.filter((i) => i.present).map((i) => i.image).join(", ")}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-mono">{formatBytes(c.estimatedBytes)}</p>
                      <p className="text-xs text-muted-foreground">idle {c.idleDays}d</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {images?.plan && images.plan.skipped.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAllSkips((v) => !v)}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                {showAllSkips ? "Hide" : "Show"} {images.plan.skipped.length} excluded app
                {images.plan.skipped.length === 1 ? "" : "s"}
              </button>
              <ul className="space-y-1">
                {images.plan.skipped
                  .filter((s) => showAllSkips || NOTABLE_SKIPS.has(s.reason))
                  .map((s) => (
                    <li key={s.appId} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{s.displayName}</span>{" "}
                      — {s.explanation}
                      {s.image && <span className="font-mono"> ({s.image})</span>}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {images?.lastRun && (
            <p className="text-xs text-muted-foreground">
              Last run {new Date(images.lastRun.finishedAt).toLocaleString()} — removed{" "}
              {images.lastRun.imagesRemoved} image
              {images.lastRun.imagesRemoved === 1 ? "" : "s"} from {images.lastRun.appsAffected} app
              {images.lastRun.appsAffected === 1 ? "" : "s"}, up to{" "}
              {formatBytes(images.lastRun.estimatedBytesFreed)}
              {images.lastRun.failures > 0 && `, ${images.lastRun.failures} could not be removed`}.
            </p>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={
                  reclaimingImages || loadingImages || !images?.plan?.candidates.length
                }
              >
                {reclaimingImages ? (
                  <>
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Reclaiming...
                  </>
                ) : (
                  <>
                    <PackageX className="size-4" aria-hidden="true" />
                    Reclaim now
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Reclaim images for idle apps?</AlertDialogTitle>
                <AlertDialogDescription>
                  {images?.plan
                    ? `This removes the images of ${images.plan.candidates.length} idle app(s), freeing up to ${formatBytes(images.plan.estimatedBytes)}. Volumes are not touched, and each app pulls its image again on next start.`
                    : "This removes the images of idle apps. Volumes are not touched."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleReclaimImages()}>
                  Reclaim
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* App directory ownership */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileCheck className="size-4" aria-hidden="true" />
            App Directory Ownership
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Each app directory carries a marker naming the app that owns it, so a destructive
            operation can never hit another app&apos;s files. Directories created before markers
            existed are matched by name and stamped.
          </p>

          {loadingOwners ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking coverage...
            </div>
          ) : !owners ? (
            <div className="flex items-center gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              Could not read the app directory — coverage is unknown.
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">
                  {(owners.dryRun ? owners.alreadyOwned : owners.stamped + owners.alreadyOwned)} of{" "}
                  {owners.total}
                </span>{" "}
                <span className="text-muted-foreground">
                  director{owners.total === 1 ? "y" : "ies"} own a marker
                </span>
                {owners.dryRun && owners.stamped > 0 && (
                  <span className="text-muted-foreground">, {owners.stamped} ready to stamp</span>
                )}
                {owners.exempt > 0 && (
                  <span className="text-muted-foreground">, {owners.exempt} exempt</span>
                )}
                .
              </p>

              {owners.gaps.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {owners.gaps.map((g) => (
                    <li key={g.dir} className="px-3 py-2 space-y-0.5">
                      <p className="text-sm font-medium">{g.appName}</p>
                      <p className="text-xs text-muted-foreground">
                        {GAP_LABELS[g.reason]} — {g.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Button
            variant="outline"
            className="squircle"
            disabled={stampingOwners || loadingOwners}
            onClick={() => void handleStampOwners()}
          >
            {stampingOwners ? (
              <>
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Stamping...
              </>
            ) : (
              <>
                <FileCheck className="size-4" aria-hidden="true" />
                Stamp directories
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Mount configuration */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <HardDrive className="size-4" aria-hidden="true" />
            Host Mounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingMounts ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
            </div>
          ) : (
            <form onSubmit={(e) => void handleSaveMounts(e)} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Host mounts for the Vardo container. Each mount is a source:destination pair.
                Changes require a stack restart to take effect — the pairs are written to{" "}
                <code className="text-xs font-mono">.env</code>.
                Leave both fields blank to clear that mount.
              </p>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">
                    Data directory{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_DATA)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2 items-start">
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-data-source" className="text-xs text-muted-foreground">
                        Source (host path)
                      </Label>
                      <Input
                        id="vardo-data-source"
                        placeholder="/mnt/data"
                        value={mounts.vardoData.source}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoData: { source: e.target.value, destination: m.vardoData.destination },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-data-dest" className="text-xs text-muted-foreground">
                        Destination (container path)
                      </Label>
                      <Input
                        id="vardo-data-dest"
                        placeholder="/var/lib/vardo/data"
                        value={mounts.vardoData.destination}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoData: { source: m.vardoData.source, destination: e.target.value },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">
                    Projects directory{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_PROJECTS)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2 items-start">
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-projects-source" className="text-xs text-muted-foreground">
                        Source (host path)
                      </Label>
                      <Input
                        id="vardo-projects-source"
                        placeholder="/home/user/projects"
                        value={mounts.vardoProjects.source}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoProjects: { source: e.target.value, destination: m.vardoProjects.destination },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-projects-dest" className="text-xs text-muted-foreground">
                        Destination (container path)
                      </Label>
                      <Input
                        id="vardo-projects-dest"
                        placeholder="/var/lib/vardo/projects"
                        value={mounts.vardoProjects.destination}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoProjects: { source: m.vardoProjects.source, destination: e.target.value },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">
                    Extra mount 1{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_MOUNT_1)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2 items-start">
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-mount-1-source" className="text-xs text-muted-foreground">
                        Source (host path)
                      </Label>
                      <Input
                        id="vardo-mount-1-source"
                        placeholder="/path/on/host"
                        value={mounts.vardoMount1.source}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoMount1: { source: e.target.value, destination: m.vardoMount1.destination },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-mount-1-dest" className="text-xs text-muted-foreground">
                        Destination (container path)
                      </Label>
                      <Input
                        id="vardo-mount-1-dest"
                        placeholder="/path/in/container"
                        value={mounts.vardoMount1.destination}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoMount1: { source: m.vardoMount1.source, destination: e.target.value },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">
                    Extra mount 2{" "}
                    <span className="text-xs text-muted-foreground font-mono">(VARDO_MOUNT_2)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2 items-start">
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-mount-2-source" className="text-xs text-muted-foreground">
                        Source (host path)
                      </Label>
                      <Input
                        id="vardo-mount-2-source"
                        placeholder="/path/on/host"
                        value={mounts.vardoMount2.source}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoMount2: { source: e.target.value, destination: m.vardoMount2.destination },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="vardo-mount-2-dest" className="text-xs text-muted-foreground">
                        Destination (container path)
                      </Label>
                      <Input
                        id="vardo-mount-2-dest"
                        placeholder="/path/in/container"
                        value={mounts.vardoMount2.destination}
                        onChange={(e) => setMounts((m) => ({
                          ...m,
                          vardoMount2: { source: m.vardoMount2.source, destination: e.target.value },
                        }))}
                        className="squircle font-mono text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <Button type="submit" className="squircle" disabled={savingMounts}>
                {savingMounts && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Save mounts
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
