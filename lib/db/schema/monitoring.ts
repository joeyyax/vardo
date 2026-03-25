import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { apps } from "./apps";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Activities (audit trail)
// ---------------------------------------------------------------------------

export const activities = pgTable(
  "activity",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("activity_org_created_at_idx").on(t.organizationId, t.createdAt),
  ]
);
