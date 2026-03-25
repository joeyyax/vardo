import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { cronJobRunStatusEnum, cronJobStatusEnum, cronJobTypeEnum } from "./enums";
import { apps } from "./apps";

// ---------------------------------------------------------------------------
// Cron Jobs (scheduled tasks)
// ---------------------------------------------------------------------------

export const cronJobs = pgTable("cron_job", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: cronJobTypeEnum("type").notNull().default("command"),
  schedule: text("schedule").notNull(), // cron expression
  command: text("command").notNull(), // shell command or URL depending on type
  enabled: boolean("enabled").default(true).notNull(),
  lastRunAt: timestamp("last_run_at"),
  lastStatus: cronJobStatusEnum("last_status"),
  lastLog: text("last_log"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Cron Job Runs (execution history)
// ---------------------------------------------------------------------------

export const cronJobRuns = pgTable(
  "cron_job_run",
  {
    id: text("id").primaryKey(),
    cronJobId: text("cron_job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    status: cronJobRunStatusEnum("status").notNull(),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at"),
    output: text("output"),
    error: text("error"),
  },
  (t) => [index("cron_job_run_job_id_idx").on(t.cronJobId)]
);
