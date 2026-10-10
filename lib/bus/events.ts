/** Typed event definitions for the event bus, as a discriminated union on `type`. */

import type { StageTimings } from "@/lib/docker/stage-timings";

// Event categories for grouping in the settings UI.

export const EVENT_CATEGORIES = {
  deploy: ["deploy.success", "deploy.failed", "deploy.incomplete", "deploy.rollback"],
  app: ["app.state-changed", "app.auto-restarted"],
  alert: ["alert.fired", "alert.resolved"],
  backup: ["backup.run-started", "backup.summary"],
  cron: ["cron.failed"],
  volume: ["volume.drift"],
  disk: ["disk.write-alert"],
  org: ["org.invitation-sent", "org.invitation-accepted"],
  security: ["security.file-exposed", "security.scan-findings", "security.domain-claimed"],
  system: [
    "system.service-down",
    "system.restart-loop",
    "system.cert-expiring",
    "system.update-available",
  ],
  lifecycle: [
    "system.shutdown",
    "system.started",
    "system.recovered-unclean",
    "system.update-started",
    "system.updated",
    "system.update-failed",
    "system.containers-missing",
  ],
  digest: ["digest.health"],
} as const;

export type EventCategory = keyof typeof EVENT_CATEGORIES;

export type DeployTrigger = "manual" | "webhook" | "api" | "rollback";

/** Deploy facts the notification emails show. Older emitters leave them out. */
export type DeployDetails = {
  /** App slug. `projectName` carries the display name. */
  appName?: string;
  project?: string;
  environment?: string;
  domains?: string[];
  trigger?: DeployTrigger;
  gitAuthor?: string;
  gitBranch?: string;
  /** Repository browse URL, e.g. https://github.com/acme/api. */
  repoUrl?: string;
  slot?: string;
  previousSlot?: string;
  durationMs?: number;
  stageTimings?: StageTimings;
};

export type DeploySuccessEvent = DeployDetails & {
  type: "deploy.success";
  title: string;
  message: string;
  projectName: string;
  appId: string;
  deploymentId: string;
  duration: string;
  domain?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
};

export type DeployFailedEvent = DeployDetails & {
  type: "deploy.failed";
  title: string;
  message: string;
  projectName: string;
  appId: string;
  deploymentId: string;
  domain?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
  errorMessage?: string;
  /** Deploy stage that failed: clone, build, deploy, healthcheck... */
  failedStage?: string;
  /** The container log line that best explains a crash. */
  crashReason?: string;
  /** Last relevant deploy log lines, already redacted. */
  logTail?: string[];
  /** What serves traffic now. */
  serving?: "previous" | "new" | "none";
};

/** The release is live and serving; post-deploy work behind it did not finish. */
export type DeployIncompleteEvent = DeployDetails & {
  type: "deploy.incomplete";
  title: string;
  message: string;
  projectName: string;
  appId: string;
  deploymentId: string;
  reason: string;
  gitSha?: string;
};

export type DeployRollbackEvent = {
  type: "deploy.rollback";
  title: string;
  message: string;
  projectName: string;
  appId: string;
  rollbackSuccess: boolean;
  /** The deploy that crashed. */
  deploymentId?: string;
  /** Slot serving after the rollback. */
  restoredSlot?: string;
  logTail?: string[];
};

export type BackupSuccessEvent = {
  type: "backup.success";
  title: string;
  message: string;
  jobId: string;
  jobName: string;
  totalCount: number;
  totalSize: number;
  durationMs?: number;
  sources?: { name: string; sizeBytes: number; backupId?: string }[];
  skippedCount?: number;
};

export type BackupFailedEvent = {
  type: "backup.failed";
  title: string;
  message: string;
  jobId: string;
  jobName: string;
  failedCount: number;
  totalCount: number;
  errors: string;
  durationMs?: number;
  failures?: { name: string; error: string; backupId?: string }[];
};

/** One app and volume in a backup summary. */
export type BackupSummaryRow = {
  kind: "backup" | "drill" | "restore" | "import";
  appId: string | null;
  appName: string;
  volumeName: string;
  jobName?: string;
  outcome: "success" | "failed" | "skipped";
  sizeBytes: number;
  durationMs: number;
  error?: string;
  /** Results for this row in the batch. */
  runs: number;
  /** Earlier successful sizes, oldest first. */
  history?: number[];
  previousSize?: number;
  /** Well below its usual size. */
  shrunk?: { median: number; drop: number };
  /** Much larger than last run, as a percentage. */
  grew?: { pct: number };
};

