export type AppVolume = {
  name: string;
  type: "named" | "bind";
  source: string | null;
  backupStrategy: string;
};

export type App = {
  id: string;
  name: string;
  displayName: string;
  volumes?: AppVolume[];
};

export type BackupTarget = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  isAppLevel?: boolean;
};

/** What deleting a target takes with it. */
export type TargetUsage = {
  backups: number;
  bytes: number;
  inProgress: number;
  jobs: number;
  /** This org's jobs; other orgs' are counted only. */
  jobNames: string[];
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
  /** Runs in the org's nightly run. */
  nightly?: boolean;
  /** Zone a nightly job's time is in. Other schedules run in UTC. */
  timeZone?: string;
  enabled: boolean;
  keepLast: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  createdAt: string;
  /** Last time the job captured something. */
  lastRunAt?: string | null;
  target: { id: string; name: string; type: string };
  backupJobApps: {
    app: App;
  }[];
  /** Newest first; the org page gets the detail fields too. */
  backups: JobRun[];
};

/** One run of a job, as the jobs list returns it. */
export type JobRun = BackupHistoryEntry & Partial<Omit<RecentBackup, keyof BackupHistoryEntry | "job">>;

export type RecentBackup = {
  /** The archive's volume, when the run captured one. */
  volumeName?: string | null;
  id: string;
  status: string;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  storagePath: string | null;
  log: string | null;
  /** Restore drill result; all null until a drill has run. */
  verifiedAt: string | null;
  verifyOutcome: string | null;
  verifyDetail: string | null;
  /** Null once the job is deleted; jobName keeps the label. */
  job: { id: string; name: string } | null;
  jobName: string | null;
  /** "initial" or "import" for a first snapshot. */
  trigger?: string | null;
  appId: string | null;
  /** Null once the app is deleted; appName keeps the label. */
  app: App | null;
  appName: string | null;
};

/** Where a live run has got to, from the latest backup.progress event. */
export type RunProgress = {
  jobId: string;
  appName: string;
  volumeName: string;
  index: number;
  total: number;
};

export type TargetType = "s3" | "r2" | "b2" | "ssh" | "local";

export type TargetWithJobs = BackupTarget & {
  jobs: BackupJob[];
};
