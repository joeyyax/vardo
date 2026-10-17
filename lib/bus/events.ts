/** Typed event definitions for the event bus, as a discriminated union on `type`. */

import type { StageTimings } from "@/lib/docker/stage-timings";
import type { IncidentRef } from "@/lib/incidents/types";

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
    "system.integration-permissions",
  ],
  lifecycle: [
    "system.shutdown",
    "system.started",
    "system.recovered-unclean",
    "system.update-started",
    "system.updated",
    "system.update-failed",
    "system.rollout-started",
    "system.rollout-busy",
    "system.rollout-paused",
    "system.rollout-finished",
    "system.restarting",
    "system.restarted",
    "system.restart-failed",
    "system.containers-missing",
  ],
  digest: ["digest.health", "digest.app-recap"],
} as const;

export type EventCategory = keyof typeof EVENT_CATEGORIES;

export type DeployTrigger = "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";

/** Deploy facts the notification emails show. Older emitters leave them out. */
export type DeployDetails = {
  /** App slug. `projectName` carries the display name. */
  appName?: string;
  project?: string;
  projectId?: string;
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
  /** The app's first successful deploy to a production environment. */
  firstDeploy?: boolean;
  /** When the app's 72-hour recap sends. Set once it's scheduled. */
  recapAt?: string;
  /** Median duration of recent successful deploys. */
  usualDurationMs?: number;
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
  project?: string;
  projectId?: string;
  environment?: string;
  repoUrl?: string;
  /** The commit that crashed. */
  gitSha?: string;
  gitMessage?: string;
  /** The commit serving again. */
  servingSha?: string;
  servingMessage?: string;
  /** How long the crashed version was live. */
  liveMs?: number;
  rolledBackAt?: string;
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
  /** A routine skip: a stopped app or a source that can't be captured. */
  expected?: boolean;
  /** Opted in, but app config the engine leaves out. Not backed up and not a failure. */
  config?: boolean;
  /** ISO time of the last successful backup before this run. */
  lastGoodAt?: string;
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
    /** Unfinished jobs that never started a backup. */
    notStarted?: string[];
    /** Unfinished job name to the one app it backs up. */
    unfinishedAppIds?: Record<string, string>;
    /** A scheduled run emailing because something needs a look: the email lists only the problems. */
    problemsOnly?: boolean;
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
  staleVolumes?: { appId?: string | null; appName: string; volumeName: string; lastSuccessAt: string | null }[];
  /** Nightly runs: the org's volumes no job backs up, with why. */
  notBackedUp?: { appId: string; appName: string; volumeName: string; reason: string }[];
};

export type CronFailedEvent = {
  type: "cron.failed";
  title: string;
  message: string;
  cronJobId: string;
  cronJobName: string;
  /** Absent for an org-level job. */
  appId?: string;
  projectName?: string;
  durationMs: number;
  schedule?: string;
  /** Zone the schedule runs in. */
  scheduleTimeZone?: string;
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
  /** Up to the last 24 runs, oldest first, this one included. */
  recentRuns?: ("success" | "failed")[];
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
  /** Replaces "<service> down" as the email subject and heading, for notices that aren't a plain outage. */
  subject?: string;
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
  /** The app the domains belong to; only its org gets it. */
  app?: { id: string; name: string; project?: string };
};

/** A Git provider integration lacks a permission Vardo needs. */
export type SystemIntegrationPermissionsEvent = {
  type: "system.integration-permissions";
  title: string;
  message: string;
  provider: "github" | "gitlab" | "gitea";
  /** "app" when the App's owner must add permissions, "installation" when an account must accept them. */
  scope: "app" | "installation";
  /** The App's slug or the installing account. */
  account: string;
  missing: string[];
  features: string[];
  fixUrl: string;
  fixLabel: string;
};

/** One commit in an update's changelog. */
export type UpdateCommit = { sha: string; subject: string; author?: string };

/** What an update brings: newest commits first, capped, and where to read all of it. */
export type UpdateChanges = {
  commits?: UpdateCommit[];
  /** Commits past the list. */
  moreCommits?: number;
  /** GitHub compare or release page. */
  changesUrl?: string;
  /** Release notes, for the releases channel. */
  releaseNotes?: string;
};

export type SystemUpdateAvailableEvent = UpdateChanges & {
  type: "system.update-available";
  title: string;
  message: string;
  remoteHead: string;
  localHead: string;
  /** "main" or "releases". */
  channel?: string;
  /** Release tag when the channel is releases. */
  target?: string;
  commitsBehind?: number;
  /** True when the console can update itself; false shows the host command. */
  selfDeploy?: boolean;
};

