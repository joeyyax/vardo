import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

// Background loop coordination. Every time here comes from the database clock.

/** One leader per singleton loop. `epoch` rises on each change of holder, fencing a stale one. */
export const leaderLeases = pgTable("leader_lease", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).defaultNow().notNull(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Last run of each loop, whichever process ran it. */
export const jobHeartbeats = pgTable("job_heartbeat", {
  name: text("name").primaryKey(),
  role: text("role").notNull(),
  holder: text("holder"),
  intervalMs: integer("interval_ms").notNull(),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }).defaultNow().notNull(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
});

/** Containers stopped on purpose. Self-heal leaves them until released or expired. */
export const containerHolds = pgTable("container_hold", {
  containerId: text("container_id").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One row per worker process, beating every 10s. Web defers its loops while a ready one is fresh. */
export const workers = pgTable("worker", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  slot: text("slot"),
  gitSha: text("git_sha"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  drainingAt: timestamp("draining_at", { withTimezone: true }),
  /** Set from outside to ask the worker to stop claiming work. */
  drainRequestedAt: timestamp("drain_requested_at", { withTimezone: true }),
  /** Loops with a pass running at the last beat. */
  inFlight: jsonb("in_flight").$type<string[]>().notNull().default([]),
});

export type WorkerJobKind = "deploy-group";
export type WorkerJobStatus = "queued" | "running" | "success" | "failed" | "cancelled";

/** Jobs a worker claims from Postgres. */
export const workerJobs = pgTable(
  "worker_job",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<WorkerJobKind>().notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<WorkerJobStatus>().notNull().default("queued"),
    scopeKey: text("scope_key"),
    claimedBy: text("claimed_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("worker_job_queued_idx").on(t.createdAt).where(sql`status = 'queued'`)],
);

export type WorkerJobRow = typeof workerJobs.$inferSelect;
export type LeaderLeaseRow = typeof leaderLeases.$inferSelect;
export type WorkerRow = typeof workers.$inferSelect;
export type JobHeartbeatRow = typeof jobHeartbeats.$inferSelect;
