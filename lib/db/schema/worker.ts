import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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

export type LeaderLeaseRow = typeof leaderLeases.$inferSelect;
export type JobHeartbeatRow = typeof jobHeartbeats.$inferSelect;
