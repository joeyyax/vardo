import {
  bigint,
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { backupStatusEnum, backupTargetTypeEnum } from "./enums";
import { organizations } from "./organizations";
import { apps, volumes } from "./apps";
import { jsonb } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Backup Targets (where backups are stored)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Backup Jobs (scheduled backup configurations)
// ---------------------------------------------------------------------------

export const backupJobs = pgTable("backup_job", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .references(() => organizations.id, { onDelete: "cascade" }),
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  schedule: text("schedule").notNull().default("0 2 * * *"),
  enabled: boolean("enabled").default(true).notNull(),
  // Proxmox-style retention
  keepAll: boolean("keep_all").default(false),
  keepLast: integer("keep_last"),
  keepHourly: integer("keep_hourly"),
  keepDaily: integer("keep_daily"),
  keepWeekly: integer("keep_weekly"),
  keepMonthly: integer("keep_monthly"),
  keepYearly: integer("keep_yearly"),
  // Notification settings
  notifyOnSuccess: boolean("notify_on_success").default(false),
  notifyOnFailure: boolean("notify_on_failure").default(true),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Many-to-many: which apps are included in a backup job
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

// Many-to-many: direct volume links for backup jobs (system volumes, etc.)
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

// ---------------------------------------------------------------------------
// Backup History (individual backup runs)
// ---------------------------------------------------------------------------

export const backups = pgTable("backup", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => backupJobs.id, { onDelete: "cascade" }),
  appId: text("app_id")
    .references(() => apps.id, { onDelete: "cascade" }),
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id, { onDelete: "cascade" }),
  status: backupStatusEnum("status").notNull().default("pending"),
  volumeName: text("volume_name"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  storagePath: text("storage_path"),
  checksum: text("checksum"), // sha256 hash of the archive before upload
  log: text("log"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});