export type SecurityFileExposedEvent = {
  type: "security.file-exposed";
  title: string;
  message: string;
  appName: string;
  domain: string;
  exposedPaths: string[];
};

/** One finding as an email lists it. */
export type ScanFindingLine = { severity: "critical" | "warning" | "info"; title: string; description: string };

/** One app's findings to report from a scan. */
export type ScanAppReport = {
  appId: string;
  appName: string;
  domain?: string;
  findings: ScanFindingLine[];
  /** Findings the previous scan had that this one didn't. */
  resolved?: number;
};

/** A manual scan's result, or the new and changed findings from scheduled or post-deploy scans. */
export type SecurityScanFindingsEvent = {
  type: "security.scan-findings";
  title: string;
  message: string;
  /** The first app's, for consumers that read one. */
  appId: string;
  appName: string;
  scanId: string;
  criticalCount: number;
  warningCount: number;
  domain?: string;
  trigger?: "deploy" | "scheduled" | "manual";
  /** Every finding on a manual scan; only new or changed ones otherwise. */
  apps?: ScanAppReport[];
  /** Apps the batch scanned. */
  scanned?: number;
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
  /** Project id, or absent for an app outside any project. */
  id?: string;
  /** Set when the row is a lone app. */
  appId?: string;
  name: string;
  /** Its apps by name, when it has more than one. */
  apps?: string[];
  deploys: number;
  failures: number;
  /** Backups that finished in the window. */
  backups?: { succeeded: number; total: number };
  backupFailures: number;
  cronFailures: number;
  /** Sums of each app's average. CPU is percent of one core; memory is bytes. */
  cpu?: number | null;
  memory?: number | null;
};

/** A project someone watches: each site's numbers over the window, from the recap collector. */
export type DigestWatchedProject = {
  projectId: string;
  name: string;
  apps: AppRecap[];
  /** Primary domain per app id. */
  domains: Record<string, string>;
  /** Across every site's checks. */
  uptime: { ratio: number; downMinutes: number } | null;
  response: { p50: number; p95: number } | null;
  /** Mean activity per local hour across its sites, 24 values. */
  hours: number[];
  /** Certificates on its domains: how many, and the soonest expiry. */
  certs: { count: number; nextExpiresAt: string | null };
};

/** A weekly or monthly record of one org's window: deploys, backups, alerts, trends and what's coming due. */
export type DigestHealthEvent = {
  type: "digest.health";
  title: string;
  message: string;
  cadence: "weekly" | "monthly";
  orgName: string;
  /** "Oct 2 – Oct 8, 2026" or "October 2026". */
  windowLabel: string;
  since: string;
  until: string;
  /** Top-level apps in the org at send time. */
  appCount?: number;
  deploys: { total: number; succeeded: number; failed: number };
  /** Per local day, oldest first. */
  deploysByBucket?: { start: string; succeeded: number; failed: number }[];
  backups: {
    succeeded: number;
    failed: number;
    totalSize: number;
    drillsPassed: number;
    drillsFailed: number;
    staleVolumes: number;
    /** Runs that finished in the window, and the last one's ISO end. */
    runs?: number;
    lastRunAt?: string | null;
  };
  /** Apps holding the stale volumes, most volumes first. */
  staleApps?: { appId: string | null; appName: string; volumes: number }[];
  /** Apps stopped on purpose whose backup jobs are past due, live at send time. */
  stoppedBackups?: { appId: string; appName: string; lastBackupAt: string | null }[];
  drillFailures?: { appId: string | null; appName: string; volume: string }[];
  /** Apps killed for memory in the window, most first. */
  oomApps?: { appId: string; appName: string; count: number }[];
  /** Security scans in the window: apps scanned and what the latest scan of each found. */
  scans?: { scanned: number; apps: number; lastRunAt: string | null; appsWithFindings: number; critical: number; warnings: number };
  cron: { failed: number; affectedJobs: string[] };
  alerts: { fired: number; resolved: number; open: number; top: { label: string; count: number }[] };
  /** Host trends, for orgs with an instance admin. */
  resources?: { label: string; values: number[]; latest: number; peak: number; unit: "percent" | "per-core" }[];
  /** First production deploys in the window. */
  newApps?: { appId: string; appName: string; deployedAt: string; monthRecapAt: string | null }[];
  /** Each app's last start or stop in the window. `stoppedMs` is how long a started app had been stopped. */
  lifecycle?: { appId: string; appName: string; kind: "started" | "stopped"; at: string; stoppedMs: number | null }[];
  /** Ports and processes deploys added to apps past their first three days. */
  changes?: { appId: string; appName: string; kind: "port" | "process"; item: string; since: string }[];
  /** Live at send time, not part of the window. */
  certs: { domain: string; daysLeft: number }[];
  /** Updates within the running major. New majors are never listed here. */
  imageUpdates: { appId?: string; appName: string; count: number }[];
  /** Running majors at or near end of life. */
  majorNotices?: { appName: string; detail: string }[];
  projects: DigestProjectRow[];
  /** Projects with nothing to show, past the table. */
  quietProjects?: number;
  /** The recipient's watched projects in this org. */
  watched?: DigestWatchedProject[];
};

