"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Plus,
  Play,
  Archive,
  Cloud,
  Server,
  Clock,
  CheckCircle2,
  XCircle,

  Trash2,
  Power,
  PowerOff,
  Download,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { formatBytes } from "@/lib/metrics/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type App = {
  id: string;
  name: string;
  displayName: string;
};

type BackupTarget = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  isAppLevel?: boolean;
};

type BackupHistoryEntry = {
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
};

type BackupJob = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  keepLast: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  createdAt: string;
  target: { id: string; name: string; type: string };
  backupJobApps: {
    app: App;
  }[];
  backups: BackupHistoryEntry[];
};

type RecentBackup = {
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  storagePath: string | null;
  log: string | null;
  job: { id: string; name: string };
  app: App;
};

type Props = {
  orgId: string;
  apps: App[];
};

type TargetType = "s3" | "r2" | "b2" | "ssh";

// ---------------------------------------------------------------------------
// Schedule presets
// ---------------------------------------------------------------------------

const SCHEDULE_PRESETS = [
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 2 AM", value: "0 2 * * *" },
  { label: "Weekly (Sunday 2 AM)", value: "0 2 * * 0" },
  { label: "Manual only", value: "manual" },
] as const;

function scheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  return cron;
}

// ---------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------

function targetSubtitle(target: BackupTarget): string {
  const config = target.config as Record<string, string>;
  switch (target.type) {
    case "s3":
    case "r2":
    case "b2":
      return config.endpoint || config.region || "";
    case "ssh":
      return `${config.username || "root"}@${config.host}:${config.path || "/"}`;
    case "local":
      return config.path || "";
    default:
      return target.type;
  }
}

function targetDisplayName(target: BackupTarget): string {
  const config = target.config as Record<string, string>;
  switch (target.type) {
    case "s3":
    case "r2":
    case "b2":
      return `${target.type}: ${config.bucket || ""}`;
    case "ssh":
      return `ssh: ${config.username || "root"}@${config.host}:${config.path || "/"}`;
    default:
      return target.name;
  }
}

