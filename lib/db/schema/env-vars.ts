import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { environments } from "./environments";

export const envVars = pgTable(
  "env_var",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(), // Encrypted
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    isSecret: boolean("is_secret").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_var_app_key_env_uniq").on(t.appId, t.key, t.environmentId)]
);