/** One new app's numbers for its 72-hour or 30-day recap. Bytes are bytes; CPU is percent of one core. */
export type AppRecap = {
  appId: string;
  appName: string;
  projectId?: string;
  projectName?: string;
  kind: "72h" | "30d";
  /** First successful production deploy. */
  deployedAt: string;
  since: string;
  until: string;
  deploys: { total: number; failed: number };
  /** 30-day only: deploys per local day, oldest first. */
  deploysByDay?: { succeeded: number; failed: number }[];
  /** Successful production builds. Null when every deploy pulled a prebuilt image. */
  build: { avgMs: number; fastestMs: number; earlyAvgMs?: number } | null;
  uptime: { ratio: number; downMinutes: number } | null;
  crashes: number;
  oomKills: number;
  cpu: { avg: number; peak: number } | null;
  /** `daysNearLimit` counts local days whose peak came within 10% of the limit. */
  memory: { avg: number; peak: number; peakAt: string; limit: number | null; daysNearLimit?: number } | null;
  network: { rx: number; tx: number } | null;
  /** Mean activity per local hour, 24 values. */
  hours?: number[];
  volumes: { name: string; sizeBytes: number | null; unprotected: boolean }[];
  ports: string[];
  processes: string[];
  backups: { schedule: string; lastAt?: string; nights?: ("ok" | "fail" | "none")[] } | null;
  /** Open findings in the latest security scan. */
  scanFindings: number;
  /** 30-day only. */
  imageUpdates?: number;
};

/** Recaps due the same day in one org, sent as one email. */
export type DigestAppRecapEvent = {
  type: "digest.app-recap";
  title: string;
  message: string;
  orgName: string;
  recaps: AppRecap[];
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

/** Back after a stop. One per boot. */
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
  /** The stop wasn't clean; a "stopped unexpectedly" notice went out with this one. */
  unclean?: boolean;
  /** Containers running before a host reboot that didn't come back. */
  containers?: MissingContainer[];
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
  containers?: MissingContainer[];
};

export type SystemUpdateStartedEvent = UpdateChanges & {
  type: "system.update-started";
  title: string;
  message: string;
  fromVersion: string;
  toVersion?: string;
  branch?: string;
  fromSlot?: string;
  toSlot?: string;
};

export type SystemUpdatedEvent = UpdateChanges & {
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
  /** The fleet rollout that ran this update; the rollout reports it. */
  rolloutId?: string;
};

export type SystemUpdateFailedEvent = UpdateChanges & {
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
  rolloutId?: string;
};

export type SystemRolloutEvent = {
  type: "system.rollout-started" | "system.rollout-busy" | "system.rollout-paused" | "system.rollout-finished";
  title: string;
  message: string;
  rolloutId: string;
  targetSha: string;
  targetLabel: string;
  members: { instanceId: string; name: string; priority: "critical" | "standard" | "low"; state: string; reason: string | null }[];
  busyInstanceId?: string;
};

/** What a restart of Vardo covers and who asked for it. */
export type VardoRestartScope = {
  target: "console" | "worker" | "services";
  /** "the console", "vardo-postgres", "the shared services". */
  label: string;
  source: "maintenance" | "console" | "watchdog";
  reason?: string;
};

/** A restart of Vardo's own containers started. */
export type SystemRestartingEvent = VardoRestartScope & {
  type: "system.restarting";
  title: string;
  message: string;
};

/** The restart finished and everything it covered is back. */
export type SystemRestartedEvent = VardoRestartScope & {
  type: "system.restarted";
  title: string;
  message: string;
  durationSeconds?: number;
};

/** The restart didn't bring everything back. */
export type SystemRestartFailedEvent = VardoRestartScope & {
  type: "system.restart-failed";
  title: string;
  message: string;
  error: string;
  durationSeconds?: number;
  /** Services still not back at the deadline. */
  notBack?: string[];
};

export type MissingContainer = { name: string; app?: string; appId?: string; service?: string; state: string };

