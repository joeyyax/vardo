import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    /** Why the check could not answer. Null on success. */
    error: text("error"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (t) => [index("image_update_check_checked_at_idx").on(t.checkedAt)],
);
