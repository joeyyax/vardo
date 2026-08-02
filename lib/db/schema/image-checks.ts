import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

/**
 * Registry facts, cached per image reference rather than per app so several
 * apps on the same image cost one request. Not org-scoped — nothing here is
 * tenant data, and sharing it keeps registry traffic down.
 */
export const imageUpdateChecks = pgTable(
  "image_update_check",
  {
    /** Normalized `registry/repository:tag`. */
    imageRef: text("image_ref").primaryKey(),
    status: text("status", {
      enum: ["current", "update", "drift", "unknown"],
    })
      .notNull()
      .default("unknown"),
    /** Newer tag we can defend, for pinned refs. */
    latestTag: text("latest_tag"),
    severity: text("severity", {
      enum: ["patch", "minor", "major", "build", "unknown"],
    }),
    /** Manifest-list digest the tag resolved to at check time. */
    remoteDigest: text("remote_digest"),
    /** Tags we could not order, surfaced so a miss is visible. */
    unorderable: jsonb("unorderable").$type<string[]>().default([]),
    /** Newer tags to choose from, newest first. */
    available: jsonb("available").$type<string[]>().default([]),
    /** Newest tag crossing a major, when the image's data dir is major-locked. */
    majorAvailable: text("major_available"),
    /** Whether a major bump means migrating a data directory. */
    majorLocked: boolean("major_locked").default(false).notNull(),
    /** Why the check could not answer. Null on success. */
    error: text("error"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (t) => [index("image_update_check_checked_at_idx").on(t.checkedAt)],
);

/**
 * Updates the org has chosen not to be told about, one row per app and compose
 * service. Org-scoped, unlike the check cache: this is a decision, not a fact.
 */
export const imageUpdateIgnores = pgTable(
  "image_update_ignore",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /** Compose service the rule covers. Null for a single-image app. */
    composeService: text("compose_service"),
    /** `major` still surfaces patch and minor bumps. */
    scope: text("scope", { enum: ["all", "major"] }).notNull().default("all"),
    /** When the rule lapses. Null never lapses. */
    expiresAt: timestamp("expires_at"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // One rule per target, so re-ignoring replaces rather than stacks. A
    // single-image app has no service, and two nulls must collide.
    unique("image_update_ignore_target_key")
      .on(t.appId, t.composeService)
      .nullsNotDistinct(),
    index("image_update_ignore_org_idx").on(t.organizationId),
  ],
);
