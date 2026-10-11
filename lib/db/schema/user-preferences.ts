import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { apps } from "./apps";
import { PROJECT_SORTS, STAR_KINDS, UI_DENSITIES } from "./enums";

// Interface settings that follow a user across devices.
export const userPreferences = pgTable("user_preference", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  density: text("density", { enum: UI_DENSITIES }).notNull().default("comfortable"),
  projectSort: text("project_sort", { enum: PROJECT_SORTS }).notNull().default("attention"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// A user's starred projects and apps, listed first.
export const userStars = pgTable(
  "user_star",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: STAR_KINDS }).notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("user_star_project_uniq").on(t.userId, t.projectId),
    uniqueIndex("user_star_app_uniq").on(t.userId, t.appId),
    index("user_star_user_org_idx").on(t.userId, t.organizationId),
    check(
      "user_star_one_target",
      sql`(${t.kind} = 'project' AND ${t.projectId} IS NOT NULL AND ${t.appId} IS NULL) OR (${t.kind} = 'app' AND ${t.appId} IS NOT NULL AND ${t.projectId} IS NULL)`,
    ),
  ],
);
