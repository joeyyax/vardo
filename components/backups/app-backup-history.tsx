"use client";

import { useState, useEffect, useCallback } from "react";
import { Archive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/messenger";
import { BackupHistory } from "./backup-history";
import { jobAnchor } from "./job-anchor";
import { UncapturedWarning, uncapturedSources } from "./uncaptured-warning";
import type { BackupJob, RecentBackup } from "./types";

type AppBackupData = { history: RecentBackup[]; uncaptured: string[] };

async function requestAppBackups(orgId: string, appId: string): Promise<AppBackupData | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/backups?appId=${appId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const jobApps = ((data.jobs || []) as BackupJob[]).flatMap((job) =>
      job.backupJobApps.map((bja) => bja.app).filter((app) => app.id === appId),
    );
    return { history: data.recentHistory || [], uncaptured: uncapturedSources(jobApps) };
  } catch {
    return null;
  }
}

/** Backup history for one app, filtered client-side from the org's history. */
export function AppBackupHistory({
  orgId,
  appId,
}: {
  orgId: string;
  appId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<RecentBackup[]>([]);
  const [uncaptured, setUncaptured] = useState<string[]>([]);
  const [backingUp, setBackingUp] = useState(false);

  const applyData = useCallback((data: AppBackupData | null) => {
    if (data) {
      setHistory(data.history);
      setUncaptured(data.uncaptured);
    }
    setLoading(false);
  }, []);

  const fetchData = useCallback(async () => {
    applyData(await requestAppBackups(orgId, appId));
  }, [orgId, appId, applyData]);

  useEffect(() => {
    let cancelled = false;
    requestAppBackups(orgId, appId).then((data) => {
      if (!cancelled) applyData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, appId, applyData]);

  // Creates the backup job the app is missing.
  const backupNow = useCallback(async () => {
    setBackingUp(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/backup-now`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error || "Couldn't start a backup");
        return;
      }
      const warning = (body.warnings ?? [])[0];
      toast.success(warning ? `Backup started — ${warning}` : "Backup started");
      // The run is async; the row appears once the engine writes it.
      setTimeout(fetchData, 2000);
    } catch {
      toast.error("Couldn't reach the backup service");
    } finally {
      setBackingUp(false);
    }
  }, [orgId, appId, fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={backingUp} onClick={backupNow}>
          {backingUp ? (
            <><Loader2 className="mr-1.5 size-4 animate-spin" />Starting...</>
          ) : (
            <><Archive className="mr-1.5 size-4" />Back up now</>
          )}
        </Button>
      </div>
      <UncapturedWarning sources={uncaptured} />
      <BackupHistory history={history} orgId={orgId} onRefresh={fetchData} jobHref={(id) => `/backups#${jobAnchor(id)}`} />
    </div>
  );
}
