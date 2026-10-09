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
    type: text("type", { enum: ["named", "bind"] }).notNull().default("named"),
    source: text("source"), // Host path for bind mounts, Docker volume name for named
    persistent: boolean("persistent").default(true).notNull(), // survives deploys
    shared: boolean("shared").default(false).notNull(), // can be mounted by other apps in project
    description: text("description"),
    maxSizeBytes: bigint("max_size_bytes", { mode: "number" }), // nullable = no limit
    warnAtPercent: integer("warn_at_percent").default(80),
    ignorePatterns: jsonb("ignore_patterns").$type<string[]>(), // Globs to ignore in diff (e.g. "uploads/**")
    // Paths a backup leaves out. Never reuse ignorePatterns: those mark runtime state, which backups must keep.
    backupExcludePatterns: jsonb("backup_exclude_patterns").$type<string[]>(),
    driftCount: integer("drift_count").default(0), // unignored file drift after last deploy
    // Whether the contents are irreplaceable. Null means unclassified and is backed up.
    durability: text("durability", {
      enum: ["stateful", "rebuildable", "external"],
    }),
    // Whether a backup job captures this volume. Null follows the legacy rule (persistent or stateful).
    backupSelection: text("backup_selection", { enum: ["include", "exclude"] }),
    // "tar" for file volumes, "dump" for databases.
    backupStrategy: text("backup_strategy").default("tar").notNull(),
    // Legacy dump commands run via docker exec. Container names carry the blue/green slot, so prefer backupSpec.
    backupMeta: jsonb("backup_meta").$type<{ dumpCmd: string; restoreCmd: string }>(),
    // Dump target, resolved to a container and credentials at backup time.
    backupSpec: jsonb("backup_spec").$type<{
      kind: "postgres" | "mysql" | "mariadb" | "mongo" | "uptime-kuma";
      service: string;
    }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("volume_app_name_uniq").on(t.appId, t.name),
    unique("volume_app_mount_uniq").on(t.appId, t.mountPath),
    index("volume_app_id_idx").on(t.appId),
    index("volume_org_id_idx").on(t.organizationId),
    check(
      "volume_dump_requires_meta",
      sql`backup_strategy != 'dump' OR backup_meta IS NOT NULL OR backup_spec IS NOT NULL`,
    ),
  ]
);

/** @deprecated Kept for migrate-volumes.ts only. */
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
