import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { apps } from "./apps";

// Whole-instance restores. Written after Vardo's own database is back, so the queue survives restarts.

export const instanceRestores = pgTable("instance_restore", {
  id: text("id").primaryKey(),
  /** running, then finished. */
  status: text("status", { enum: ["running", "finished"] }).notNull().default("running"),
  /** Storage key of the system backup the instance was restored from. */
  systemBackupKey: text("system_backup_key").notNull(),
  /** When that backup was taken. App archives are picked at or before it. */
  systemBackupAt: timestamp("system_backup_at").notNull(),
  databaseLog: text("database_log"),
  /** Jobs this restore switched off, so resuming turns back on only those. */
  pausedBackupJobIds: jsonb("paused_backup_job_ids").$type<string[]>().notNull().default([]),
  pausedCronJobIds: jsonb("paused_cron_job_ids").$type<string[]>().notNull().default([]),
  resumedAt: timestamp("resumed_at"),
  startedAt: timestamp("started_at").notNull(),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RestoreAppStatus = "queued" | "restoring" | "deploying" | "done" | "failed" | "deferred";

/** One archive an app restores from. */
export type RestoreArchivePlan = {
  backupId: string;
  appId: string;
  appName: string;
  volumeName: string;
  strategy: "tar" | "dump";
  finishedAt: string;
};

export const instanceRestoreApps = pgTable(
  "instance_restore_app",
  {
    id: text("id").primaryKey(),
    restoreId: text("restore_id")
      .notNull()
      .references(() => instanceRestores.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    organizationId: text("organization_id").notNull(),
    priority: text("priority").notNull(),
    /** Share of the concurrency budget. Builds from source weigh more than image pulls. */
    weight: integer("weight").notNull().default(1),
    /** Queue order. Lower runs first. */
    position: integer("position").notNull(),
    /** App ids that settle before this one starts. */
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    status: text("status", {
      enum: ["queued", "restoring", "deploying", "done", "failed", "deferred"],
    })
      .$type<RestoreAppStatus>()
      .notNull()
      .default("queued"),
    /** Whether the app was running in the backup, so it's redeployed. */
    redeploy: boolean("redeploy").notNull().default(true),
    archives: jsonb("archives").$type<RestoreArchivePlan[]>().notNull().default([]),
    error: text("error"),
    log: text("log"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("instance_restore_app_restore_idx").on(t.restoreId, t.status)],
);
