"use client";

import { ShieldCheck, Check, Info, CloudUpload } from "lucide-react";
import { retentionDescription } from "./retention-summary";
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
  const retention = jobs.length > 0 ? retentionDescription(jobs[0]) : "Default retention";
  const schedule = "Daily";

  return (
    <div className="squircle rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="size-5 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">We&apos;ve got you covered</h3>
          <p className="text-sm text-muted-foreground">
            Your data is backed up automatically. You can download or restore any snapshot, or add your own backup targets for additional redundancy.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground pl-8">
        <span className="flex items-center gap-1.5">
          <Check className="size-3 text-status-success" aria-hidden="true" />
          {schedule}
        </span>
        <span className="flex items-center gap-1.5">
          <CloudUpload className="size-3" aria-hidden="true" />
          Stored offsite
        </span>
        <span className="flex items-center gap-1.5">
          <Info className="size-3" aria-hidden="true" />
          {retention}
        </span>
      </div>
    </div>
  );
}
