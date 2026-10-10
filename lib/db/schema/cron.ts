import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { cronJobRunStatusEnum, cronJobStatusEnum, cronJobTypeEnum } from "./enums";
import { apps } from "./apps";
import { organizations } from "./organizations";

// An org-level job has no app and can only be a URL job.
export const cronJobs = pgTable(
  "cron_job",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: cronJobTypeEnum("type").notNull().default("command"),
    schedule: text("schedule").notNull(), // cron expression
    // IANA zone the schedule runs in. Null is the server's zone, UTC in the stock image.
    timeZone: text("time_zone"),
    command: text("command").notNull(), // Shell command or URL, by type
    method: text("method").notNull().default("GET"),
    // Encrypted JSON list of { name, value }.
    headers: text("headers"),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    retries: integer("retries").notNull().default(0),
    // Codes, classes or ranges, e.g. "2xx" or "200,204". Null means 2xx.
    expectedStatus: text("expected_status"),
    enabled: boolean("enabled").default(true).notNull(),
    lastRunAt: timestamp("last_run_at"),
    lastStatus: cronJobStatusEnum("last_status"),
    lastLog: text("last_log"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("cron_job_org_idx").on(t.organizationId),
    check("cron_job_command_needs_app", sql`type <> 'command' OR app_id IS NOT NULL`),
  ]
);

// Cron job execution history.

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
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    attempts: integer("attempts"),
    output: text("output"),
    error: text("error"),
  },
  (t) => [index("cron_job_run_job_id_idx").on(t.cronJobId)]
);
