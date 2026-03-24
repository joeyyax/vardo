"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Loader2, Power, PowerOff, Clock, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { scheduleLabel } from "./constants";
import { StatusBadge } from "./status-badge";
import { RetentionSummary } from "./retention-summary";
import { NextRun } from "./next-run";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import type { BackupJob } from "./types";

export function JobCard({
  job,
  orgId,
  readOnly = false,
  onRefresh,
}: {
  job: BackupJob;
  orgId: string;
  readOnly?: boolean;
  onRefresh: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const lastBackup = job.backups[0];

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}/run`, {
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
      setRunning(false);
    }
  }

  async function toggleEnabled() {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      if (res.ok) {
        toast.success(job.enabled ? "Job paused" : "Job enabled");
        onRefresh();
      }
    } catch {
      toast.error("Failed to update job");
    }
  }

  async function deleteJob() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/jobs/${job.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Job deleted");
        setDeleteOpen(false);
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
      <div className="squircle rounded-lg border bg-card p-4 space-y-2">
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
                disabled={running}
                onClick={runNow}
              >
                {running ? (
                  <Loader2 className="size-3 animate-spin mr-1" aria-hidden="true" />
                ) : (
                  <Play className="size-3 mr-1" aria-hidden="true" />
                )}
                Run now
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={toggleEnabled}
                aria-label={job.enabled ? "Pause job" : "Enable job"}
              >
                {job.enabled ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
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
          <span>Target: {job.target.name}</span>
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

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete backup job"
        description="This will stop scheduled backups. Existing backup files in storage won't be deleted."
        onConfirm={deleteJob}
        loading={deleting}
      />
    </>
  );
}
