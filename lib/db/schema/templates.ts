import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { deployTypeEnum, sourceEnum, templateCategoryEnum } from "./enums";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templates = pgTable("template", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  icon: text("icon"),
  category: templateCategoryEnum("category").notNull().default("custom"),
  source: sourceEnum("source").notNull().default("direct"),
  deployType: deployTypeEnum("deploy_type").notNull().default("image"),
  imageName: text("image_name"),
  gitUrl: text("git_url"),
  gitBranch: text("git_branch"),
  composeContent: text("compose_content"),
  rootDirectory: text("root_directory"),
  defaultPort: integer("default_port"),
  defaultEnvVars: jsonb("default_env_vars").$type<
    { key: string; description: string; required: boolean; defaultValue?: string }[]
  >(),
  defaultVolumes: jsonb("default_volumes").$type<
    { name: string; mountPath: string; description: string }[]
  >(),
  defaultConnectionInfo: jsonb("default_connection_info").$type<
    { label: string; value: string; copyRef?: string }[]
  >(),
  isBuiltIn: boolean("is_built_in").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
