import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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

export type LeaderLeaseRow = typeof leaderLeases.$inferSelect;
export type WorkerRow = typeof workers.$inferSelect;
export type JobHeartbeatRow = typeof jobHeartbeats.$inferSelect;