/** One app's backups in a run. */
export type BackupSummaryApp = {
  appId: string | null;
  /** Display name. */
  appName: string;
  volumes: number;
  failed: number;
  skipped: number;
  /** Successful archives' total. */
  sizeBytes: number;
  /** Change against last run's sizes of the same volumes, as a fraction. Undefined without history. */
  change?: number;
};

/** A run of backups is starting: what it covers and how long it should take. */
export type BackupRunStartedEvent = {
  type: "backup.run-started";
  title: string;
  message: string;
  runId: string;
  kind: "nightly" | "job" | "restore";
  /** "Nightly backups", a job name or the restore. */
  label: string;
  apps: { appId: string | null; appName: string; volumes: string[]; lastBytes?: number }[];
  volumeCount: number;
  estimatedMs: number | null;
  /** Where archives go, without credentials. */
  target: string | null;
};

/** A finished run: every result in it, failures first. */
export type BackupSummaryEvent = {
  type: "backup.summary";
  title: string;
  message: string;
  run: {
    kind: "nightly" | "job" | "restore";
    label: string;
    estimatedMs: number | null;
    actualMs: number;
    /** Jobs that hadn't reported when the deadline passed. */
    unfinished?: string[];
  };
  /** ISO times the run started and finished. */
  windowStart: string;
  windowEnd: string;
  /** Backup rows only. */
  succeeded: number;
  failed: number;
  skipped: number;
  totalSize: number;
  durationMs: number;
  /** Failures first. Capped; `hiddenRows` counts the rest. */
  rows: BackupSummaryRow[];
  hiddenRows?: number;
  /** Backups grouped by app, by display name. */
  apps?: BackupSummaryApp[];
  /** Volumes backed up this week with no success in 48 hours. */
  staleVolumes?: { appName: string; volumeName: string; lastSuccessAt: string | null }[];
};

export type CronFailedEvent = {
  type: "cron.failed";
  title: string;
  message: string;
  cronJobId: string;
  cronJobName: string;
  appId: string;
  projectName: string;
  durationMs: number;
  schedule?: string;
  /** Shell command, or the URL for a URL job. */
  command?: string;
  jobType?: "command" | "url";
  /** Exit code, or the HTTP status for a URL job. */
  exitCode?: number;
  /** Container the command ran in, or the URL. */
  target?: string;
  /** ISO time of the last successful run. */
  lastSuccessAt?: string;
  logTail?: string[];
};

export type VolumeDriftEvent = {
  type: "volume.drift";
  title: string;
  message: string;
  appId: string;
  appName: string;
  totalDrift: number;
  volumes?: { name: string; modified: number; added: number; missing: number }[];
};

export type DiskWriteAlertEvent = {
  type: "disk.write-alert";
  title: string;
  message: string;
  appId: string;
  appName?: string;
  projectName?: string;
  composeService?: string;
  dataEngine?: boolean;
  containerName: string;
  containerId: string;
  writtenBytes: number;
  thresholdBytes: number;
  window: string;
  /** Project label the container's metrics are stored under. */
  metricsProject?: string;
};

export type OrgInvitationSentEvent = {
  type: "org.invitation-sent";
  title: string;
  message: string;
  inviteeEmail: string;
  invitedBy: string;
};

export type OrgInvitationAcceptedEvent = {
  type: "org.invitation-accepted";
  title: string;
  message: string;
  memberName: string;
  memberEmail: string;
};

export type SystemServiceDownEvent = {
  type: "system.service-down";
  title: string;
  message: string;
  service: string;
  description: string;
  latencyMs?: string;
};

export type SystemRestartLoopEvent = {
  type: "system.restart-loop";
  title: string;
  message: string;
  uptimeSeconds: number;
};

export type SystemCertExpiringEvent = {
  type: "system.cert-expiring";
  title: string;
  message: string;
  domain: string;
  /** Every domain the certificate covers. */
  domains?: string[];
  daysLeft: number;
  expiresAt: string;
  resolver: string;
};

