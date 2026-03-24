export type App = {
  id: string;
  name: string;
  displayName: string;
};

export type BackupTarget = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  isAppLevel?: boolean;
};

export type BackupHistoryEntry = {
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
};

export type BackupJob = {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  keepLast: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  createdAt: string;
  target: { id: string; name: string; type: string };
  backupJobApps: {
    app: App;
  }[];
  backups: BackupHistoryEntry[];
};

export type RecentBackup = {
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  storagePath: string | null;
  log: string | null;
  job: { id: string; name: string };
  app: App;
};

export type TargetType = "s3" | "r2" | "b2" | "ssh";

export type TargetWithJobs = BackupTarget & {
  jobs: BackupJob[];
};
