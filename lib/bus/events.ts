/**
 * Typed event definitions for the event bus.
 *
 * Each event uses a dot-notation type string and carries a typed payload
 * instead of the old Record<string, string> metadata bag. The discriminated
 * union ensures every consumer handles each variant correctly.
 */

// ---------------------------------------------------------------------------
// Event categories (used for grouping in the settings UI)
// ---------------------------------------------------------------------------

export const EVENT_CATEGORIES = {
  deploy: ["deploy.success", "deploy.failed", "deploy.rollback"],
  backup: ["backup.success", "backup.failed"],
  cron: ["cron.failed"],
  volume: ["volume.drift"],
  disk: ["disk.write-alert"],
  org: ["org.invitation-sent", "org.invitation-accepted"],
  security: ["security.file-exposed"],
  system: [
    "system.service-down",
    "system.disk-alert",
    "system.restart-loop",
    "system.cert-expiring",
    "system.update-available",
  ],
  digest: ["digest.weekly"],
} as const;

export type EventCategory = keyof typeof EVENT_CATEGORIES;

// ---------------------------------------------------------------------------
// Individual event types
// ---------------------------------------------------------------------------

export type DeploySuccessEvent = {
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

export type DeployFailedEvent = {
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
};

export type DeployRollbackEvent = {
  type: "deploy.rollback";
  title: string;
  message: string;
  projectName: string;
  appId: string;
  rollbackSuccess: boolean;
};

export type BackupSuccessEvent = {
  type: "backup.success";
  title: string;
  message: string;
  jobId: string;
  jobName: string;
  totalCount: number;
  totalSize: number;
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
};

export type VolumeDriftEvent = {
  type: "volume.drift";
  title: string;
  message: string;
  appId: string;
  appName: string;
  totalDrift: number;
};

export type DiskWriteAlertEvent = {
  type: "disk.write-alert";
  title: string;
  message: string;
  appId: string;
  containerName: string;
  containerId: string;
  writtenBytes: number;
  thresholdBytes: number;
  window: string;
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

export type SystemDiskAlertEvent = {
  type: "system.disk-alert";
  title: string;
  message: string;
  percent: number;
  threshold: number;
  severity: "warning" | "critical";
  used: number;
  total: number;
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

export type DigestWeeklyEvent = {
  type: "digest.weekly";
  title: string;
  message: string;
  orgName: string;
  weekLabel: string;
  deploysTotal: number;
  deploysSucceeded: number;
  deploysFailed: number;
  backupsTotal: number;
  backupsFailed: number;
  cronTotal: number;
  cronFailed: number;
};

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type BusEvent =
  | DeploySuccessEvent
  | DeployFailedEvent
  | DeployRollbackEvent
  | BackupSuccessEvent
  | BackupFailedEvent
  | CronFailedEvent
  | VolumeDriftEvent
  | DiskWriteAlertEvent
  | OrgInvitationSentEvent
  | OrgInvitationAcceptedEvent
  | SystemServiceDownEvent
  | SystemDiskAlertEvent
  | SystemRestartLoopEvent
  | SystemCertExpiringEvent
  | SystemUpdateAvailableEvent
  | SecurityFileExposedEvent
  | DigestWeeklyEvent;

export type BusEventType = BusEvent["type"];

/**
 * Flat list of all event type strings. Useful for validation and UI rendering.
 */
export const ALL_EVENT_TYPES: BusEventType[] = Object.values(EVENT_CATEGORIES).flat() as BusEventType[];
