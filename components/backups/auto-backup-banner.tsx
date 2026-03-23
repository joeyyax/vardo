"use client";

import { Archive, Check, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { scheduleLabel, TargetIcon } from "./constants";
import { retentionText } from "./retention-summary";
import type { BackupJob, BackupTarget } from "./types";

export function AutoBackupBanner({
  target,
  jobs,
  scope,
}: {
  target: BackupTarget;
  jobs: BackupJob[];
  scope: "admin" | "org";
}) {
  const retention = jobs.length > 0 ? retentionText(jobs[0]) : "Default";
  const schedule = jobs.length > 0 ? scheduleLabel(jobs[0].schedule) : "Daily";

  return (
    <div className="squircle rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Archive className="size-5 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Automatic backups are enabled</h3>
          <p className="text-sm text-muted-foreground">
            {scope === "org"
              ? "Your data is automatically backed up by the host. You can download or restore these backups anytime."
              : "All apps with persistent volumes are backed up automatically."}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground pl-8">
        <span className="flex items-center gap-1.5">
          <TargetIcon type={target.type} />
          {target.name}
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{target.type}</Badge>
        </span>
        <span className="flex items-center gap-1.5">
          <Check className="size-3 text-status-success" aria-hidden="true" />
          {schedule}
        </span>
        <span className="flex items-center gap-1.5">
          <Info className="size-3" aria-hidden="true" />
          Retention: {retention}
        </span>
      </div>
    </div>
  );
}
