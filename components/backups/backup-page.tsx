"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutoBackupBanner } from "./auto-backup-banner";
import { TargetCard } from "./target-card";
import { TargetForm } from "./target-form";
import { JobForm } from "./job-form";
import { BackupHistory } from "./backup-history";
import type { App, BackupTarget, BackupJob, RecentBackup, TargetWithJobs } from "./types";

export function BackupPage({
  scope,
  orgId,
  apps,
}: {
  scope: "admin" | "org";
  orgId: string;
  apps: App[];
}) {
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [history, setHistory] = useState<RecentBackup[]>([]);
  const [targetFormOpen, setTargetFormOpen] = useState(false);
  const [jobFormOpen, setJobFormOpen] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [jobsRes, targetsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/backups`),
        fetch(`/api/v1/organizations/${orgId}/backups/targets`),
      ]);
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
        setHistory(data.recentHistory || []);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Separate system (host-level) targets from user targets
  const systemTargets = targets.filter((t) => t.isAppLevel);
  const userTargets = targets.filter((t) => !t.isAppLevel);

  // Group jobs under their target
  const allTargetsWithJobs: TargetWithJobs[] = targets.map((t) => ({
    ...t,
    jobs: jobs.filter((j) => j.target.id === t.id),
  }));

  const systemTargetsWithJobs = allTargetsWithJobs.filter((t) => t.isAppLevel);
  const userTargetsWithJobs = allTargetsWithJobs.filter((t) => !t.isAppLevel);

  // Auto-backup banner data
  const autoTarget = systemTargets[0];
  const autoJobs = autoTarget
    ? jobs.filter((j) => j.target.id === autoTarget.id)
    : [];

  return (
    <div className="space-y-8">
      {/* Section 1: Auto-backup banner */}
      {autoTarget && (
        <AutoBackupBanner target={autoTarget} jobs={autoJobs} scope={scope} />
      )}

      {/* Info sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">How it works</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Automatic</span>{" "}
                — apps with persistent volumes get daily snapshots by default
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Offsite</span>{" "}
                — snapshots are uploaded to your S3-compatible provider, not stored on this server
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Tiered retention</span>{" "}
                — keep daily, weekly, monthly and yearly snapshots independently per job
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">One-click restore</span>{" "}
                — any snapshot can be restored directly into the running volume
              </span>
            </li>
          </ul>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Good to know</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Runs live — no downtime, no container restarts</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Manual backups can be triggered anytime</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Only persistent volumes are backed up — ephemeral data is excluded</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Storage targets with inline jobs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">Storage targets</h2>
            <p className="text-sm text-muted-foreground">
              Where your backups are stored. Each target can have one or more backup jobs.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setJobFormOpen(true)}
              disabled={targets.length === 0}
            >
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              New job
            </Button>
            <Button
              size="sm"
              onClick={() => setTargetFormOpen(true)}
            >
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              Add target
            </Button>
          </div>
        </div>

        {allTargetsWithJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">No storage targets configured</p>
              <p className="text-sm text-muted-foreground">
                Add an S3 bucket, Cloudflare R2, Backblaze B2, or SSH server to start backing up.
              </p>
            </div>
            <Button size="sm" onClick={() => setTargetFormOpen(true)}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              Add target
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* System targets first */}
            {systemTargetsWithJobs.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                orgId={orgId}
                readOnly={scope === "org"}
                onRefresh={fetchData}
              />
            ))}

            {/* User targets */}
            {userTargetsWithJobs.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                orgId={orgId}
                onRefresh={fetchData}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Backup history */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Backup history</h2>
          <p className="text-sm text-muted-foreground">
            Recent snapshots across all targets and jobs.
          </p>
        </div>

        <BackupHistory history={history} orgId={orgId} onRefresh={fetchData} />
      </section>

      {/* Forms */}
      <TargetForm
        open={targetFormOpen}
        onOpenChange={setTargetFormOpen}
        orgId={orgId}
        isFirstTarget={userTargets.length === 0}
        onCreated={fetchData}
      />

      <JobForm
        open={jobFormOpen}
        onOpenChange={setJobFormOpen}
        orgId={orgId}
        targets={targets}
        apps={apps}
        defaultTargetId={userTargets[0]?.id || systemTargets[0]?.id}
        onCreated={fetchData}
      />
    </div>
  );
}
