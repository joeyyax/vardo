import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import type { StageTimings } from "@/lib/docker/stage-timings";
import type { BuildPlanRecord } from "@/lib/docker/build-plan";
import type { RebuildMode } from "@/lib/docker/build-key";
import type { DeployStage } from "@/lib/docker/deploy-logger";
import { user } from "./auth";
import { deploymentStatusEnum, deploymentTriggerEnum } from "./enums";
import { apps } from "./apps";
import { environments, groupEnvironments } from "./environments";

/** Deploy options with no column of their own, kept for the executor. */
export type DeployRequest = {
  rebuild?: RebuildMode;
  rollback?: { targetDeploymentId: string; includeEnvVars?: boolean };
  gitSha?: string;
  pinIntent?: "push" | "pin";
  /** Inserted without a scope until its requester releases it, so no executor claims it first. */
  held?: boolean;
};

export type DeployCancelReason = "user" | "supersede" | "timeout";

export const deployments = pgTable("deployment", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  status: deploymentStatusEnum("status").notNull().default("queued"),
  trigger: deploymentTriggerEnum("trigger").notNull(),
  gitSha: text("git_sha"),
  gitMessage: text("git_message"),
  log: text("log"),
  // Execution time from runDeployment start, excluding queue wait.
  durationMs: integer("duration_ms"),
  // Per-phase wall-clock times: clone, build, export, pull, up, healthWait, cleanup.
  stageTimings: jsonb("stage_timings").$type<StageTimings>(),
  // Railpack or Nixpacks plan, captured before the build.
  buildPlan: jsonb("build_plan").$type<BuildPlanRecord>(),
  // Hash of everything a repo build reads (lib/docker/build-key.ts). Equal keys build the same image.
  buildKey: text("build_key"),
  environmentId: text("environment_id").references(() => environments.id, {
    onDelete: "set null",
  }),
  groupEnvironmentId: text("group_environment_id").references(
    () => groupEnvironments.id,
    { onDelete: "set null" }
  ),
  triggeredBy: text("triggered_by").references(() => user.id, {
    onDelete: "set null",
  }),
  // Captured on a successful deploy for rollback.
  envSnapshot: text("env_snapshot"), // Encrypted
  configSnapshot: jsonb("config_snapshot").$type<ConfigSnapshot>(),
  // On an auto-rollback, the deploy that crashed. On a manual or instant
  // rollback, the deploy whose version was restored.
  rollbackFromId: text("rollback_from_id"),
  // Post-deploy work that didn't finish. The row stays "success" because the release is serving.
  postDeployError: text("post_deploy_error"),
  slot: text("slot"),
  supersededBy: text("superseded_by").references((): AnyPgColumn => deployments.id, {
    onDelete: "set null",
  }),
  // Enqueue time, stamped at insert.
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  // `appId`, or `appId:environmentId` off the default environment. Null on rows from before the queue.
  scopeKey: text("scope_key"),
  request: jsonb("request").$type<DeployRequest>(),
  // Stage in flight, written at each transition.
  stage: text("stage").$type<DeployStage>(),
  // Executor running the row.
  claimedBy: text("claimed_by"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attempts: smallint("attempts").notNull().default(0),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  cancelReason: text("cancel_reason").$type<DeployCancelReason>(),
  // Set while this deploy's swap needs every other deploy stopped. Blocks new claims.
  exclusiveRequestedAt: timestamp("exclusive_requested_at", { withTimezone: true }),
},
  (t) => [
    index("deployment_app_id_idx").on(t.appId),
    index("deployment_app_started_at_idx").on(t.appId, t.startedAt),
    index("deployment_app_status_slot_idx").on(t.appId, t.status, t.slot),
    index("deployment_app_build_key_idx").on(t.appId, t.buildKey),
    uniqueIndex("deployment_scope_running_uniq").on(t.scopeKey).where(sql`status = 'running'`),
    index("deployment_queued_idx").on(t.startedAt).where(sql`status = 'queued'`),
    index("deployment_exclusive_idx").on(t.exclusiveRequestedAt).where(sql`exclusive_requested_at is not null`),
  ]
);
