"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Plus,
  Trash2,
  Clock,
  Play,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { can } from "@/lib/auth/permissions";
import { RelativeTime } from "@/components/relative-time";
import { Card } from "@/components/ui/card";
import { CronJobSheet, type CronJobBody } from "@/components/cron/cron-job-sheet";
import {
  CronStatusIcon,
  scheduleLabel,
  urlOptionsSummary,
  type CronJob,
} from "@/components/cron/cron-shared";

type Props = {
  appId: string;
  orgId: string;
  userRole: string;
};

async function requestJobs(url: string): Promise<CronJob[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.cronJobs || [];
  } catch {
    return null;
  }
}

export function CronManager({ appId, orgId, userRole }: Props) {
  const canManage = can(userRole, "app.cron");
  const canCommand = can(userRole, "app.cron.command");
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const baseUrl = `/api/v1/organizations/${orgId}/apps/${appId}/cron`;

  const applyJobs = useCallback((list: CronJob[] | null) => {
    if (list) setJobs(list);
    setLoading(false);
  }, []);

  const fetchJobs = useCallback(async () => {
    applyJobs(await requestJobs(baseUrl));
  }, [baseUrl, applyJobs]);

  useEffect(() => {
    let cancelled = false;
    requestJobs(baseUrl).then((list) => {
      if (!cancelled) applyJobs(list);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, applyJobs]);

  function openSheet(job: CronJob | null) {
    setEditing(job);
    setSheetKey((k) => k + 1);
    setSheetOpen(true);
  }

  async function handleSave(body: CronJobBody): Promise<boolean> {
    try {
      const res = await fetch(baseUrl, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...body } : body),
      });

      if (res.ok) {
        toast.success(editing ? "Cron job updated" : "Cron job created");
        fetchJobs();
        return true;
      }
      const err = await res.json().catch(() => ({}));
      toast.error("Couldn't save cron job", {
        description: err.error || "Check the schedule expression",
      });
    } catch {
      toast.error("Couldn't save cron job", {
        description: "Check your connection and try again",
      });
    }
    return false;
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(baseUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteId }),
      });
      if (res.ok) {
        toast.success("Cron job deleted");
        setDeleteId(null);
        fetchJobs();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error("Couldn't delete cron job", {
          description: err.error,
        });
      }
    } catch {
      toast.error("Couldn't delete cron job", {
        description: "Check your connection and try again",
      });
    } finally {
      setDeleting(false);
    }
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      const res = await fetch(baseUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      if (res.ok) {
        toast.success(enabled ? "Cron job enabled" : "Cron job paused");
        fetchJobs();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error("Couldn't update cron job", {
          description: err.error,
        });
      }
    } catch {
      toast.error("Couldn't update cron job", {
        description: "Check your connection and try again",
      });
    }
  }

  async function runNow(job: CronJob) {
    setRunningId(job.id);
    try {
      const res = await fetch(`${baseUrl}/${job.id}/run`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const ok = data.run?.status === "success";
        const description = `${job.name} finished in ${data.run?.durationMs ?? 0}ms`;
        if (ok) toast.success("Run succeeded", { description });
        else toast.error("Run failed", { description });
        setExpandedLog(job.id);
      } else {
        toast.error("Couldn't run cron job", { description: data.error });
      }
      fetchJobs();
    } catch {
      toast.error("Couldn't run cron job", {
        description: "Check your connection and try again",
      });
    } finally {
      setRunningId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Run commands or hit URLs on a recurring schedule.
            </p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => openSheet(null)}>
              <Plus className="mr-1.5 size-4" />
              Add job
            </Button>
          )}
        </div>

        {jobs.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No scheduled jobs"
            body="Add a cron job to run commands or hit URLs on a recurring schedule."
            action={
              canManage ? (
                <Button size="sm" onClick={() => openSheet(null)}>
                  <Plus className="mr-1.5 size-4" />
                  Add job
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => {
              const options = job.type === "url" ? urlOptionsSummary(job) : "";
              return (
                <Card
                  variant="inset"
                  key={job.id}
                  className="p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <CronStatusIcon status={job.lastStatus} />
                        <p className="text-sm font-medium">{job.name}</p>
                        {job.enabled ? (
                          <Badge variant="success" className="text-xs">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="neutral" className="text-xs">
                            Paused
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {scheduleLabel(job.schedule)}
                        </span>
                        {job.lastRunAt && (
                          <span>
                            Last run: <RelativeTime date={job.lastRunAt} />
                          </span>
                        )}
                        {options && <span>{options}</span>}
                      </div>
                      <p className="text-xs font-mono text-muted-foreground truncate">
                        <Badge variant="outline" className="mr-1.5 font-sans">
                          {job.type === "url" ? "URL" : "CMD"}
                        </Badge>
                        {job.command}
                      </p>
                      {job.lastLog && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedLog(
                              expandedLog === job.id ? null : job.id
                            )
                          }
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          {expandedLog === job.id ? "Hide output" : "Show output"}
                        </button>
                      )}
                      {expandedLog === job.id && job.lastLog && (
                        <pre className="mt-2 rounded-md bg-zinc-950 p-3 text-xs text-zinc-300 overflow-x-auto max-h-48 overflow-y-auto">
                          {job.lastLog}
                        </pre>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        {(job.type === "url" || canCommand) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => runNow(job)}
                            disabled={runningId === job.id || job.lastStatus === "running"}
                          >
                            {runningId === job.id ? (
                              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            ) : (
                              <Play className="mr-1.5 size-3.5" />
                            )}
                            Run now
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openSheet(job)}
                        >
                          Edit
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
                          onClick={() => setDeleteId(job.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <CronJobSheet
        key={sheetKey}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        job={editing}
        allowCommand
        canCommand={canCommand}
        description="Run commands or hit URLs on a recurring schedule."
        onSave={handleSave}
      />

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete cron job"
        description="This will permanently remove this cron job."
      />
    </>
  );
}
