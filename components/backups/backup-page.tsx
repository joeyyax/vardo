"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Check, Info, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { AutoBackupBanner } from "./auto-backup-banner";
import { TargetCard } from "./target-card";
import { JobSections } from "./job-sections";
import { TargetForm } from "./target-form";
import { JobForm } from "./job-form";
import { KeyEscrowCard } from "./key-escrow-card";
import { OrgBackupDefault, SystemBackupDefault } from "./backup-switch";
import { NotBackedUp } from "./not-backed-up";
import { useCan } from "@/components/capabilities-provider";
import { useAttention, useAttentionTarget } from "@/components/attention-provider";
import { ATTENTION_PANEL_ID } from "@/components/layout/attention-bar";
import { DETAIL_PANEL_GUTTER } from "@/components/detail-panel";
import { Stat, StatFilter, StatGroup } from "@/components/stat-filter";
import { formatBytes } from "@/lib/metrics/format";
import { sameTarget } from "@/lib/ui/attention";
import { cn } from "@/lib/utils";
import { useNotificationStream } from "@/hooks/use-notification-stream";
import { applyBackupEvent, type ProgressByJob } from "./progress-state";
import type { BusEvent } from "@/lib/bus/events";
import type { App, BackupTarget, BackupJob, RecentBackup } from "./types";

type StoredBytes = { total: number; byJob: Record<string, number> };

/** Attention rows the stats count. Each opens the shared panel on the backups group. */
const BACKUP_STATS = [
  { key: "backup-failed", label: "failed", tone: "text-status-error" },
  { key: "backup-overdue", label: "overdue", tone: "text-status-warning" },
  { key: "backup-uncovered", label: "not covered", tone: "text-status-warning" },
] as const;

type BackupPageData = {
  jobs?: { jobs?: BackupJob[]; recentHistory?: RecentBackup[]; storedBytes?: StoredBytes };
  targets?: { targets?: BackupTarget[]; allowLocalBackups?: boolean };
};

async function requestBackupData(orgId: string): Promise<BackupPageData> {
  const data: BackupPageData = {};
  try {
    const [jobsRes, targetsRes] = await Promise.all([
      fetch(`/api/v1/organizations/${orgId}/backups`),
      fetch(`/api/v1/organizations/${orgId}/backups/targets`),
    ]);
    if (jobsRes.ok) data.jobs = await jobsRes.json();
    if (targetsRes.ok) data.targets = await targetsRes.json();
  } catch {
    // silent
  }
  return data;
}

