import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apps } from "./apps";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Volumes (first-class volume records with integrated limits)
// ---------------------------------------------------------------------------

export const volumes = pgTable(
  "volume",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // e.g. "data", "uploads"
    mountPath: text("mount_path").notNull(), // e.g. "/var/lib/postgresql/data"
    type: text("type", { enum: ["named", "bind"] }).notNull().default("named"), // mount type — persisted so bind mounts display correctly when container is stopped
    source: text("source"), // nullable — host path for bind mounts, Docker volume name for named; persisted so Host: label survives container stop
    persistent: boolean("persistent").default(true).notNull(), // survives deploys
    shared: boolean("shared").default(false).notNull(), // can be mounted by other apps in project
    description: text("description"),
    maxSizeBytes: bigint("max_size_bytes", { mode: "number" }), // nullable = no limit
    warnAtPercent: integer("warn_at_percent").default(80),
    ignorePatterns: jsonb("ignore_patterns").$type<string[]>(), // glob patterns to ignore in diff (e.g. "uploads/**")
    driftCount: integer("drift_count").default(0), // unignored file drift after last deploy
    // Backup strategy: "tar" (default) for file volumes, "dump" for databases
    backupStrategy: text("backup_strategy").default("tar").notNull(),
    // For "dump" strategy: { dumpCmd, restoreCmd } — shell commands run via docker exec
    backupMeta: jsonb("backup_meta").$type<{ dumpCmd: string; restoreCmd: string }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("volume_app_name_uniq").on(t.appId, t.name),
    unique("volume_app_mount_uniq").on(t.appId, t.mountPath),
    index("volume_app_id_idx").on(t.appId),
    index("volume_org_id_idx").on(t.organizationId),
    check("volume_dump_requires_meta", sql`backup_strategy != 'dump' OR backup_meta IS NOT NULL`),
  ]
);

// DEPRECATED: kept for migration only — will be dropped after migrate-volumes.ts runs
export const volumeLimits = pgTable("volume_limit", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" })
    .unique(),
  maxSizeBytes: bigint("max_size_bytes", { mode: "number" }).notNull(),
  warnAtPercent: integer("warn_at_percent").default(80),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
