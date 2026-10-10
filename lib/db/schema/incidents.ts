import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

// One problem Vardo notified about, from first notice to recovery.

export const incidents = pgTable(
  "incident",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `<subjectType>:<subject>:<kind>`, stable across reopenings. */
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    appId: text("app_id"),
    /** Wording at open, kept for a constant subject line. */
    title: text("title").notNull(),
    severity: text("severity").notNull(),
    peakSeverity: text("peak_severity").notNull(),
    state: text("state").$type<"open" | "resolved">().notNull(),
    openedAt: timestamp("opened_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    updateCount: integer("update_count").default(0).notNull(),
    reopenCount: integer("reopen_count").default(0).notNull(),
    lastNotifiedState: text("last_notified_state"),
    lastNotifiedAt: timestamp("last_notified_at"),
    /** Provider message id per notification channel, for edits and replies. */
    channelMessages: jsonb("channel_messages").$type<Record<string, string>>().default({}).notNull(),
  },
  (t) => [
    uniqueIndex("incident_open_key_uniq").on(t.organizationId, t.key).where(sql`${t.state} = 'open'`),
    index("incident_org_key_idx").on(t.organizationId, t.key, t.resolvedAt),
    index("incident_org_state_idx").on(t.organizationId, t.state, t.updatedAt),
  ],
);

export type IncidentRow = typeof incidents.$inferSelect;