export type SystemUpdateAvailableEvent = {
  type: "system.update-available";
  title: string;
  message: string;
  remoteHead: string;
  localHead: string;
};

export type SecurityFileExposedEvent = {
  type: "security.file-exposed";
  title: string;
  message: string;
  appName: string;
  domain: string;
  exposedPaths: string[];
};

export type SecurityScanFindingsEvent = {
  type: "security.scan-findings";
  title: string;
  message: string;
  appId: string;
  appName: string;
  scanId: string;
  criticalCount: number;
  warningCount: number;
  domain?: string;
};

/** Another org verified a host, which removed this org's unverified rows for it. */
export type SecurityDomainClaimedEvent = {
  type: "security.domain-claimed";
  title: string;
  message: string;
  domains: string[];
  appIds: string[];
};

export type DigestProjectRow = {
  name: string;
  deploys: number;
  failures: number;
  backupFailures: number;
  cronFailures: number;
};

/** A daily or weekly record of one org's window: deploys, backups, alerts, trends and what's coming due. */
export type DigestHealthEvent = {
  type: "digest.health";
  title: string;
  message: string;
  cadence: "daily" | "weekly";
  orgName: string;
  /** "Oct 2 – Oct 8, 2026", or one day for a daily digest. */
  windowLabel: string;
  since: string;
  until: string;
  deploys: { total: number; succeeded: number; failed: number };
  /** Per hour for a daily digest, per day for a weekly one. Oldest first. */
  deploysByBucket?: { start: string; succeeded: number; failed: number }[];
  backups: { succeeded: number; failed: number; totalSize: number; drillsPassed: number; drillsFailed: number; staleVolumes: number };
  cron: { failed: number; affectedJobs: string[] };
  alerts: { fired: number; resolved: number; open: number; top: { label: string; count: number }[] };
  /** Host trends, for orgs with an instance admin. */
  resources?: { label: string; values: number[]; latest: number; peak: number; unit: "percent" | "per-core" }[];
  /** Live at send time, not part of the window. */
  certs: { domain: string; daysLeft: number }[];
  imageUpdates: { appName: string; count: number }[];
  projects: DigestProjectRow[];
};

// Vardo's own lifecycle, sent to orgs with an instance admin.

/** The console got SIGTERM. Best effort; the process may exit first. */
export type SystemShutdownEvent = {
  type: "system.shutdown";
  title: string;
  message: string;
  reason: string;
  version: string;
  uptimeSeconds: number;
};

/** Back after a clean stop. One per boot. */
export type SystemStartedEvent = {
  type: "system.started";
  title: string;
  message: string;
  version: string;
  /** Shutdown or last heartbeat to boot. */
  downSeconds?: number;
  hostRebooted: boolean;
  /** Why it stopped, from the shutdown marker. */
  reason?: string;
};

/** Back with no clean-shutdown marker: power loss, forced stop or a crash. */
export type SystemRecoveredUncleanEvent = {
  type: "system.recovered-unclean";
  title: string;
  message: string;
  version: string;
  downSeconds?: number;
  hostRebooted: boolean;
  /** ISO time of the last heartbeat before the stop. */
  lastHeartbeatAt?: string;
};

export type SystemUpdateStartedEvent = {
  type: "system.update-started";
  title: string;
  message: string;
  fromVersion: string;
  branch?: string;
  fromSlot?: string;
  toSlot?: string;
};

export type SystemUpdatedEvent = {
  type: "system.updated";
  title: string;
  message: string;
  fromVersion: string;
  toVersion: string;
  fromSlot?: string;
  toSlot?: string;
  durationSeconds?: number;
  /** Console downtime during the swap. */
  downSeconds?: number;
};

export type SystemUpdateFailedEvent = {
  type: "system.update-failed";
  title: string;
  message: string;
  fromVersion: string;
  toVersion?: string;
  fromSlot?: string;
  toSlot?: string;
  step: string;
  error?: string;
  durationSeconds?: number;
  rolledBack?: boolean;
  logTail?: string[];
};

/** Containers running before a host restart that didn't come back. */
export type SystemContainersMissingEvent = {
  type: "system.containers-missing";
  title: string;
  message: string;
  containers: { name: string; app?: string; state: string }[];
};

// Operational events: real-time UI updates, not sent to channels.

