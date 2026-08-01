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

// ---------------------------------------------------------------------------
// Self-heal state (survives a Vardo restart)
// ---------------------------------------------------------------------------

/**
 * Restart budget the health monitor spends when auto-restarting an unhealthy
 * container, plus the marker written when it gives up.
 *
 * Keyed by container id: `docker restart` keeps the id, a recreate mints a new
 * one and so gets a fresh budget. Rows are dropped once `updated_at` falls
 * outside the rolling window.
 */
export const containerSelfHeal = pgTable(
  "container_self_heal",
  {
    containerId: text("container_id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /** Epoch-ms restart timestamps inside the rolling window, ascending. */
    restarts: jsonb("restarts").$type<number[]>().notNull().default([]),
    /** Set when the cap is hit, cleared when the container reads healthy. */
    gaveUpAt: timestamp("gave_up_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("container_self_heal_updated_at_idx").on(t.updatedAt)]
);
