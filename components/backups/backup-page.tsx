"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Check, Info, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShineBorder } from "@/components/ui/shine-border";
import { AutoBackupBanner } from "./auto-backup-banner";
import { TargetCard } from "./target-card";
import { JobCard } from "./job-card";
import { TargetForm } from "./target-form";
import { JobForm } from "./job-form";
import { BackupHistory } from "./backup-history";
import type { App, BackupTarget, BackupJob, RecentBackup } from "./types";

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
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);

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

  const systemTargets = targets.filter((t) => t.isAppLevel);
  const userTargets = targets.filter((t) => !t.isAppLevel);
  const hasTargets = targets.length > 0;

  // Auto-backup banner
  const autoTarget = systemTargets[0];
  const autoJobs = autoTarget ? jobs.filter((j) => j.target.id === autoTarget.id) : [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Backups</h2>
        <p className="text-sm text-muted-foreground">
          {scope === "admin"
            ? "Manage system-wide backup targets, retention policies, and view backup history across all organizations."
            : "Manage backup targets and view backup history for this organization."}
        </p>
      </div>

      {/* Auto-backup banner — only shown to org users, admin is configuring this */}
      {scope === "org" && autoTarget && (
        <AutoBackupBanner target={autoTarget} jobs={autoJobs} scope={scope} />
      )}

      {/* Two-column: Storage targets + Backup jobs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left: Storage targets */}
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle className="text-sm font-medium">Storage targets</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setTargetFormOpen(true)}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              Add target
            </Button>
          </CardHeader>
          <CardContent>
            {!hasTargets ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
                <p className="text-sm text-muted-foreground text-center">
                  Add an S3 bucket, Cloudflare R2, Backblaze B2, or SSH server to start backing up.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {systemTargets.map((target) => (
                  <TargetCard
                    key={target.id}
                    target={target}
                    orgId={orgId}
                    readOnly={scope === "org"}
                    onRefresh={fetchData}
                    onEdit={scope === "admin" ? () => setEditingTargetId(target.id) : undefined}
                  />
                ))}
                {userTargets.map((target) => (
                  <TargetCard
                    key={target.id}
                    target={target}
                    orgId={orgId}
                    onRefresh={fetchData}
                    onEdit={() => setEditingTargetId(target.id)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right: Backup jobs */}
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle className="text-sm font-medium">Backup jobs</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setJobFormOpen(true)} disabled={!hasTargets}>
              <Plus className="mr-1.5 size-4" aria-hidden="true" />
              New job
            </Button>
          </CardHeader>
          <CardContent>
            {!hasTargets ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
                <p className="text-sm text-muted-foreground text-center">
                  Jobs can be added after you add a storage target.
                </p>
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
                <Archive className="size-6 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm text-muted-foreground text-center">
                  No backup jobs configured. Create one to schedule automatic backups.
                </p>
                <div className="relative overflow-hidden rounded-lg">
                  <ShineBorder shineColor={["#6366f1", "#8b5cf6", "#a78bfa"]} duration={8} borderWidth={2} />
                  <Button size="sm" variant="outline" onClick={() => setJobFormOpen(true)}>
                    <Plus className="mr-1.5 size-4" aria-hidden="true" />
                    New job
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    orgId={orgId}
                    readOnly={scope === "org" && job.target.type === "system"}
                    onRefresh={fetchData}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Backup history */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Backup history</CardTitle>
          <p className="text-sm text-muted-foreground">
            Recent snapshots across all targets and jobs.
          </p>
        </CardHeader>
        <CardContent>
          <BackupHistory history={history} orgId={orgId} onRefresh={fetchData} />
        </CardContent>
      </Card>

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

      {/* Forms */}
      <TargetForm
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
      />

      <JobForm
        open={jobFormOpen}
        onOpenChange={setJobFormOpen}
        orgId={orgId}
        targets={targets}
        apps={apps}
        defaultTargetId={targets[0]?.id}
        onCreated={() => {
          setJobFormOpen(false);
          fetchData();
        }}
      />
    </div>
  );
}