/** Deploy status change for real-time UI. `running` marks the start of a deploy. */
export type DeployStatusEvent = {
  type: "deploy.status";
  title: string;
  message: string;
  appId: string;
  deploymentId: string;
  status: "running" | "active" | "error" | "cancelled" | "superseded";
  success: boolean;
  durationMs?: number;
  supersededBy?: string;
};

/** One volume of a backup run started. Keep out of EVENT_CATEGORIES; it drives live UI only. */
export type BackupProgressEvent = {
  type: "backup.progress";
  title: string;
  message: string;
  jobId: string;
  jobName: string;
  appId: string | null;
  /** App the source belongs to, or the volume name for unattached sources. */
  appName: string;
  volumeName: string;
  /** 1-based position in the run. */
  index: number;
  total: number;
};

/** An app's runtime state changed (started, stopped, restarted, etc.). */
export type AppStateChangedEvent = {
  type: "app.state-changed";
  title: string;
  message: string;
  appId: string;
};

/** The health monitor restarted an unhealthy container. `gaveUp` means the restart cap was hit. */
export type AppAutoRestartedEvent = {
  type: "app.auto-restarted";
  title: string;
  message: string;
  appId: string;
  appName: string;
  containerName: string;
  containerId: string;
  reason: string;
  success: boolean;
  gaveUp: boolean;
};

/** The kernel killed a container for memory: `oom-host` is the machine, `oom-limit` the container's own cap. */
export type AppOomKilledEvent = {
  type: "app.oom-killed";
  title: string;
  message: string;
  appId: string;
  appName: string;
  containerName: string;
  containerId: string;
  kind: "oom-host" | "oom-limit";
  exitCode: number;
  /** ISO timestamp the container finished. */
  at: string;
};

/** One alert in an alert email. Severity and wording come from the rule that fired it. */
export type AlertItem = {
  /** Registry key, e.g. `host.memory`. */
  type: string;
  /** Subject the throttle keys on. */
  about: string;
  severity: "warning" | "critical";
  /** "Memory 92% used". */
  title: string;
  /** One or two sentences: what's wrong and what to do. */
  detail: string;
  appId?: string;
  appName?: string;
  gauge?: { title: string; percent: number; warn: number; critical: number };
  /** Recent readings, oldest first. */
  series?: { title: string; values: number[]; caption?: string };
  facts?: { label: string; value: string }[];
  /** ISO time the condition started. */
  since?: string;
};

/** Alerts that fired in one pass, coalesced into one notice per org. */
export type AlertFiredEvent = {
  type: "alert.fired";
  title: string;
  message: string;
  alerts: AlertItem[];
};

/** Alerts that cleared in one pass. */
export type AlertResolvedEvent = {
  type: "alert.resolved";
  title: string;
  message: string;
  alerts: (AlertItem & { firedAt: string; resolvedAt: string })[];
};

export type BusEvent =
  | DeploySuccessEvent
  | DeployFailedEvent
  | DeployIncompleteEvent
  | DeployRollbackEvent
  | BackupSuccessEvent
  | BackupFailedEvent
  | BackupSummaryEvent
  | BackupRunStartedEvent
  | CronFailedEvent
  | VolumeDriftEvent
  | DiskWriteAlertEvent
  | OrgInvitationSentEvent
  | OrgInvitationAcceptedEvent
  | SystemServiceDownEvent
  | SystemRestartLoopEvent
  | SystemCertExpiringEvent
  | SystemUpdateAvailableEvent
  | SecurityFileExposedEvent
  | SecurityScanFindingsEvent
  | SecurityDomainClaimedEvent
  | DigestHealthEvent
  | SystemShutdownEvent
  | SystemStartedEvent
  | SystemRecoveredUncleanEvent
  | SystemUpdateStartedEvent
  | SystemUpdatedEvent
  | SystemUpdateFailedEvent
  | SystemContainersMissingEvent
  | BackupProgressEvent
  | DeployStatusEvent
  | AppStateChangedEvent
  | AppAutoRestartedEvent
  | AppOomKilledEvent
  | AlertFiredEvent
  | AlertResolvedEvent;

export type BusEventType = BusEvent["type"];

/** Every event type string. */
export const ALL_EVENT_TYPES: BusEventType[] = Object.values(EVENT_CATEGORIES).flat() as BusEventType[];