/** Containers running before a host restart that didn't come back. */
export type SystemContainersMissingEvent = {
  type: "system.containers-missing";
  title: string;
  message: string;
  containers: MissingContainer[];
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
  /** `process`: a child was killed and the container kept running. `exit`: the container exited. */
  path?: "process" | "exit";
  /** Docker's restart count for the app when the kill was seen. */
  restartCount?: number | null;
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
  /** What to do, when it reads better as its own line. */
  next?: string;
  appId?: string;
  appName?: string;
  gauge?: { title: string; percent: number; warn: number; critical: number };
  /** Recent readings, oldest first. */
  series?: { title: string; values: number[]; caption?: string };
  facts?: { label: string; value: string }[];
  /** ISO time the condition started. */
  since?: string;
  /** It started at or before `since`, which is only the earliest reading held. */
  sinceAtLeast?: boolean;
  /** Set when the alert goes out. */
  incident?: IncidentRef;
  /** The host ran out of memory behind this one. */
  hostMemory?: boolean;
  /** How the email lays it out. Without it the email shows detail, next and facts. */
  view?: AlertView;
};

/** A table row; `appId` links the name. */
export type AlertTableRow = { name: string; appId?: string; sub?: string; why?: string; cells: { value: string; hot?: boolean }[] };

/** Email layout for one alert. The facts stay for webhooks; the email shows these instead. */
export type AlertView = {
  /** Heading when it reads better than the title. */
  heading?: string;
  /** Good news first: "It's running again." */
  reassure?: { strong: string; text?: string };
  /** In place of detail and next. */
  lead?: string[];
  /** Callout title and body when several alerts share an email. */
  brief?: { title: string; body: string };
  /** Under the gauge, e.g. "204 GiB of 223.4 GiB". */
  gaugeLabel?: string;
  /** Series values over this draw red. */
  seriesOver?: number;
  tiles?: { label: string; value: string; unit?: string; sub?: string; hot?: boolean }[];
  table?: { columns: string[]; rows: AlertTableRow[]; note?: string };
  /** The button, when it isn't the app or metrics page. */
  action?: { label: string; path: string };
  /** One problem, shown as a callout after the lead. */
  callout?: { title: string; body?: string };
  /** A fact table; the alert's app name links. `since` adds the start time under this label. */
  facts?: { label: string; value: string }[];
  sinceLabel?: string;
};

/** Alerts that fired in one pass, coalesced into one notice per org. */
export type AlertFiredEvent = {
  type: "alert.fired";
  title: string;
  message: string;
  alerts: AlertItem[];
};

/** A test send through one channel. Never emitted on the bus, so no channel subscribes to it. */
export type NotificationTestEvent = {
  type: "notification.test";
  title: string;
  message: string;
  channelName: string;
  organizationId: string;
};

/** Alerts that cleared in one pass. */
export type AlertResolvedEvent = {
  type: "alert.resolved";
  title: string;
  message: string;
  alerts: (AlertItem & { firedAt: string; resolvedAt: string })[];
  /** Closes incidents for webhooks only: email and push leave it out. */
  quiet?: boolean;
  /** Webhooks get it now; email and push get it later in a grouped notice. */
  held?: boolean;
  /** Held resolutions sent together for email and push. Webhooks already had each one. */
  grouped?: boolean;
};

/** Fields every event can carry. */
export type EventEnvelope = {
  /** Stable per event, kept across retries. Set by emit. */
  id?: string;
  /** The incident a single-subject notice belongs to. */
  incident?: IncidentRef;
};

export type BusEvent = EventEnvelope & (
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
  | SystemIntegrationPermissionsEvent
  | SecurityFileExposedEvent
  | SecurityScanFindingsEvent
  | SecurityDomainClaimedEvent
  | DigestHealthEvent
  | DigestAppRecapEvent
  | SystemShutdownEvent
  | SystemStartedEvent
  | SystemRecoveredUncleanEvent
  | SystemUpdateStartedEvent
  | SystemUpdatedEvent
  | SystemUpdateFailedEvent
  | SystemRolloutEvent
  | SystemRestartingEvent
  | SystemRestartedEvent
  | SystemRestartFailedEvent
  | SystemContainersMissingEvent
  | BackupProgressEvent
  | DeployStatusEvent
  | AppStateChangedEvent
  | AppAutoRestartedEvent
  | AppOomKilledEvent
  | AlertFiredEvent
  | AlertResolvedEvent
  | NotificationTestEvent
);

export type BusEventType = BusEvent["type"];

/** Every event type string. */
export const ALL_EVENT_TYPES: BusEventType[] = Object.values(EVENT_CATEGORIES).flat() as BusEventType[];
