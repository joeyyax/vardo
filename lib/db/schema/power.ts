import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

export type PowerActionKind = "backups-skipped" | "deploys-held" | "deploy-override" | "apps-stopped" | "apps-restarted";

export type PowerActionDetail = { names?: string[]; ids?: string[]; failed?: string[] };

/** What a power policy did, for the Power page and its notices. Instance-level. */
export const powerActions = pgTable(
  "power_action",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<PowerActionKind>().notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    /** When the outage it acted in started. */
    outageStartedAt: timestamp("outage_started_at", { withTimezone: true }),
    /** When a notice went out for it. Null when it was folded into an earlier one. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    detail: jsonb("detail").$type<PowerActionDetail>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("power_action_created_idx").on(t.createdAt), index("power_action_kind_outage_idx").on(t.kind, t.outageStartedAt)],
);

export type PowerStopOutcome = "restarted" | "already-running" | "failed" | "gone";

/** An app the stop policy stopped. Open until power returns and it's restarted or left alone. */
export const powerStoppedApps = pgTable(
  "power_stopped_app",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    outageStartedAt: timestamp("outage_started_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    outcome: text("outcome").$type<PowerStopOutcome>(),
    error: text("error"),
  },
  (t) => [uniqueIndex("power_stopped_app_open_uniq").on(t.appId).where(sql`restored_at is null`)],
);

export type PowerActionRow = typeof powerActions.$inferSelect;
export type PowerStoppedAppRow = typeof powerStoppedApps.$inferSelect;
