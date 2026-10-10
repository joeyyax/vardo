import { pgEnum } from "drizzle-orm/pg-core";

export const sourceEnum = pgEnum("source", ["git", "direct"]);

export const deployTypeEnum = pgEnum("deploy_type", [
  "compose",
  "dockerfile",
  "image",
  "static",
  "nixpacks",
  "railpack",
]);

export const appStatusEnum = pgEnum("app_status", [
  "active",
  "stopped",
  "error",
  "deploying",
  // Registered in Vardo but no container exists on the host.
  "missing",
]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "rolled_back",
  "superseded",
]);

export const deploymentTriggerEnum = pgEnum("deployment_trigger", [
  "manual",
  "webhook",
  "api",
  "rollback",
  "relay",
  "poll",
]);

export const environmentTypeEnum = pgEnum("environment_type", [
  "production",
  "staging",
  "preview",
  "local",
]);

export const cloneStrategyEnum = pgEnum("clone_strategy", [
  "clone",
  "clone_data",
  "empty",
  "skip",
]);

export const appPriorityEnum = pgEnum("app_priority", [
  "critical",
  "standard",
  "disposable",
]);

export const groupEnvironmentTypeEnum = pgEnum("group_environment_type", [
  "staging",
  "preview",
]);

export const transferStatusEnum = pgEnum("transfer_status", [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
]);

export const notificationChannelTypeEnum = pgEnum("notification_channel_type", [
  "email",
  "webhook",
  "slack",
  "ntfy",
  "discord",
  "telegram",
  "pushover",
]);

export const meshPeerTypeEnum = pgEnum("mesh_peer_type", [
  "persistent",
  "dev",
]);

export const meshPeerStatusEnum = pgEnum("mesh_peer_status", [
  "online",
  "offline",
  "unreachable",
]);

export const meshPeerConnectionTypeEnum = pgEnum("mesh_peer_connection_type", [
  "direct",
  "visible",
]);

export const backupTargetTypeEnum = pgEnum("backup_target_type", [
  "s3",
  "r2",
  "b2",
  "ssh",
  "local",
]);

export const backupStatusEnum = pgEnum("backup_status", [
  "pending",
  "running",
  "success",
  "failed",
  // Source the engine cannot capture, e.g. a bind mount. Not a failure.
  "skipped",
  "pruned",
]);

export const templateCategoryEnum = pgEnum("template_category", [
  "database",
  "cache",
  "monitoring",
  "web",
  "tool",
  "custom",
]);

export const cronJobTypeEnum = pgEnum("cron_job_type", [
  "command",
  "url",
]);

export const cronJobStatusEnum = pgEnum("cron_job_status", [
  "success",
  "failed",
  "running",
]);

export const cronJobRunStatusEnum = pgEnum("cron_job_run_status", [
  "success",
  "failed",
]);

export const invitationScopeEnum = pgEnum("invitation_scope", [
  "platform",
  "org",
  "project",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

// Must match ActivityFamily/ActivityOutcome (tests/unit/lib/activity/taxonomy.test.ts).
export const activityFamilyEnum = pgEnum("activity_family", [
  "deploy",
  "backup",
  "cron",
  "app",
  "domain",
  "security",
  "system",
  "org",
]);

export const activityOutcomeEnum = pgEnum("activity_outcome", [
  "success",
  "failure",
  "neutral",
]);

/** How Vardo treats an app's limit: as set, as a baseline plus a ceiling, or tuned over time. */
export const RESOURCE_PROFILES = ["fixed", "burstable", "auto"] as const;
export type ResourceProfile = (typeof RESOURCE_PROFILES)[number];

/** What a service is for. Decides which dependencies nest under the app using them. */
export const SERVICE_KINDS = ["database", "cache", "worker", "web", "other"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const UI_DENSITIES = ["comfortable", "dense"] as const;
export type UiDensity = (typeof UI_DENSITIES)[number];
