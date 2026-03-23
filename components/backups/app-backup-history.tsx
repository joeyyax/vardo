"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Archive } from "lucide-react";
import { BackupHistory } from "./backup-history";
import type { RecentBackup } from "./types";

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

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups`);
      if (res.ok) {
        const data = await res.json();
        const all: RecentBackup[] = data.recentHistory || [];
        setHistory(all.filter((h) => h.app.id === appId));
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

  return <BackupHistory history={history} orgId={orgId} onRefresh={fetchData} />;
}
