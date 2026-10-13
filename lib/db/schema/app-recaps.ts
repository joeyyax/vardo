import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

// A new app's 72-hour and 30-day recaps. One row per app and kind; it stays once finished so a redeploy never re-arms it.
export const appRecaps = pgTable(
  "app_recap",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // "72h" or "30d".
    kind: text("kind", { enum: ["72h", "30d"] }).notNull(),
    // The first successful production deploy.
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "sent", "stopped" or "skipped". Null while pending.
    outcome: text("outcome", { enum: ["sent", "stopped", "skipped"] }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.appId, t.kind] }), index("app_recap_due_idx").on(t.dueAt)],
);

export type AppRecapRow = typeof appRecaps.$inferSelect;