export function BackupPage({
  scope,
  orgId,
  apps,
  showIntro = true,
}: {
  scope: "admin" | "org";
  orgId: string;
  apps: App[];
  /** False where the page already carries the title and description. */
  showIntro?: boolean;
}) {
  const can = useCan();
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [history, setHistory] = useState<RecentBackup[]>([]);
  const [allowLocalBackups, setAllowLocalBackups] = useState(true);
  const [targetFormOpen, setTargetFormOpen] = useState(false);
  const [jobFormOpen, setJobFormOpen] = useState(false);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressByJob>({});
  const [storedBytes, setStoredBytes] = useState<StoredBytes>({ total: 0, byJob: {} });
  const [runOpen, setRunOpen] = useState(false);
  const [pressedStat, setPressedStat] = useState<string | null>(null);
  const attention = useAttention();
  const { target: attentionTarget, toggle: toggleAttention } = useAttentionTarget();

  const applyData = useCallback((data: BackupPageData) => {
    if (data.jobs) {
      setJobs(data.jobs.jobs || []);
      setHistory(data.jobs.recentHistory || []);
      if (data.jobs.storedBytes) setStoredBytes(data.jobs.storedBytes);
    }
    if (data.targets) {
      setTargets(data.targets.targets || []);
      if (data.targets.allowLocalBackups !== undefined) {
        setAllowLocalBackups(data.targets.allowLocalBackups);
      }
    }
    setLoading(false);
  }, []);

  const fetchData = useCallback(async () => {
    applyData(await requestBackupData(orgId));
  }, [orgId, applyData]);

  useEffect(() => {
    let cancelled = false;
    requestBackupData(orgId).then((data) => {
      if (!cancelled) applyData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, applyData]);

  // Shows runs started anywhere, cron or another tab.
  const onEvent = useCallback(
    (event: BusEvent & { historical?: boolean }) => {
      if (event.historical) return;

      setProgress((prev) => applyBackupEvent(prev, event));

      // Pick up the `running` row the engine wrote, then the finished run.
      if (event.type === "backup.progress" && event.index === 1) fetchData();
      if (event.type === "backup.success" || event.type === "backup.failed") fetchData();
    },
    [fetchData],
  );

  useNotificationStream({ orgId, onEvent });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const systemTargets = targets.filter((t) => t.isAppLevel);
  const userTargets = targets.filter((t) => !t.isAppLevel);

  // Org scope hides system targets and jobs; the auto-backup banner stands in.
  const visibleTargets = scope === "admin" ? targets : userTargets;
  const systemJobIds = new Set(
    jobs.filter((j) => systemTargets.some((t) => t.id === j.target.id)).map((j) => j.id)
  );
  const visibleJobs = scope === "admin" ? jobs : jobs.filter((j) => !systemJobIds.has(j.id));
  const hasVisibleTargets = visibleTargets.length > 0;

  const autoTarget = systemTargets[0];
  // Lets an empty card say whose backups it lacks.
  const managed = scope === "org" && !!autoTarget;
  const autoJobs = autoTarget ? jobs.filter((j) => j.target.id === autoTarget.id) : [];
  // Sections sit under the intro's h2 when it renders, under the page h1 when it doesn't.
  const Heading = !managed && showIntro ? "h3" : "h2";

  return (
    <div className={cn("grid grid-cols-1 gap-10", (runOpen || attentionTarget) && DETAIL_PANEL_GUTTER)}>
      {/* Auto-backup banner */}
      {scope === "org" && autoTarget ? (
        <AutoBackupBanner
          target={autoTarget}
          jobs={autoJobs}
          recent={history.filter((h) => autoJobs.some((j) => j.id === h.job?.id))}
          running={autoJobs.map((j) => progress[j.id]).filter((p) => p !== undefined)}
        />
      ) : showIntro ? (
        <div className="space-y-1">
          <h2 className="type-h2">{scope === "admin" ? "Organization backups" : "Backups"}</h2>
          <p className="text-sm text-muted-foreground">
            {scope === "admin"
              ? "Targets, jobs and history for the organization you're in. Vardo's own database is above."
              : "Configure backup targets and schedules for this organization."}
          </p>
        </div>
      ) : null}

      <StatGroup label="Backup numbers" active={!!attentionTarget}>
        {attention.loaded &&
          BACKUP_STATS.map(({ key, label, tone }) => {
            const items = attention.rows.find((r) => r.key === key)?.items ?? [];
            // Overdue rows list each app of a job; the stat counts jobs.
            const count = key === "backup-overdue" ? new Set(items.map((i) => i.id.split(":")[0])).size : items.length;
            if (count === 0) return <Stat key={key} value={0} label={label} />;
            const t = { group: "backups" };
            return (
              <StatFilter
                key={key}
                id={`backup-stat-${key}`}
                trigger={pressedStat === key || !pressedStat ? "backups" : undefined}
                value={count}
                label={label}
                tone={tone}
                pressed={sameTarget(attentionTarget, t) && pressedStat === key}
                controls={ATTENTION_PANEL_ID}
                onPress={() => {
                  setPressedStat(key);
                  toggleAttention(t);
                }}
              />
            );
          })}
        <Stat value={formatBytes(storedBytes.total)} label="stored" />
      </StatGroup>

      <section className="grid grid-cols-1 gap-3">
        <div className="flex items-center justify-between gap-3">
          <Heading className="type-h3">Backup jobs</Heading>
          {can("backup.jobs.manage") && (
            <Button size="sm" variant="outline" onClick={() => setJobFormOpen(true)} disabled={!hasVisibleTargets}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              New job
            </Button>
          )}
        </div>
        <JobSections
          jobs={visibleJobs}
          orphanRuns={history.filter((h) => !h.job)}
          orgId={orgId}
          progress={progress}
          storedBytes={storedBytes.byJob}
          readOnly={(job) => scope === "org" && job.target.type === "system"}
          showApps={scope !== "admin"}
          onRefresh={fetchData}
          onPanelChange={setRunOpen}
          empty={
            <Card variant="surface">
              {!hasVisibleTargets ? (
                <EmptyState
                  className="p-8"
                  title={managed ? "No jobs of your own" : "No backup jobs yet"}
                  body={
                    managed
                      ? "The automatic schedule above is managed for you. Add a storage target to run jobs of your own."
                      : "Jobs can be added after you add a storage target."
                  }
                />
              ) : (
                <EmptyState
                  className="p-8"
                  icon={Archive}
                  title="No backup jobs configured"
                  body="Create one to schedule automatic backups."
                  action={
                    can("backup.jobs.manage") && (
                      <Button size="sm" variant="outline" onClick={() => setJobFormOpen(true)}>
                        <Plus className="mr-1.5 size-4" aria-hidden="true" />
                        New job
                      </Button>
                    )
                  }
                />
              )}
            </Card>
          }
        />
      </section>

      {scope === "org" && can("backup.jobs.manage") && (
        <NotBackedUp orgId={orgId} targets={targets} heading={Heading} onChanged={fetchData} />
      )}

      {/* Storage targets */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle as={Heading}>Storage targets</CardTitle>
          {can("backup.targets.manage") && (
            <Button size="sm" variant="outline" onClick={() => setTargetFormOpen(true)}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              Add target
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!hasVisibleTargets ? (
            <EmptyState
              className="p-8"
              title={managed ? "No targets of your own" : "No storage targets"}
              body={
                managed
                  ? "Automatic backups run against a target Vardo manages. Add an S3 bucket, Cloudflare R2, Backblaze B2 or SSH server for a second copy."
                  : "Add an S3 bucket, Cloudflare R2, Backblaze B2 or SSH server to start backing up."
              }
            />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {visibleTargets.map((target) => (
                <TargetCard
                  key={target.id}
                  target={target}
                  orgId={orgId}
                  readOnly={!can("backup.targets.manage")}
                  onRefresh={fetchData}
                  onEdit={() => setEditingTargetId(target.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Key escrow */}
      {scope === "org" && <KeyEscrowCard heading={Heading} />}

      {scope === "admin" ? <SystemBackupDefault heading={Heading} /> : <OrgBackupDefault orgId={orgId} heading={Heading} />}

      {/* Info sections */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card variant="surface" className="@container">
          <div className="p-6 @lg:p-7 space-y-3">
            <Heading className="type-h3">What&apos;s in a backup</Heading>
            <ul className="text-sm space-y-2">
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Volumes set to back up, and databases as logical dumps</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Not container images. They&apos;re pulled from your registry on deploy</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Not ENCRYPTION_MASTER_KEY or BETTER_AUTH_SECRET. Escrow both, or a restore can&apos;t read env vars or two-factor secrets</span>
              </li>
            </ul>
          </div>
        </Card>
        <Card variant="surface" className="@container">
          <div className="p-6 @lg:p-7 space-y-3">
            <Heading className="type-h3">How it works</Heading>
            <ul className="text-sm space-y-2">
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Each archive is encrypted with its own key, wrapped by the master key</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Uploaded offsite to your storage target</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Retention keeps the last, daily, weekly and monthly archives</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Restore drills confirm an archive restores</span>
              </li>
            </ul>
          </div>
        </Card>
        <Card variant="surface" className="@container">
          <div className="p-6 @lg:p-7 space-y-3">
            <Heading className="type-h3">Good to know</Heading>
            <ul className="text-sm space-y-2">
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Runs live, with no downtime or container restarts</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">Restore any snapshot. A failed restore puts the previous data back</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
                <span className="text-muted-foreground">A new instance can restore Vardo and every app from storage during setup</span>
              </li>
            </ul>
          </div>
        </Card>
      </div>

      {/* Forms */}
      <TargetForm
        key={editingTargetId ?? "new"}
        open={targetFormOpen || !!editingTargetId}
        onOpenChange={(open) => {
          if (!open) {
            setTargetFormOpen(false);
            setEditingTargetId(null);
          }
        }}
        orgId={orgId}
        isFirstTarget={userTargets.length === 0}
        onCreated={() => {
          setEditingTargetId(null);
          fetchData();
        }}
        editTarget={editingTargetId ? targets.find((t) => t.id === editingTargetId) ?? null : null}
        allowLocalBackups={allowLocalBackups}
      />

      <JobForm
        open={jobFormOpen}
        onOpenChange={setJobFormOpen}
        orgId={orgId}
        targets={targets}
        apps={apps}
        defaultTargetId={targets[0]?.id}
        scope={scope}
        onCreated={() => {
          setJobFormOpen(false);
          fetchData();
        }}
      />
    </div>
  );
}
