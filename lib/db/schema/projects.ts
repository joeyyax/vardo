import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Projects (groups of related apps)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    color: text("color").default("#6366f1"),
    allowBindMounts: boolean("allow_bind_mounts").default(false).notNull(),
    isSystemManaged: boolean("is_system_managed").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("project_org_name_uniq").on(t.organizationId, t.name)]
);
