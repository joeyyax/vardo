import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BackupResultItem, BackupRunPlan } from "@/lib/backups/run-rules";
import { backupStatusEnum, backupTargetTypeEnum } from "./enums";
import { organizations } from "./organizations";
import { apps } from "./apps";
import { volumes } from "./volumes";
import { jsonb } from "drizzle-orm/pg-core";

// Where backups are stored.

export const backupTargets = pgTable("backup_target", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  type: backupTargetTypeEnum("type").notNull(),
  config: jsonb("config")
    .notNull()
    .$type<
      | {
          bucket: string;
          region: string;
          endpoint?: string;
          accessKeyId: string;
          secretAccessKey: string;
          prefix?: string;
        }
      | {
          host: string;
          port?: number;
          username: string;
          privateKey?: string;
          path: string;
        }
      | {
          path: string;
        }
    >(),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Scheduled backup configurations.

export const backupJobs = pgTable("backup_job", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .references(() => organizations.id, { onDelete: "cascade" }),
  // Deleting a target with jobs or backups is an explicit choice, never a cascade.
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id),
  name: text("name").notNull(),
  schedule: text("schedule").notNull().default("0 2 * * *"),
  enabled: boolean("enabled").default(true).notNull(),
  keepAll: boolean("keep_all").default(false),
  keepLast: integer("keep_last"),
  keepHourly: integer("keep_hourly"),
  keepDaily: integer("keep_daily"),
  keepWeekly: integer("keep_weekly"),
  keepMonthly: integer("keep_monthly"),
  keepYearly: integer("keep_yearly"),
  notifyOnSuccess: boolean("notify_on_success").default(false),
  notifyOnFailure: boolean("notify_on_failure").default(true),
  // Runs in the org's nightly run, not on its own schedule. The schedule mirrors the nightly time.
  nightly: boolean("nightly").default(false).notNull(),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Apps included in a backup job.
export const backupJobApps = pgTable(
  "backup_job_app",
  {
    backupJobId: text("backup_job_id")
      .notNull()
      .references(() => backupJobs.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.backupJobId, t.appId] })]
);

// Volumes linked directly to a backup job, such as system volumes.
export const backupJobVolumes = pgTable(
  "backup_job_volume",
  {
    backupJobId: text("backup_job_id")
      .notNull()
      .references(() => backupJobs.id, { onDelete: "cascade" }),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.backupJobId, t.volumeId] })]
);

// Individual backup runs.

export const backups = pgTable("backup", {
  id: text("id").primaryKey(),
  // Null once the job is deleted; the history stays.
  jobId: text("job_id").references(() => backupJobs.id, { onDelete: "set null" }),
  jobName: text("job_name"),
  // No foreign key: history outlives the app. Null means a system volume; never SET NULL.
  appId: text("app_id"),
  // Snapshots of the app at backup time.
  appName: text("app_name"),
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  // Deleting a target with jobs or backups is an explicit choice, never a cascade.
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id),
  status: backupStatusEnum("status").notNull().default("pending"),
  volumeName: text("volume_name"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  storagePath: text("storage_path"),
  // Archive format as written ("tar" | "dump"). Restore reads this, never the volume's current config.
  strategy: text("strategy"),
  checksum: text("checksum"), // sha256 of the archive before upload
  // Host path a bind archive was taken from. Restore compares against this, not the volume row.
  resolvedSource: text("resolved_source"),
  // "directory" or "file" for a bind archive. Restore refuses a destination of another shape.
  sourceKind: text("source_kind"),
  // Master key fingerprint on Vardo's own database dump only. Restore refuses a mismatch with the running key.
  keyFingerprint: text("key_fingerprint"),
  // The archive's data key wrapped by the master key (base64). Null for a plaintext archive and once pruned.
  archiveKey: text("archive_key"),
  // Fingerprint of the key that wrapped archiveKey.
  archiveKeyFingerprint: text("archive_key_fingerprint"),
  // Paths this archive left out, relative to the volume root. Restore keeps the live copies.
  // Recorded per archive and never re-derived, or dropped patterns lose data.
  excludedPaths: jsonb("excluded_paths").$type<string[]>(),
  // User tables in the source database at backup time. Null when not counted.
  sourceTableCount: integer("source_table_count"),
  // "initial" or "import" for a first snapshot. Null for a scheduled or manual run.
  trigger: text("trigger"),
  // Restore drill results.
  verifiedAt: timestamp("verified_at"),
  verifyOutcome: text("verify_outcome"),
  verifyDetail: text("verify_detail"),
  log: text("log"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

// A pending first snapshot of an app. One row per app; it stays once finished so a redeploy never re-arms it.
export const initialBackups = pgTable("initial_backup", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  // "deploy" or "import".
  reason: text("reason").notNull(),
  // Start of the healthy window the run waits out.
  armedAt: timestamp("armed_at").notNull(),
  dueAt: timestamp("due_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  // "success", "covered", "skipped" or "expired". Null while pending.
  outcome: text("outcome"),
  finishedAt: timestamp("finished_at"),
});

// One run of backups with a start notice and a completion summary: the org's nightly run, or a long job.
export const backupRuns = pgTable(
  "backup_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // "nightly", "job" or "restore".
    kind: text("kind").notNull(),
    // Unique per org, so a run starts once: `nightly:2026-10-10`, `job:<id>:<minute>`.
    runKey: text("run_key").notNull(),
    label: text("label").notNull(),
    startedAt: timestamp("started_at").notNull(),
    estimatedMs: integer("estimated_ms"),
    // Sends the summary by then even if jobs never report.
    deadlineAt: timestamp("deadline_at").notNull(),
    finishedAt: timestamp("finished_at"),
    plan: jsonb("plan").$type<BackupRunPlan>().notNull(),
    jobsDone: jsonb("jobs_done").$type<string[]>().default([]).notNull(),
    items: jsonb("items").$type<BackupResultItem[]>().default([]).notNull(),
  },
  (t) => [
    uniqueIndex("backup_run_key_idx").on(t.organizationId, t.runKey),
    index("backup_run_open_idx").on(t.organizationId).where(sql`${t.finishedAt} is null`),
  ],
);
