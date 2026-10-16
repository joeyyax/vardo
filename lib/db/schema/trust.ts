import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Text columns: adding a visibility or check state needs no migration.

/** The instance's single trust center settings row. */
export const trustSettings = pgTable("trust_settings", {
  id: text("id").primaryKey().default("instance"),
  /** "off" or "private". */
  visibility: text("visibility").notNull().default("off"),
  /** Provider and region the operator set by hand. Wins over detection. */
  hostingOverride: jsonb("hosting_override").$type<{ provider: string; region: string }>(),
  /** What the last run read from cloud metadata. */
  hostingDetected: jsonb("hosting_detected").$type<{ provider: string; region: string | null; location: string | null }>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** The latest result of each check, overwritten by every run. */
export const trustChecks = pgTable("trust_check", {
  id: text("id").primaryKey(),
  /** "passing", "partial", "failing" or "unknown". */
  state: text("state").notNull(),
  evidence: text("evidence").notNull(),
  /** The next-step title when the state needs one other than the check's default. */
  fix: text("fix"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});
