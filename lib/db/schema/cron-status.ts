import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

// An org's public cron status page. No row, or enabled off, and its routes 404.
export const cronStatusPages = pgTable("cron_status_page", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  token: text("token").notNull().unique(),
  // Serves the page at this host's root. Set by an instance admin.
  hostname: text("hostname").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CronStatusPage = typeof cronStatusPages.$inferSelect;
