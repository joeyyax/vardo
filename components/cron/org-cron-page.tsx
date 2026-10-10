"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { useCan } from "@/components/capabilities-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { RelativeTime } from "@/components/relative-time";
import { CronJobSheet, type CronJobBody } from "./cron-job-sheet";
import { CronRuns } from "./cron-runs";
import { CronCommand, cronAnchor, cronMark, scheduleWithZone, urlOptionsSummary, type CronJob } from "./cron-shared";
import { DetailPanel, DETAIL_PANEL_GUTTER, PanelSection } from "@/components/detail-panel";
import { ListRow } from "@/components/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { focusRowByKey, useRowKeys } from "@/hooks/use-row-keys";
import { EntityLink } from "@/components/entity-link";
import { useHashTarget } from "@/hooks/use-hash-target";
import { appHref } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Hit a URL on a schedule, for sites on or off Vardo.";

/** The last run as the row's signal: a failure is loud, the rest is quiet. */
function LastRun({ job }: { job: CronJob }) {
  const time = job.lastRunAt ? <RelativeTime date={job.lastRunAt} className="tabular-nums" /> : null;
  if (job.lastStatus === "running") return <span className="text-status-info">running now</span>;
  if (job.lastStatus === "failed")
    return <span className="text-status-error">failed {time}</span>;
  if (!job.enabled) return <span className="text-muted-foreground/70">paused</span>;
  if (!time) return <span className="text-muted-foreground/70">never run</span>;
  return <span className="text-muted-foreground/70">ran {time}</span>;
}

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
  const linked = useHashTarget(jobs !== null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const onRowKeys = useRowKeys(listRef);
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedId = params.get("job");

  const setSelected = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(params.toString());
      if (id) sp.set("job", id);
      else sp.delete("job");
      const qs = sp.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [params, pathname],
  );

  const jobHref = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("job", id);
    return `${pathname}?${sp.toString()}`;
  };

  const close = useCallback(() => {
    const from = selectedId;
    setSelected(null);
    if (from) requestAnimationFrame(() => focusRowByKey(listRef.current, from));
  }, [selectedId, setSelected]);

  // A #cron-<id> link opens that job's panel too.
  useEffect(() => {
    if (!linked?.startsWith("cron-") || selectedId) return;
    setSelected(linked.slice("cron-".length));
  }, [linked, selectedId, setSelected]);

  useEffect(() => {
    if (!selectedId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]')) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, close]);

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
        setSelected(job.id);
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
  const selected = selectedId ? jobs.find((j) => j.id === selectedId) ?? null : null;

  function row(job: CronJob) {
    const mark = cronMark(job);
    const mayRun = canManage && (job.type === "url" || canCommand);
    const appName = job.app ? job.app.displayName || job.app.name : null;
    return (
      <div key={job.id} id={cronAnchor(job.id)} role="none" className="scroll-mt-28">
        <ListRow
          navKey={job.id}
          mark={mark}
          name={job.name}
          href={job.app ? `${appHref(job.app.name, "cron")}#${cronAnchor(job.id)}` : jobHref(job.id)}
          linkOpens={!job.app}
          signal={[appName, scheduleWithZone(job)].filter(Boolean).join(" · ")}
          status={<LastRun job={job} />}
          action={
            mayRun ? (
              <Button
                size="sm"
                variant="outline"
                tabIndex={-1}
                className="h-7 gap-1.5 px-2.5 text-xs"
                aria-label={`Run ${job.name} now`}
                onClick={() => runNow(job)}
                disabled={runningId === job.id || job.lastStatus === "running"}
              >
                {runningId === job.id ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                Run now
              </Button>
            ) : undefined
          }
          selected={selectedId === job.id}
          dim={!job.enabled}
          flash={linked === cronAnchor(job.id)}
          onOpen={() => setSelected(selectedId === job.id ? null : job.id)}
        />
      </div>
    );
  }

  return (
    <>
      <div ref={listRef} onKeyDown={onRowKeys} className={cn("grid grid-cols-1 gap-8", selected && DETAIL_PANEL_GUTTER)}>
        <section className="grid grid-cols-1 gap-3">
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
            <Card variant="surface" className="p-1.5">
              <div role="tree" aria-label="Organization jobs">
                {orgJobs.map(row)}
              </div>
            </Card>
          )}
        </section>

        <section className="grid grid-cols-1 gap-3">
          <div>
            <h2 className="type-h3">App jobs</h2>
            <p className="text-sm text-muted-foreground">Edit these on each app&apos;s Cron tab.</p>
          </div>
          {appJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No app has a cron job.</p>
          ) : (
            <Card variant="surface" className="p-1.5">
              <div role="tree" aria-label="App jobs">
                {appJobs.map(row)}
              </div>
            </Card>
          )}
        </section>
      </div>

      <DetailPanel
        open={!!selected}
        onClose={close}
        label={selected ? `Cron job ${selected.name}` : "Cron job"}
        eyebrow={
          selected ? (
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
              <StatusDot tone={cronMark(selected).tone} pending={cronMark(selected).pending} className="text-[12.5px]">
                {cronMark(selected).label}
              </StatusDot>
              {selected.app && (
                <>
                  <span aria-hidden="true">·</span>
                  <EntityLink href={appHref(selected.app.name)} className="hover:text-foreground">
                    {selected.app.displayName || selected.app.name}
                  </EntityLink>
                </>
              )}
            </div>
          ) : undefined
        }
        title={selected?.name ?? ""}
      >
        {selected && (
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {canManage && (selected.type === "url" || canCommand) && (
                <Button size="sm" onClick={() => runNow(selected)} disabled={runningId === selected.id || selected.lastStatus === "running"}>
                  {runningId === selected.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  Run now
                </Button>
              )}
              {!selected.appId && canManage && (
                <>
                  <Button size="sm" variant="outline" onClick={() => openSheet(selected)}>
                    Edit
                  </Button>
                  <label className="ml-1 flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Switch
                      aria-label={selected.enabled ? "Pause job" : "Enable job"}
                      checked={selected.enabled}
                      onCheckedChange={(checked) => toggleEnabled(selected, checked)}
                    />
                    {selected.enabled ? "Enabled" : "Paused"}
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete job"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(selected.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
              {selected.app && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`${appHref(selected.app.name, "cron")}#${cronAnchor(selected.id)}`}>Edit on the app</Link>
                </Button>
              )}
            </div>
            <PanelSection title="Details">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-muted-foreground">Schedule</dt>
                <dd>{scheduleWithZone(selected)}</dd>
                <dt className="text-muted-foreground">{selected.type === "url" ? "URL" : "Command"}</dt>
                <dd className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
                  <CronCommand job={selected} />
                </dd>
                {selected.type === "url" && urlOptionsSummary(selected) && (
                  <>
                    <dt className="text-muted-foreground">Options</dt>
                    <dd>{urlOptionsSummary(selected)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Last run</dt>
                <dd>{selected.lastRunAt ? <RelativeTime date={selected.lastRunAt} absoluteFirst /> : "Never"}</dd>
              </dl>
            </PanelSection>
            <PanelSection title="Recent runs">
              <CronRuns orgId={orgId} jobId={selected.id} refreshKey={runsKey} />
            </PanelSection>
          </div>
        )}
      </DetailPanel>

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
