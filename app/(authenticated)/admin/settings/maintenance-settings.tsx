"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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
import { DetachedVolumesCard } from "./detached-volumes-card";

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

type SlotCandidate = {
  project: string;
  appName: string;
  images: { image: string; service: string; bytes: number; present: boolean }[];
  estimatedBytes: number;
  /** Present when this generation is an environment's standby. */
  rollbackTargetFor?: { appName: string; envName: string; liveSlot: string };
  warning?: { reason: string; explanation: string };
};

type SlotSkip = {
  project: string;
  image: string;
  reason: string;
  explanation: string;
  bytes: number;
};

type ReclaimState = {
  config: { enabled: boolean; idleDays: number; slots: boolean; slotRollbackTargets: boolean };
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
  slotPlan: {
    candidates: SlotCandidate[];
    skipped: SlotSkip[];
    estimatedBytes: number;
  } | null;
};

/** Exclusions shown by default. */
const NOTABLE_SKIPS = new Set([
  "stateful-floating",
  "floating-tag",
  "builds-locally",
  "compose-unavailable",
]);

type OwnerGap = {
  appName: string;
  dir: string;
  reason: "unreadable" | "orphaned" | "ambiguous" | "unwritable" | "failed";
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
  unreadable: "Ownership file couldn't be read",
  orphaned: "No app owns this directory",
  ambiguous: "More than one app claims the name",
  unwritable: "Ownership file couldn't be written",
  failed: "Couldn't be checked",
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
  // Previous deploys are opt-in per run, matching the API.
  const [includeSlots, setIncludeSlots] = useState(false);
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
      // Service list stays empty.
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
      // Leave buildCache as-is: unknown, not zero.
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
        toast.error(data.error ?? "Couldn't reclaim build cache");
        return;
      }
      toast.success(`Reclaimed ${formatBytes(data.reclaimed)}`);
      void fetchBuildCache();
    } catch {
      toast.error("Couldn't reclaim build cache");
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

  async function handleSaveImageConfig(
    enabled: boolean,
    slotRollbackTargets = images?.config.slotRollbackTargets ?? false,
  ) {
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
        body: JSON.stringify({
          enabled,
          idleDays,
          slots: images?.config.slots ?? false,
          slotRollbackTargets,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Couldn't save");
        return;
      }
      toast.success(enabled ? "Scheduled reclamation on" : "Scheduled reclamation off");
      void fetchImages();
    } catch {
      toast.error("Couldn't save reclamation settings");
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
        body: JSON.stringify({ dryRun: false, slots: includeSlots }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't reclaim images");
        return;
      }
      const idle = data.result.reclaimed.length;
      const slots = data.slotResult?.reclaimed.length ?? 0;
      toast.success(`Removed ${idle + slots} image${idle + slots === 1 ? "" : "s"}`, {
        description: slots
          ? `${idle} from idle apps, ${slots} from previous deploys. Volumes weren't touched.`
          : "Volumes weren't touched.",
      });
      void fetchImages();
    } catch {
      toast.error("Couldn't reclaim images");
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
        toast.error(data.error ?? "Couldn't assign directory owners");
        return;
      }
      const report: OwnerReport = data;
      const owned = report.stamped + report.alreadyOwned;
      toast.success(`${owned} of ${report.total} directories have an owner`, {
        description:
          report.gaps.length > 0
            ? `${report.stamped} newly assigned. ${report.gaps.length} still need attention.`
            : `${report.stamped} newly assigned.`,
      });
      setOwners(report);
    } catch {
      toast.error("Couldn't assign directory owners");
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
        // Stay disabled through the reload window.
        setTimeout(() => window.location.reload(), 6000);
        return;
      }
      // Refresh per-service badges.
      void fetchStatus();
    } catch {
      toast.error(service ? `Couldn't restart ${service}` : "Couldn't restart services");
    } finally {
      // Clear restarting unless a page reload is pending.
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
      toast.error("Couldn't initiate update");
    } finally {
      setUpdating(false);
    }
  }

  async function handleSaveMounts(e: React.FormEvent) {
    e.preventDefault();
    setSavingMounts(true);
    try {
      // Empty string clears a mount. Invalid source:destination pairs are omitted to avoid a 400.
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
        toast.error(data.error ?? "Couldn't save mounts");
        return;
      }
      toast.success("Mount configuration saved", {
        description: "Restart the stack to apply the new mounts.",
      });
    } catch {
      toast.error("Couldn't save mount configuration");
    } finally {
      setSavingMounts(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Maintenance</h2>
        <p className="text-sm text-muted-foreground">
          Manage the Vardo stack — service status, restarts, updates and volume mounts.
        </p>
      </div>

      {/* Service overview */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4" aria-hidden="true" />
            Services
          </CardTitle>
          <div className="flex items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
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
                    This restarts the shared services (database, cache, proxy and the rest) and interrupts active sessions. The frontend updates through Update.
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
                      className="h-7 px-2"
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowUpCircle className="size-4" aria-hidden="true" />
            Update Vardo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pull the latest code from git, rebuild the frontend image and restart the stack.
            The current session will be interrupted while the container restarts.
          </p>
          {!loadingStatus && !status?.hasVardoDir && (
            <div className="flex items-start gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <code className="text-xs font-mono">VARDO_HOME_DIR</code> isn&apos;t set. Update requires
                access to the installation directory.
              </span>
            </div>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={updating || restarting !== null || loadingStatus || !status?.hasVardoDir}
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
                  This will run git pull, rebuild the frontend image and restart the stack.
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="size-4" aria-hidden="true" />
            Build cache
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Docker build cache accumulates with every app build. Reclaiming it removes
            unused layers and doesn&apos;t affect running services.
          </p>
          {loadingBuildCache ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking reclaimable space...
            </div>
          ) : buildCache?.reclaimable === null || buildCache?.reclaimable === undefined ? (
            <div className="flex items-center gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              Reclaimable space is unknown — Docker didn&apos;t report build cache usage.
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
                    ? `This removes all unused build cache, freeing about ${formatBytes(buildCache.reclaimable)}. This can't be undone.`
                    : "Reclaimable space is unknown. This removes all unused build cache. This can't be undone."}
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageX className="size-4" aria-hidden="true" />
            Idle app images
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Removes the images of apps that haven&apos;t run for a while. Each app pulls its
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
            <Button
              variant={images?.config.slotRollbackTargets ? "secondary" : "outline"}
              disabled={savingImages || loadingImages}
              onClick={() =>
                void handleSaveImageConfig(
                  images?.config.enabled ?? false,
                  !(images?.config.slotRollbackTargets ?? false),
                )
              }
            >
              {images?.config.slotRollbackTargets
                ? "Daily sweep takes rollback targets: on"
                : "Daily sweep takes rollback targets: off"}
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
              Couldn&apos;t read the image list — the plan is unavailable.
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
              <ul className={cn(cardVariants({ variant: "inset" }), "divide-y rounded-md")}>
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

          {images?.slotPlan && images.slotPlan.candidates.length > 0 && (
            <Card variant="inset" className="space-y-2 rounded-md p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="type-h4">Previous deploys</p>
                  <p className="text-xs text-muted-foreground">
                    Images from previous deploys nothing is serving. Up to{" "}
                    {formatBytes(images.slotPlan.estimatedBytes)} — an upper bound,
                    since images share layers.
                  </p>
                </div>
                <Button
                  variant={includeSlots ? "secondary" : "outline"}
                  size="sm"
                  className="shrink-0"
                  onClick={() => setIncludeSlots((v) => !v)}
                >
                  {includeSlots ? "Included" : "Include"}
                </Button>
              </div>
              <ul className="divide-y rounded-md bg-muted">
                {images.slotPlan.candidates.map((c) => (
                  <li key={c.project} className="flex items-start justify-between gap-4 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-medium">{c.project}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {c.images.filter((i) => i.present).map((i) => i.image).join(", ")}
                      </p>
                      {c.warning && (
                        <p className="flex items-center gap-1 text-xs text-status-warning">
                          <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                          {c.warning.explanation}
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 text-xs font-mono">{formatBytes(c.estimatedBytes)}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {images?.lastRun && (
            <p className="text-xs text-muted-foreground">
              Last run {new Date(images.lastRun.finishedAt).toLocaleString()} — removed{" "}
              {images.lastRun.imagesRemoved} image
              {images.lastRun.imagesRemoved === 1 ? "" : "s"} from {images.lastRun.appsAffected} app
              {images.lastRun.appsAffected === 1 ? "" : "s"}, up to{" "}
              {formatBytes(images.lastRun.estimatedBytesFreed)}
              {images.lastRun.failures > 0 && `, ${images.lastRun.failures} couldn't be removed`}.
            </p>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={
                  reclaimingImages ||
                  loadingImages ||
                  !(
                    images?.plan?.candidates.length ||
                    (includeSlots && images?.slotPlan?.candidates.length)
                  )
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
                <AlertDialogTitle>
                  {includeSlots ? "Reclaim images and previous deploys?" : "Reclaim images for idle apps?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {[
                    images?.plan?.candidates.length
                      ? `Removes the images of ${images.plan.candidates.length} idle app(s), which pull again on next start.`
                      : null,
                    includeSlots && images?.slotPlan?.candidates.length
                      ? `Removes ${images.slotPlan.candidates.length} previous deploy${images.slotPlan.candidates.length === 1 ? "" : "s"}${
                          images.slotPlan.candidates.some((c) => c.rollbackTargetFor)
                            ? ", including one that is a live app's rollback target — that app would need a rebuild to roll back"
                            : ""
                        }.`
                      : null,
                    "Volumes aren't touched.",
                  ]
                    .filter(Boolean)
                    .join(" ")}
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

      <DetachedVolumesCard />

      {/* Directory ownership */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCheck className="size-4" aria-hidden="true" />
            App directory ownership
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Each app directory carries an ownership file naming the app that owns it, so a destructive
            operation can never hit another app&apos;s files. Directories created before ownership
            files existed are matched by name and assigned one.
          </p>

          {loadingOwners ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking coverage...
            </div>
          ) : !owners ? (
            <div className="flex items-center gap-2 text-sm text-status-warning">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              Couldn&apos;t read the app directory — coverage is unknown.
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">
                  {(owners.dryRun ? owners.alreadyOwned : owners.stamped + owners.alreadyOwned)} of{" "}
                  {owners.total}
                </span>{" "}
                <span className="text-muted-foreground">
                  director{owners.total === 1 ? "y has" : "ies have"} an owner
                </span>
                {owners.dryRun && owners.stamped > 0 && (
                  <span className="text-muted-foreground">, {owners.stamped} ready to assign</span>
                )}
                {owners.exempt > 0 && (
                  <span className="text-muted-foreground">, {owners.exempt} exempt</span>
                )}
                {owners.gaps.length > 0 && (
                  <span className="text-muted-foreground">, {owners.gaps.length} without one</span>
                )}
                .
              </p>

              {owners.gaps.length > 0 && (
                <div className="space-y-1.5">
                  <p id="owner-gaps" className="type-label text-muted-foreground">
                    Without an owner
                  </p>
                  <ul aria-labelledby="owner-gaps" className={cn(cardVariants({ variant: "inset" }), "divide-y rounded-md")}>
                    {owners.gaps.map((g) => (
                      <li key={g.dir} className="px-3 py-2 space-y-0.5">
                        <p className="text-sm font-medium">{g.appName}</p>
                        <p className="text-xs text-muted-foreground">
                          {GAP_LABELS[g.reason]} — {g.detail}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <Button
            variant="outline"
            disabled={stampingOwners || loadingOwners}
            onClick={() => void handleStampOwners()}
          >
            {stampingOwners ? (
              <>
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Assigning owners...
              </>
            ) : (
              <>
                <FileCheck className="size-4" aria-hidden="true" />
                Assign owners
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Mount configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="size-4" aria-hidden="true" />
            Host mounts
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
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
                        className="font-mono text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <Button type="submit" disabled={savingMounts}>
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
