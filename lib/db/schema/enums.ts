import { pgEnum } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

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
