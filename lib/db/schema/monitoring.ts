import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { activityFamilyEnum, activityOutcomeEnum } from "./enums";

// Audit trail.

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
    /** Written by recordActivity. Null on rows predating the column. */
    family: activityFamilyEnum("family"),
    outcome: activityOutcomeEnum("outcome"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("activity_org_created_at_idx").on(t.organizationId, t.createdAt),
    index("activity_org_family_created_at_idx").on(
      t.organizationId,
      t.family,
      t.createdAt
    ),
    index("activity_org_outcome_created_at_idx").on(
      t.organizationId,
      t.outcome,
      t.createdAt
    ),
    index("activity_app_created_at_idx").on(t.appId, t.createdAt),
  ]
);

/**
 * Health monitor restart budget per container id, plus the marker written when it gives up.
 * A recreate mints a new id and a fresh budget.
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

/** Auto memory profile state per app: what it last set, when and why. */
export const appMemoryAutotune = pgTable("app_memory_autotune", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** The limit auto-adjust last wrote, in MB. A different app limit means a person changed it. */
  appliedMb: integer("applied_mb"),
  lastRaisedAt: timestamp("last_raised_at"),
  lastChangedAt: timestamp("last_changed_at"),
  /** Why the last change happened: "after an OOM kill". */
  lastReason: text("last_reason"),
  /** Raises since the app last ran a day without needing one. */
  raiseStreak: integer("raise_streak").notNull().default(0),
  /** Set when the streak hit the cap; auto-adjust stops until someone sets the limit. */
  haltedAt: timestamp("halted_at"),
  /** Highest memory use per day, newest last. */
  dailyPeaks: jsonb("daily_peaks").$type<{ day: string; bytes: number }[]>().notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
