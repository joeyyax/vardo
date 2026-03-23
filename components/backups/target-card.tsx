"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Loader2, Power, PowerOff, Clock, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { TargetIcon, scheduleLabel, targetSubtitle } from "./constants";
import { StatusBadge } from "./status-badge";
import { RetentionSummary } from "./retention-summary";
import { NextRun } from "./next-run";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import type { TargetWithJobs } from "./types";

export function TargetCard({
  target,
  orgId,
  readOnly = false,
  onRefresh,
}: {
  target: TargetWithJobs;
  orgId: string;
  readOnly?: boolean;
  onRefresh: () => void;
}) {
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function runNow(jobId: string) {
    setRunningJobs((prev) => new Set([...prev, jobId]));
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${jobId}/run`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success("Backup started");
        onRefresh();
      } else {
        toast.error("Failed to start backup");
      }
    } catch {
      toast.error("Failed to start backup");
    } finally {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }

  async function toggleJob(jobId: string, enabled: boolean) {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        toast.success(enabled ? "Job enabled" : "Job paused");
        onRefresh();
      }
    } catch {
      toast.error("Failed to update job");
    }
  }

  async function deleteJob() {
    if (!deleteJobId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${deleteJobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Job deleted");
        setDeleteJobId(null);
        onRefresh();
      } else {
        toast.error("Failed to delete job");
      }
    } catch {
      toast.error("Failed to delete job");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="squircle rounded-lg border bg-card">
        {/* Target header */}
        <div className="flex items-center justify-between gap-4 p-4 border-b">
          <div className="flex items-center gap-3 min-w-0">
            <TargetIcon type={target.type} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{target.name}</p>
                <Badge variant="secondary" className="text-xs">{target.type}</Badge>
                {target.isDefault && (
                  <Badge variant="outline" className="text-xs">default</Badge>
                )}
                {target.isAppLevel && (
                  <Badge variant="outline" className="text-xs">System</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                {targetSubtitle(target)}
              </p>
            </div>
          </div>
        </div>

        {/* Inline jobs */}
        {target.jobs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No backup jobs configured for this target.
          </div>
        ) : (
          <div className="divide-y">
            {target.jobs.map((job) => {
              const lastBackup = job.backups[0];
              const isRunning = runningJobs.has(job.id);

              return (
                <div key={job.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm font-medium">{job.name}</p>
                      {job.enabled ? (
                        <Badge
                          variant="outline"
                          className="text-xs border-transparent bg-status-success-muted text-status-success"
                        >
                          <Power className="mr-1 size-3" aria-hidden="true" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          <PowerOff className="mr-1 size-3" aria-hidden="true" />
                          Paused
                        </Badge>
                      )}
                      {lastBackup && <StatusBadge status={lastBackup.status} />}
                    </div>

                    {!readOnly && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          disabled={isRunning}
                          onClick={() => runNow(job.id)}
                        >
                          {isRunning ? (
                            <Loader2 className="size-3 animate-spin mr-1" aria-hidden="true" />
                          ) : (
                            <Play className="size-3 mr-1" aria-hidden="true" />
                          )}
                          Run now
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => toggleJob(job.id, !job.enabled)}
                          aria-label={job.enabled ? "Pause job" : "Enable job"}
                        >
                          {job.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => setDeleteJobId(job.id)}
                          aria-label="Delete job"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" aria-hidden="true" />
                      {scheduleLabel(job.schedule)}
                    </span>
                    <NextRun schedule={job.schedule} />
                    <RetentionSummary job={job} />
                  </div>

                  {job.backupJobApps.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {job.backupJobApps.map((bja) => (
                        <Badge key={bja.app.id} variant="secondary" className="text-xs">
                          {bja.app.displayName}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDeleteDialog
        open={!!deleteJobId}
        onOpenChange={(open) => !open && setDeleteJobId(null)}
        title="Delete backup job"
        description="This will stop scheduled backups. Existing backup files in storage won't be deleted."
        onConfirm={deleteJob}
        loading={deleting}
      />
    </>
  );
}
