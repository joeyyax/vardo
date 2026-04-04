import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
  environmentTypeEnum,
  groupEnvironmentTypeEnum,
} from "./enums";
import { apps } from "./apps";
import { projects } from "./projects";

// ---------------------------------------------------------------------------
// Group Environments (staging/preview environments spanning a group)
// ---------------------------------------------------------------------------

export const groupEnvironments = pgTable(
  "group_environment",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: groupEnvironmentTypeEnum("type").notNull().default("staging"),
    sourceEnvironment: text("source_environment").default("production"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    createdBy: text("created_by").references(() => user.id),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("group_env_project_name_uniq").on(t.projectId, t.name)]
);

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const environments = pgTable(
  "environment",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: environmentTypeEnum("type").notNull().default("production"),
    domain: text("domain"),
    gitBranch: text("git_branch"),
    isDefault: boolean("is_default").default(false),
    clonedFromId: text("cloned_from_id"),
    groupEnvironmentId: text("group_environment_id").references(
      () => groupEnvironments.id,
      { onDelete: "cascade" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_app_name_uniq").on(t.appId, t.name)]
);
