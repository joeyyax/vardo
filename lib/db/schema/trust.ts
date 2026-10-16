import { integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Text columns: adding a visibility or check state needs no migration.

/** The instance's single trust center settings row. */
export const trustSettings = pgTable("trust_settings", {
  id: text("id").primaryKey().default("instance"),
  /** "off", "private" or "public". */
  visibility: text("visibility").notNull().default("off"),
  /** Provider and region the operator set by hand. Wins over detection. */
  hostingOverride: jsonb("hosting_override").$type<{ provider: string; region: string }>(),
  /** What the last run read from cloud metadata. */
  hostingDetected: jsonb("hosting_detected").$type<{ provider: string; region: string | null; location: string | null }>(),
  /** The instance domain that serves /trust. Set before the page can go public. */
  domain: text("domain"),
  /** The name the public page uses. Null falls back to the instance name. */
  name: text("name"),
  /** The operator's switch and value per commitment id. */
  commitments: jsonb("commitments").$type<Record<string, { enabled?: boolean; amount?: number | null }>>().notNull().default({}),
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
  /** Share of the check's weight earned, 0 to 1. Set on partial results. */
  credit: real("credit"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

/** One row per check run: the score, the maximum and each check's weight at the time. */
export const trustRuns = pgTable("trust_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  ranAt: timestamp("ran_at").defaultNow().notNull(),
  score: integer("score").notNull(),
  max: integer("max").notNull(),
  /** Check id to weight, for every check that ran. */
  weights: jsonb("weights").$type<Record<string, number>>().notNull(),
});
