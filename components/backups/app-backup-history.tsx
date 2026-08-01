"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { BackupHistory } from "./backup-history";
import { UncapturedWarning, uncapturedSources } from "./uncaptured-warning";
import type { BackupJob, RecentBackup } from "./types";

/**
 * Backup history scoped to a single app. Used in project and app detail tabs.
 * Fetches all org backup history and filters client-side by appId.
 */
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

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups?appId=${appId}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.recentHistory || []);
        const jobApps = ((data.jobs || []) as BackupJob[]).flatMap((job) =>
          job.backupJobApps.map((bja) => bja.app).filter((app) => app.id === appId),
        );
        setUncaptured(uncapturedSources(jobApps));
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [orgId, appId]);

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

  return (
    <div className="space-y-3">
      <UncapturedWarning sources={uncaptured} />
      <BackupHistory history={history} orgId={orgId} onRefresh={fetchData} />
    </div>
  );
}
