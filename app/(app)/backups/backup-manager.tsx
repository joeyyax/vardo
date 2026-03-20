"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Plus,
  Play,
  Archive,
  FolderOpen,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Trash2,
  Power,
  PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

type Project = {
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
  backupJobProjects: {
    project: Project;
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
  project: Project;
};

type Props = {
  orgId: string;
  projects: Project[];
};

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

export function BackupManager({ orgId, projects }: Props) {
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [recentHistory, setRecentHistory] = useState<RecentBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());

  // New job form
  const [jobSheetOpen, setJobSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newJobName, setNewJobName] = useState("");
  const [newJobTargetId, setNewJobTargetId] = useState("");
  const [newJobSchedule, setNewJobSchedule] = useState("0 2 * * *");
  const [newJobProjectIds, setNewJobProjectIds] = useState<string[]>([]);
  const [newJobKeepLast, setNewJobKeepLast] = useState("7");

  // New target form
  const [targetSheetOpen, setTargetSheetOpen] = useState(false);
  const [savingTarget, setSavingTarget] = useState(false);
  const [newTargetName, setNewTargetName] = useState("");
  const [newTargetPath, setNewTargetPath] = useState("./.host/backups");

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

  // -- Create target --
  async function createTarget() {
    if (!newTargetName.trim() || !newTargetPath.trim()) return;

    setSavingTarget(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/targets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newTargetName.trim(),
            type: "local",
            config: { path: newTargetPath.trim() },
            isDefault: targets.length === 0,
          }),
        }
      );

      if (res.ok) {
        toast.success("Backup target created");
        setTargetSheetOpen(false);
        setNewTargetName("");
        setNewTargetPath("./.host/backups");
        fetchData();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to create target");
      }
    } catch {
      toast.error("Failed to create target");
    } finally {
      setSavingTarget(false);
    }
  }

  // -- Create job --
  async function createJob() {
    if (
      !newJobName.trim() ||
      !newJobTargetId ||
      newJobProjectIds.length === 0
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
          projectIds: newJobProjectIds,
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
        toast.error(err.error || "Failed to create job");
      }
    } catch {
      toast.error("Failed to create job");
    } finally {
      setSaving(false);
    }
  }

  function resetJobForm() {
    setNewJobName("");
    setNewJobTargetId("");
    setNewJobSchedule("0 2 * * *");
    setNewJobProjectIds([]);
    setNewJobKeepLast("7");
  }

  // -- Run backup --
  async function runNow(jobId: string) {
    setRunningJobs((prev) => new Set(prev).add(jobId));

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/${jobId}/run`,
        { method: "POST" }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          toast.success("Backup completed successfully");
        } else {
          toast.error("Backup completed with errors");
        }
        fetchData();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to run backup");
      }
    } catch {
      toast.error("Failed to run backup");
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
        `/api/v1/organizations/${orgId}/backups/${jobId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );

      if (res.ok) {
        toast.success(enabled ? "Backup job enabled" : "Backup job paused");
        fetchData();
      }
    } catch {
      toast.error("Failed to update job");
    }
  }

  // -- Delete job --
  async function deleteJob(jobId: string) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/backups/${jobId}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        toast.success("Backup job deleted");
        fetchData();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to delete job");
      }
    } catch {
      toast.error("Failed to delete job");
    }
  }

  // -- Toggle project selection --
  function toggleProject(projectId: string) {
    setNewJobProjectIds((prev) =>
      prev.includes(projectId)
        ? prev.filter((id) => id !== projectId)
        : [...prev, projectId]
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Backup Targets */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Storage Targets</h2>
            <p className="text-sm text-muted-foreground">
              Where your backups are stored.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setNewTargetName("");
              setNewTargetPath("./.host/backups");
              setTargetSheetOpen(true);
            }}
          >
            <Plus className="mr-1.5 size-4" />
            Add Target
          </Button>
        </div>

        {targets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
            <FolderOpen className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No storage targets configured. Add a target to start creating
              backup jobs.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setNewTargetName("Local Storage");
                setNewTargetPath("./.host/backups");
                setTargetSheetOpen(true);
              }}
            >
              <Plus className="mr-1.5 size-4" />
              Add Local Target
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
                  <FolderOpen className="size-4 text-muted-foreground shrink-0" />
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
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                      {target.type === "local"
                        ? (target.config as { path: string }).path
                        : target.type}
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
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
            <Archive className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {targets.length === 0
                ? "Add a storage target first, then create backup jobs."
                : "No backup jobs configured. Create one to start protecting your data."}
            </p>
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
                        {job.backupJobProjects.map(({ project }) => (
                          <Badge
                            key={project.id}
                            variant="secondary"
                            className="text-xs"
                          >
                            {project.displayName}
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
            {recentHistory.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 rounded-md border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <StatusBadge status={entry.status} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {entry.project.displayName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entry.job.name} --{" "}
                      {new Date(entry.startedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
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
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Add Target Sheet */}
      <BottomSheet open={targetSheetOpen} onOpenChange={setTargetSheetOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add storage target</BottomSheetTitle>
            <BottomSheetDescription>
              Configure where backups will be stored. Currently supports local
              filesystem storage.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="target-name">Name</Label>
                <Input
                  id="target-name"
                  placeholder="Local Storage"
                  value={newTargetName}
                  onChange={(e) => setNewTargetName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="target-path">Storage Path</Label>
                <Input
                  id="target-path"
                  placeholder="./.host/backups"
                  className="font-mono"
                  value={newTargetPath}
                  onChange={(e) => setNewTargetPath(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Absolute or relative path on the host filesystem where backup
                  archives will be stored.
                </p>
              </div>
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
              disabled={
                savingTarget ||
                !newTargetName.trim() ||
                !newTargetPath.trim()
              }
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
              Configure a backup job to protect your project data. Select which
              projects to include and set a schedule.
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
                  {projects.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 text-center">
                      No projects available
                    </p>
                  ) : (
                    projects.map((project) => (
                      <label
                        key={project.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={newJobProjectIds.includes(project.id)}
                          onChange={() => toggleProject(project.id)}
                          className="rounded border-input"
                        />
                        <span className="text-sm">{project.displayName}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {project.name}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {newJobProjectIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {newJobProjectIds.length} project
                    {newJobProjectIds.length !== 1 ? "s" : ""} selected
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
                newJobProjectIds.length === 0
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
