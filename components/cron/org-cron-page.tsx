"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { useCan } from "@/components/capabilities-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { RelativeTime } from "@/components/relative-time";
import { CronJobSheet, type CronJobBody } from "./cron-job-sheet";
import { CronRuns } from "./cron-runs";
import { CronStatusIcon, scheduleWithZone, urlOptionsSummary, type CronJob } from "./cron-shared";

const DESCRIPTION = "Hit a URL on a schedule, for sites on or off Vardo.";

async function requestJobs(url: string): Promise<CronJob[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()).cronJobs ?? [];
  } catch {
    return null;
  }
}

/** Every cron job in the org: org-level URL jobs to manage here, app jobs to run and inspect. */
export function OrgCronPage({ orgId }: { orgId: string }) {
  const can = useCan();
  const canManage = can("app.cron");
  const canCommand = can("app.cron.command");
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runsOpen, setRunsOpen] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);

  const baseUrl = `/api/v1/organizations/${orgId}/cron`;

  const reload = useCallback(async () => {
    const list = await requestJobs(baseUrl);
    if (list) setJobs(list);
    else setJobs((current) => current ?? []);
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    requestJobs(baseUrl).then((list) => {
      if (!cancelled) setJobs(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  function openSheet(job: CronJob | null) {
    setEditing(job);
    setSheetKey((k) => k + 1);
    setSheetOpen(true);
  }

  async function handleSave(body: CronJobBody): Promise<boolean> {
    try {
      const res = await fetch(editing ? `${baseUrl}/${editing.id}` : baseUrl, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(editing ? "Cron job updated" : "Cron job created");
        reload();
        return true;
      }
      const err = await res.json().catch(() => ({}));
      toast.error("Couldn't save cron job", { description: err.error || "Check the schedule and URL" });
    } catch {
      toast.error("Couldn't save cron job", { description: "Check your connection and try again" });
    }
    return false;
  }

  async function toggleEnabled(job: CronJob, enabled: boolean) {
    try {
      const res = await fetch(`${baseUrl}/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        toast.success(enabled ? "Cron job enabled" : "Cron job paused");
        reload();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error("Couldn't update cron job", { description: err.error });
      }
    } catch {
      toast.error("Couldn't update cron job", { description: "Check your connection and try again" });
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`${baseUrl}/${deleteId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Cron job deleted");
        setDeleteId(null);
        reload();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error("Couldn't delete cron job", { description: err.error });
      }
    } catch {
      toast.error("Couldn't delete cron job", { description: "Check your connection and try again" });
    } finally {
      setDeleting(false);
    }
  }

  async function runNow(job: CronJob) {
    setRunningId(job.id);
    try {
      const res = await fetch(`${baseUrl}/${job.id}/run`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const description = `${job.name} finished in ${data.run?.durationMs ?? 0}ms`;
        if (data.run?.status === "success") toast.success("Run succeeded", { description });
        else toast.error("Run failed", { description });
        setRunsOpen(job.id);
        setRunsKey((k) => k + 1);
      } else {
        toast.error("Couldn't run cron job", { description: data.error });
      }
      reload();
    } catch {
      toast.error("Couldn't run cron job", { description: "Check your connection and try again" });
    } finally {
      setRunningId(null);
    }
  }

  if (!jobs) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading cron jobs" />
      </div>
    );
  }

  const orgJobs = jobs.filter((j) => !j.appId);
  const appJobs = jobs.filter((j) => j.appId);

  function jobCard(job: CronJob) {
    const orgLevel = !job.appId;
    const options = job.type === "url" ? urlOptionsSummary(job) : "";
    const appName = job.app ? job.app.displayName || job.app.name : null;
    const mayRun = canManage && (job.type === "url" || canCommand);
    return (
      <Card variant="inset" key={job.id} className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <CronStatusIcon status={job.lastStatus} />
              <p className="text-sm font-medium">{job.name}</p>
              <Badge variant={job.enabled ? "success" : "neutral"} className="text-xs">
                {job.enabled ? "Active" : "Paused"}
              </Badge>
              {appName && job.app && (
                <Link href={`/apps/${job.app.name}/cron`} className="text-xs text-muted-foreground hover:text-foreground">
                  {appName}
                </Link>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="size-3" aria-hidden="true" />
                {scheduleWithZone(job)}
              </span>
              {job.lastRunAt && (
                <span>
                  Last run: <RelativeTime date={job.lastRunAt} />
                </span>
              )}
              {options && <span>{options}</span>}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              <Badge variant="outline" className="mr-1.5 font-sans">
                {job.type === "url" ? "URL" : "CMD"}
              </Badge>
              {job.command}
            </p>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={runsOpen === job.id}
              onClick={() => setRunsOpen(runsOpen === job.id ? null : job.id)}
            >
              {runsOpen === job.id ? "Hide recent runs" : "Recent runs"}
            </button>
            {runsOpen === job.id && <CronRuns orgId={orgId} jobId={job.id} refreshKey={runsKey} />}
          </div>
          {(mayRun || (orgLevel && canManage)) && (
            <div className="flex shrink-0 items-center gap-2">
              {mayRun && (
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
              {orgLevel && canManage && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => openSheet(job)}>
                    Edit
                  </Button>
                  <Switch
                    aria-label={job.enabled ? "Pause job" : "Enable job"}
                    checked={job.enabled}
                    onCheckedChange={(checked) => toggleEnabled(job, checked)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete job"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(job.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-8">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="type-h3">Organization jobs</h2>
              <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
            </div>
            {canManage && orgJobs.length > 0 && (
              <Button size="sm" onClick={() => openSheet(null)}>
                <Plus className="mr-1.5 size-4" />
                Add job
              </Button>
            )}
          </div>
          {orgJobs.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No organization jobs"
              body="Add a URL job to call something like wp-cron.php on a schedule, without an app on Vardo."
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
            <div className="space-y-2">{orgJobs.map(jobCard)}</div>
          )}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="type-h3">App jobs</h2>
            <p className="text-sm text-muted-foreground">Edit these on each app&apos;s Cron tab.</p>
          </div>
          {appJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No app has a cron job.</p>
          ) : (
            <div className="space-y-2">{appJobs.map(jobCard)}</div>
          )}
        </section>
      </div>

      <CronJobSheet
        key={sheetKey}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        job={editing}
        allowCommand={false}
        canCommand={false}
        description={DESCRIPTION}
        onSave={handleSave}
      />

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete cron job"
        description="This will permanently remove this cron job and its run history."
      />
    </>
  );
}
