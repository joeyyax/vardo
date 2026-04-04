import { boolean, jsonb, pgTable, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export const plugins = pgTable("plugin", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  category: text("category"),
  manifest: jsonb("manifest").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  builtIn: boolean("built_in").notNull().default(false),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Plugin Settings (per-org or system-level)
// ---------------------------------------------------------------------------

export const pluginSettings = pgTable(
  "plugin_setting",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("plugin_setting_uniq").on(t.pluginId, t.organizationId, t.key),
    index("plugin_setting_plugin_idx").on(t.pluginId),
  ],
);
