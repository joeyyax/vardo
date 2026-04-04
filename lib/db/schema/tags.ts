import {
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { apps } from "./apps";

// ---------------------------------------------------------------------------
// Tags (flat labels for filtering)
// ---------------------------------------------------------------------------

export const tags = pgTable(
  "tag",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("tag_org_name_uniq").on(t.organizationId, t.name)]
);

export const appTags = pgTable(
  "app_tag",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [unique("app_tag_uniq").on(t.appId, t.tagId)]
);
