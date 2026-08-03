import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { user } from "./auth";
import { deploymentStatusEnum, deploymentTriggerEnum } from "./enums";
import { apps } from "./apps";
import { environments, groupEnvironments } from "./environments";

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

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
  // Execution time only, clocked from the moment runDeployment starts. Always
  // shorter than finishedAt - startedAt, which also covers the queue wait.
  durationMs: integer("duration_ms"),
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
  // Snapshot fields — captured on successful deploy for rollback
  envSnapshot: text("env_snapshot"), // Encrypted env blob at deploy time (AES-256-GCM)
  configSnapshot: jsonb("config_snapshot").$type<ConfigSnapshot>(),
  // On an auto-rollback, the deploy that crashed. On a manual or instant
  // rollback, the deploy whose version was restored.
  rollbackFromId: text("rollback_from_id"),
  // Post-deploy work a successful deploy did not finish (hooks, notifications,
  // the old slot's stop). The row stays "success" — the release is serving.
  postDeployError: text("post_deploy_error"),
  slot: text("slot"),
  // ID of the deployment that superseded this one (set when status = "superseded")
  supersededBy: text("superseded_by").references((): AnyPgColumn => deployments.id, {
    onDelete: "set null",
  }),
  // Stamped at INSERT while the row is still queued, and never re-stamped, so
  // this is enqueue time rather than the moment execution began.
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
},
  (t) => [
    index("deployment_app_id_idx").on(t.appId),
    index("deployment_app_started_at_idx").on(t.appId, t.startedAt),
    index("deployment_app_status_slot_idx").on(t.appId, t.status, t.slot),
  ]
);