function TargetIcon({ type }: { type: string }) {
  switch (type) {
    case "s3":
    case "r2":
    case "b2":
      return <Cloud className="size-4 text-muted-foreground shrink-0" />;
    case "ssh":
      return <Server className="size-4 text-muted-foreground shrink-0" />;
    default:
      return <Server className="size-4 text-muted-foreground shrink-0" />;
  }
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "success":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success">
          <CheckCircle2 className="mr-1 size-3" />
          Success
        </Badge>
      );
    case "running":
      return (
        <Badge className="border-transparent bg-status-warning-muted text-status-warning">
          <Loader2 className="mr-1 size-3 animate-spin" />
          Running
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 size-3" />
          Failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline">
          <Clock className="mr-1 size-3" />
          Pending
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BackupManager({ orgId, apps }: Props) {
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [recentHistory, setRecentHistory] = useState<RecentBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const [restoringBackups, setRestoringBackups] = useState<Set<string>>(
    new Set()
  );

  // New job form
  const [jobSheetOpen, setJobSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newJobName, setNewJobName] = useState("");
  const [newJobTargetId, setNewJobTargetId] = useState("");
  const [newJobSchedule, setNewJobSchedule] = useState("0 2 * * *");
  const [newJobAppIds, setNewJobAppIds] = useState<string[]>([]);
  const [newJobKeepLast, setNewJobKeepLast] = useState("7");

  // New target form
  const [targetSheetOpen, setTargetSheetOpen] = useState(false);
  const [savingTarget, setSavingTarget] = useState(false);
  const [newTargetName, setNewTargetName] = useState("");
  const [newTargetType, setNewTargetType] = useState<TargetType>("s3");

  // S3/R2/B2 fields
  const [newBucket, setNewBucket] = useState("");
  const [newRegion, setNewRegion] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("");
  const [newAccessKeyId, setNewAccessKeyId] = useState("");
  const [newSecretAccessKey, setNewSecretAccessKey] = useState("");
  const [newPrefix, setNewPrefix] = useState("");

  // SSH fields
  const [newSshHost, setNewSshHost] = useState("");
  const [newSshPort, setNewSshPort] = useState("");
  const [newSshUsername, setNewSshUsername] = useState("");
  const [newSshPrivateKey, setNewSshPrivateKey] = useState("");
  const [newSshPath, setNewSshPath] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [jobsRes, targetsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/backups`),
        fetch(`/api/v1/organizations/${orgId}/backups/targets`),
      ]);

      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
        setRecentHistory(data.recentHistory || []);
      }

      if (targetsRes.ok) {
        const data = await targetsRes.json();
        setTargets(data.targets || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // -- Reset target form --
  function resetTargetForm() {
    setNewTargetName("");
    setNewTargetType("s3");
    setNewBucket("");
    setNewRegion("");
    setNewEndpoint("");
    setNewAccessKeyId("");
    setNewSecretAccessKey("");
    setNewPrefix("");
    setNewSshHost("");
    setNewSshPort("");
    setNewSshUsername("");
    setNewSshPrivateKey("");
    setNewSshPath("");
  }

  // -- Build target config from form state --
  function buildTargetConfig(): Record<string, unknown> {
    switch (newTargetType) {
      case "s3":
        return {
          bucket: newBucket.trim(),
          region: newRegion.trim(),
          ...(newEndpoint.trim() && { endpoint: newEndpoint.trim() }),
          accessKeyId: newAccessKeyId.trim(),
          secretAccessKey: newSecretAccessKey.trim(),
          ...(newPrefix.trim() && { prefix: newPrefix.trim() }),
        };
      case "r2":
        return {
          bucket: newBucket.trim(),
          region: newRegion.trim() || "auto",
          endpoint: newEndpoint.trim(),
          accessKeyId: newAccessKeyId.trim(),
          secretAccessKey: newSecretAccessKey.trim(),
          ...(newPrefix.trim() && { prefix: newPrefix.trim() }),
        };
      case "b2":
        return {
          bucket: newBucket.trim(),
          region: newRegion.trim(),
          endpoint: newEndpoint.trim(),
          accessKeyId: newAccessKeyId.trim(),
          secretAccessKey: newSecretAccessKey.trim(),
          ...(newPrefix.trim() && { prefix: newPrefix.trim() }),
        };
      case "ssh":
        return {
          host: newSshHost.trim(),
          ...(newSshPort.trim() && { port: parseInt(newSshPort, 10) }),
          username: newSshUsername.trim(),
          ...(newSshPrivateKey.trim() && {
            privateKey: newSshPrivateKey.trim(),
          }),
          path: newSshPath.trim(),
        };
    }
  }

  // -- Validate target form --
  function isTargetFormValid(): boolean {
    if (!newTargetName.trim()) return false;
    switch (newTargetType) {
      case "s3":
        return !!(
          newBucket.trim() &&
          newRegion.trim() &&
          newAccessKeyId.trim() &&
          newSecretAccessKey.trim()
        );
      case "r2":
        return !!(
          newBucket.trim() &&
          newEndpoint.trim() &&
          newAccessKeyId.trim() &&
          newSecretAccessKey.trim()
        );
      case "b2":
        return !!(
          newBucket.trim() &&
          newRegion.trim() &&
          newAccessKeyId.trim() &&
          newSecretAccessKey.trim()
        );
      case "ssh":
        return !!(
          newSshHost.trim() &&
          newSshUsername.trim() &&
          newSshPath.trim()
        );
    }
  }

  // -- Create target --
  async function createTarget() {
    if (!isTargetFormValid()) return;

    setSavingTarget(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/targets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newTargetName.trim(),
            type: newTargetType,
            config: buildTargetConfig(),
            isDefault: targets.length === 0,
          }),
        }
      );

      if (res.ok) {
        toast.success("Backup target created");
        setTargetSheetOpen(false);
        resetTargetForm();
        fetchData();
      } else {
        const err = await res.json();
        toast.error("Couldn't create backup target", {
          description: err.error || "Check storage credentials",
        });
      }
    } catch {
      toast.error("Couldn't create backup target", {
        description: "Check your connection and try again",
      });
    } finally {
      setSavingTarget(false);
    }
  }

  // -- Create job --
  async function createJob() {
    if (
      !newJobName.trim() ||
      !newJobTargetId ||
      newJobAppIds.length === 0
    ) {
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newJobName.trim(),
          targetId: newJobTargetId,
          appIds: newJobAppIds,
          schedule: newJobSchedule,
          keepLast: newJobKeepLast ? parseInt(newJobKeepLast, 10) : null,
        }),
      });

      if (res.ok) {
        toast.success("Backup job created");
        setJobSheetOpen(false);
        resetJobForm();
        fetchData();
      } else {
        const err = await res.json();
        toast.error("Couldn't create backup job", {
          description: err.error || "Check schedule and app selection",
        });
      }
    } catch {
      toast.error("Couldn't create backup job", {
        description: "Check your connection and try again",
      });
    } finally {
      setSaving(false);
    }
  }

  function resetJobForm() {
    setNewJobName("");
    setNewJobTargetId("");
    setNewJobSchedule("0 2 * * *");
    setNewJobAppIds([]);
    setNewJobKeepLast("7");
  }

  // -- Run backup --
  async function runNow(jobId: string) {
    setRunningJobs((prev) => new Set(prev).add(jobId));

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/jobs/${jobId}/run`,
        { method: "POST" }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          toast.success("Backup completed successfully");
        } else {
          toast.error("Backup completed with errors", {
            description: "Check the logs for details",
          });
        }
        fetchData();
      } else {
        const err = await res.json();
        toast.error("Couldn't run backup", {
          description: err.error || "Check target connectivity",
        });
      }
    } catch {
      toast.error("Couldn't run backup", {
        description: "Check your connection and try again",
      });
    } finally {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }

  // -- Toggle enabled --
  async function toggleEnabled(jobId: string, enabled: boolean) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/jobs/${jobId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );

      if (res.ok) {
        toast.success(enabled ? "Backup job enabled" : "Backup job paused");
        fetchData();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error("Couldn't update backup job", {
          description: err.error,
        });
      }
    } catch {
      toast.error("Couldn't update backup job", {
        description: "Check your connection and try again",
      });
    }
  }

  // -- Delete job --
  async function deleteJob(jobId: string) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/jobs/${jobId}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        toast.success("Backup job deleted");
        fetchData();
      } else {
        const err = await res.json();
        toast.error("Couldn't delete backup job", {
          description: err.error,
        });
      }
    } catch {
      toast.error("Couldn't delete backup job", {
        description: "Check your connection and try again",
      });
    }
  }

  // -- Restore backup --
  async function restoreBackup(backupId: string) {
    setRestoringBackups((prev) => new Set(prev).add(backupId));

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/history/${backupId}/restore`,
        { method: "POST" }
      );

      if (res.ok) {
        toast.success("Backup restored successfully");
        fetchData();
      } else {
        const err = await res.json();
        toast.error("Couldn't restore backup", {
          description: err.error || "Check target connectivity and try again",
        });
      }
    } catch {
      toast.error("Couldn't restore backup", {
        description: "Check your connection and try again",
      });
    } finally {
      setRestoringBackups((prev) => {
        const next = new Set(prev);
        next.delete(backupId);
        return next;
      });
    }
  }

  // -- Toggle app selection --
  function toggleApp(appId: string) {
    setNewJobAppIds((prev) =>
      prev.includes(appId)
        ? prev.filter((id) => id !== appId)
        : [...prev, appId]
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Separate app-level (Host-managed) targets/jobs from user targets/jobs
  const appLevelTargets = targets.filter((t) => t.isAppLevel);
  const userTargets = targets.filter((t) => !t.isAppLevel);
  const appLevelJobs = jobs.filter((j) => appLevelTargets.some((t) => t.id === j.target.id));
  const userJobs = jobs.filter((j) => !appLevelTargets.some((t) => t.id === j.target.id));
  const appLevelHistory = recentHistory.filter((h) =>
    appLevelJobs.some((j) => j.id === h.job.id)
  );
  const userHistory = recentHistory.filter(
    (h) => !appLevelJobs.some((j) => j.id === h.job.id)
  );

  return (
    <div className="space-y-8">
      {/* Host-managed backups (app-level) */}
      {appLevelTargets.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-medium">Automatic Backups</h2>
            <p className="text-sm text-muted-foreground">
              Your data is automatically backed up by Host. These backups are read-only.
            </p>
          </div>

          {appLevelJobs.length > 0 && (
            <div className="space-y-2">
              {appLevelJobs.map((job) => {
                const lastBackup = job.backups[0];
                return (
                  <div
                    key={job.id}
                    className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Archive className="size-4 text-status-success shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{job.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {scheduleLabel(job.schedule)}
                          {lastBackup && (
                            <> &middot; Last: {new Date(lastBackup.startedAt).toLocaleDateString()}</>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {lastBackup && <StatusBadge status={lastBackup.status} />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {appLevelHistory.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Recent automatic backups</h3>
              <div className="divide-y rounded-lg border">
                {appLevelHistory.slice(0, 5).map((backup) => (
                  <div key={backup.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <StatusBadge status={backup.status} />
                      <div className="min-w-0">
                        <p className="text-sm">{backup.app.displayName}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(backup.startedAt).toLocaleString()}
                          {backup.sizeBytes != null && <> &middot; {formatBytes(backup.sizeBytes)}</>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Restore"
                        disabled={restoringBackups.has(backup.id)}
                        onClick={() => restoreBackup(backup.id)}
                      >
                        {restoringBackups.has(backup.id) ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </Button>
                      {backup.storagePath && (
                        <Button size="icon-xs" variant="ghost" title="Download" asChild>
                          <a href={`/api/v1/organizations/${orgId}/backups/history/${backup.id}/download`}>
                            <Download className="size-3.5" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* External / User Backups */}
      {appLevelTargets.length > 0 && (
        <div className="border-t pt-8">
          <h2 className="text-lg font-medium mb-1">External Backups</h2>
          <p className="text-sm text-muted-foreground mb-6">
            Configure your own backup targets and schedules.
          </p>
        </div>
      )}

      {/* Backup Targets */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">{appLevelTargets.length > 0 ? "Your Storage Targets" : "Storage Targets"}</h2>
            <p className="text-sm text-muted-foreground">
              Where your backups are stored.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              resetTargetForm();
              setTargetSheetOpen(true);
            }}
          >
            <Plus className="mr-1.5 size-4" />
            Add Target
          </Button>
        </div>

        {targets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <Cloud className="size-8 text-muted-foreground/50" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">Add a storage target to get started</p>
              <p className="text-sm text-muted-foreground">
                Connect an S3 bucket, Cloudflare R2, Backblaze B2, or SSH server to store your backups.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                resetTargetForm();
                setNewTargetName("S3 Storage");
                setTargetSheetOpen(true);
              }}
            >
              <Plus className="mr-1.5 size-4" />
              Add Target
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {targets.map((target) => (
              <div
                key={target.id}
                className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <TargetIcon type={target.type} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{target.name}</p>
                      <Badge variant="secondary" className="text-xs">
                        {target.type}
                      </Badge>
                      {target.isDefault && (
                        <Badge variant="outline" className="text-xs">
                          default
                        </Badge>
                      )}
                      {target.isAppLevel && (
                        <Badge variant="outline" className="text-xs">
                          System
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                      {targetSubtitle(target)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Backup Jobs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Backup Jobs</h2>
            <p className="text-sm text-muted-foreground">
              Scheduled and manual backup configurations.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              resetJobForm();
              if (targets.length > 0) {
                setNewJobTargetId(targets[0].id);
              }
              setJobSheetOpen(true);
            }}
            disabled={targets.length === 0}
          >
            <Plus className="mr-1.5 size-4" />
            New Job
          </Button>
        </div>

        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <Archive className="size-8 text-muted-foreground/50" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">
                {targets.length === 0 ? "Set up a storage target first" : "Protect your data"}
              </p>
              <p className="text-sm text-muted-foreground">
                {targets.length === 0
                  ? "Add a storage target above, then create backup jobs to schedule automatic backups."
                  : "Create a backup job to automatically back up your app data on a schedule."}
              </p>
            </div>
            {targets.length > 0 && (
              <Button
                size="sm"
                onClick={() => {
                  resetJobForm();
                  if (targets.length > 0) {
                    setNewJobTargetId(targets[0].id);
                  }
                  setJobSheetOpen(true);
                }}
              >
                <Plus className="mr-1.5 size-4" />
                New Job
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => {
              const lastBackup = job.backups[0];
              const isRunning = runningJobs.has(job.id);

              return (
                <div
                  key={job.id}
                  className="squircle rounded-lg border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{job.name}</p>
                        {job.enabled ? (
                          <Badge
                            variant="outline"
                            className="text-xs border-transparent bg-status-success-muted text-status-success"
                          >
                            <Power className="mr-1 size-3" />
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            <PowerOff className="mr-1 size-3" />
                            Paused
                          </Badge>
                        )}
                        {lastBackup && (
                          <StatusBadge status={lastBackup.status} />
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {scheduleLabel(job.schedule)}
                        </span>
                        <span>
                          Target: {job.target.name}
                        </span>
                        {job.keepLast && (
                          <span>Keep last {job.keepLast}</span>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-1">
                        {job.backupJobApps.map(({ app }) => (
                          <Badge
                            key={app.id}
                            variant="secondary"
                            className="text-xs"
                          >
                            {app.displayName}
                          </Badge>
                        ))}
                      </div>

                      {lastBackup && (
                        <p className="text-xs text-muted-foreground">
                          Last run:{" "}
                          {new Date(lastBackup.startedAt).toLocaleString()}
                          {lastBackup.sizeBytes != null &&
                            lastBackup.sizeBytes > 0 &&
                            ` -- ${formatBytes(lastBackup.sizeBytes)}`}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runNow(job.id)}
                        disabled={isRunning}
                      >
                        {isRunning ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : (
                          <Play className="mr-1.5 size-3.5" />
                        )}
                        {isRunning ? "Running..." : "Run Now"}
                      </Button>
                      <Switch
                        checked={job.enabled}
                        onCheckedChange={(checked) =>
                          toggleEnabled(job.id, checked)
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteJob(job.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent History */}
      {recentHistory.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-medium">Recent Backups</h2>
            <p className="text-sm text-muted-foreground">
              History of recent backup executions.
            </p>
          </div>

          <div className="space-y-1">
            {recentHistory.map((entry) => {
              const isRestoring = restoringBackups.has(entry.id);

              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-4 rounded-md border bg-card px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusBadge status={entry.status} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {entry.app.displayName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {entry.job.name} --{" "}
                        {new Date(entry.startedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {entry.sizeBytes != null && entry.sizeBytes > 0
                        ? formatBytes(entry.sizeBytes)
                        : "--"}
                      {entry.finishedAt && (
                        <span className="ml-2">
                          {Math.round(
                            (new Date(entry.finishedAt).getTime() -
                              new Date(entry.startedAt).getTime()) /
                              1000
                          )}
                          s
                        </span>
                      )}
                    </span>
                    {entry.status === "success" && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          asChild
                        >
                          <a
                            href={`/api/v1/organizations/${orgId}/backups/history/${entry.id}/download`}
                            download
                          >
                            <Download className="size-3.5" />
                          </a>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => restoreBackup(entry.id)}
                          disabled={isRestoring}
                        >
                          {isRestoring ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Add Target Sheet */}
      <BottomSheet open={targetSheetOpen} onOpenChange={setTargetSheetOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add storage target</BottomSheetTitle>
            <BottomSheetDescription>
              Configure where backups will be stored. Supports S3-compatible
              storage, Backblaze B2, and SSH/SFTP targets.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="target-name">Name</Label>
                <Input
                  id="target-name"
                  placeholder="My backup storage"
                  value={newTargetName}
                  onChange={(e) => setNewTargetName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label>Target Type</Label>
                <Select
                  value={newTargetType}
                  onValueChange={(v) => setNewTargetType(v as TargetType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="s3">Amazon S3</SelectItem>
                    <SelectItem value="r2">Cloudflare R2</SelectItem>
                    <SelectItem value="b2">Backblaze B2</SelectItem>
                    <SelectItem value="ssh">SSH / SFTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* S3 / R2 / B2 config fields */}
              {(newTargetType === "s3" ||
                newTargetType === "r2" ||
                newTargetType === "b2") && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="target-bucket">Bucket</Label>
                    <Input
                      id="target-bucket"
                      placeholder="my-backups"
                      value={newBucket}
                      onChange={(e) => setNewBucket(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-region">Region</Label>
                    <Input
                      id="target-region"
                      placeholder={
                        newTargetType === "r2" ? "auto" : "us-east-1"
                      }
                      value={newRegion}
                      onChange={(e) => setNewRegion(e.target.value)}
                    />
                    {newTargetType === "r2" && (
                      <p className="text-xs text-muted-foreground">
                        Defaults to &quot;auto&quot; if left empty.
                      </p>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-endpoint">
                      Endpoint
                      {newTargetType === "s3" && (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          (optional)
                        </span>
                      )}
                    </Label>
                    <Input
                      id="target-endpoint"
                      placeholder={
                        newTargetType === "r2"
                          ? "https://{accountId}.r2.cloudflarestorage.com"
                          : newTargetType === "b2"
                            ? "https://s3.{region}.backblazeb2.com"
                            : "https://s3.amazonaws.com"
                      }
                      value={newEndpoint}
                      onChange={(e) => setNewEndpoint(e.target.value)}
                    />
                    {newTargetType === "r2" && (
                      <p className="text-xs text-muted-foreground">
                        Format: https://&#123;accountId&#125;.r2.cloudflarestorage.com
                      </p>
                    )}
                    {newTargetType === "b2" && (
                      <p className="text-xs text-muted-foreground">
                        Format: https://s3.&#123;region&#125;.backblazeb2.com
                      </p>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-access-key">Access Key ID</Label>
                    <Input
                      id="target-access-key"
                      placeholder="AKIA..."
                      value={newAccessKeyId}
                      onChange={(e) => setNewAccessKeyId(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-secret-key">Secret Access Key</Label>
                    <Input
                      id="target-secret-key"
                      type="password"
                      value={newSecretAccessKey}
                      onChange={(e) => setNewSecretAccessKey(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-prefix">
                      Prefix
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="target-prefix"
                      placeholder="backups/"
                      className="font-mono"
                      value={newPrefix}
                      onChange={(e) => setNewPrefix(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional key prefix for all backup objects in the bucket.
                    </p>
                  </div>
                </>
              )}

              {/* SSH config fields */}
              {newTargetType === "ssh" && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="target-ssh-host">Host</Label>
                    <Input
                      id="target-ssh-host"
                      placeholder="backups.example.com"
                      value={newSshHost}
                      onChange={(e) => setNewSshHost(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-ssh-port">
                      Port
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        (optional, default 22)
                      </span>
                    </Label>
                    <Input
                      id="target-ssh-port"
                      type="number"
                      placeholder="22"
                      value={newSshPort}
                      onChange={(e) => setNewSshPort(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-ssh-username">Username</Label>
                    <Input
                      id="target-ssh-username"
                      placeholder="backup"
                      value={newSshUsername}
                      onChange={(e) => setNewSshUsername(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-ssh-key">
                      Private Key
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        (optional)
                      </span>
                    </Label>
                    <Textarea
                      id="target-ssh-key"
                      placeholder="Paste PEM private key (optional -- uses system SSH key if empty)"
                      className="font-mono text-xs min-h-[120px]"
                      value={newSshPrivateKey}
                      onChange={(e) => setNewSshPrivateKey(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="target-ssh-path">Remote Path</Label>
                    <Input
                      id="target-ssh-path"
                      placeholder="/var/backups"
                      className="font-mono"
                      value={newSshPath}
                      onChange={(e) => setNewSshPath(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setTargetSheetOpen(false)}
              disabled={savingTarget}
            >
              Cancel
            </Button>
            <Button
              onClick={createTarget}
              disabled={savingTarget || !isTargetFormValid()}
            >
              {savingTarget ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Target"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Create Job Sheet */}
      <BottomSheet open={jobSheetOpen} onOpenChange={setJobSheetOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Create backup job</BottomSheetTitle>
            <BottomSheetDescription>
              Configure a backup job to protect your app data. Select which
              apps to include and set a schedule.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="job-name">Job Name</Label>
                <Input
                  id="job-name"
                  placeholder="Nightly backup"
                  value={newJobName}
                  onChange={(e) => setNewJobName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label>Storage Target</Label>
                <Select
                  value={newJobTargetId}
                  onValueChange={setNewJobTargetId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select target" />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>Schedule</Label>
                <Select
                  value={newJobSchedule}
                  onValueChange={setNewJobSchedule}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="keep-last">Retention (keep last N)</Label>
                <Input
                  id="keep-last"
                  type="number"
                  min="1"
                  max="365"
                  value={newJobKeepLast}
                  onChange={(e) => setNewJobKeepLast(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Number of recent backups to keep. Older backups will be
                  pruned.
                </p>
              </div>

              <div className="grid gap-2">
                <Label>Projects to Back Up</Label>
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-2">
                  {apps.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 text-center">
                      No apps available
                    </p>
                  ) : (
                    apps.map((app) => (
                      <label
                        key={app.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={newJobAppIds.includes(app.id)}
                          onChange={() => toggleApp(app.id)}
                          className="rounded border-input"
                        />
                        <span className="text-sm">{app.displayName}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {app.name}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {newJobAppIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {newJobAppIds.length} app
                    {newJobAppIds.length !== 1 ? "s" : ""} selected
                  </p>
                )}
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setJobSheetOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={createJob}
              disabled={
                saving ||
                !newJobName.trim() ||
                !newJobTargetId ||
                newJobAppIds.length === 0
              }
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Job"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}
