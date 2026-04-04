import { boolean, integer, jsonb, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { apps } from "./apps";

// ---------------------------------------------------------------------------
// Hook Registrations
//
// Lifecycle hooks that intercept actions at defined points.
// before.* hooks are blocking filters (can approve/reject).
// after.* hooks are informational (stream events, can't block).
// ---------------------------------------------------------------------------

export const hookRegistrations = pgTable(
  "hook_registration",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(
      () => organizations.id,
      { onDelete: "cascade" },
    ),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    event: text("event").notNull(), // e.g. "before.deploy.start"
    name: text("name").notNull(),
    type: text("type").notNull(), // "webhook" | "script" | "internal"
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    priority: integer("priority").notNull().default(100),
    failMode: text("fail_mode").notNull().default("fail"), // "fail" | "warn" | "ignore"
    enabled: boolean("enabled").notNull().default(true),
    builtIn: boolean("built_in").notNull().default(false), // built-ins can be disabled but not deleted
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("hook_registration_event_idx").on(t.event, t.enabled),
    index("hook_registration_org_idx").on(t.organizationId),
  ],
);
