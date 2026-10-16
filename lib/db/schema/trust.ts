import { boolean, customType, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  /** Whether Cloudflare fronts the instance's domains, and when Vardo last probed. */
  cloudflare: jsonb("cloudflare").$type<{ behind: boolean; checkedAt: string }>(),
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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Published documents: a reviewed policy text, or the uploaded agreement. Stored in the database, so system backups carry them. */
export const trustDocuments = pgTable("trust_document", {
  /** "backup", "access", "incident" or "dpa". */
  id: text("id").primaryKey(),
  /** The text the public page shows. Stays until the operator reviews a newer draft or unpublishes it. */
  reviewedBody: text("reviewed_body"),
  /** Set when the operator publishes. Null keeps the document off the public page. */
  reviewedAt: timestamp("reviewed_at"),
  /** Hash of the settings behind the reviewed text. A different hash now means the policy needs review. */
  basisHash: text("basis_hash"),
  /** The uploaded PDF. Only the agreement has one. */
  file: bytea("file"),
  fileSize: integer("file_size"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** A third party that can handle client data. Only confirmed rows reach the public page. */
export const trustSubprocessors = pgTable("trust_subprocessor", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Detection key such as backup:r2. Null for a subprocessor the operator added. */
  key: text("key").unique(),
  name: text("name").notNull(),
  purpose: text("purpose").notNull(),
  region: text("region"),
  /** "suggested", "confirmed" or "dismissed". */
  status: text("status").notNull().default("suggested"),
  /** The last detection still found it. A confirmed row that stops being detected stays listed until the operator removes it. */
  detected: boolean("detected").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
