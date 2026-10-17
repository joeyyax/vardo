import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Check, MaintenanceWindow } from "@/lib/uptime/core/types";
import { apps } from "./apps";
import { domains } from "./domains";
import { environments } from "./environments";
import { organizations } from "./organizations";

// Text columns: adding a check type or vantage kind needs no migration.

/** A thing to check. Org-owned rows carry organizationId; instance rows leave it null. */
export const uptimeMonitors = pgTable(
  "uptime_monitor",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    check: jsonb("check").$type<Check>().notNull(),
    intervalSec: integer("interval_sec").notNull().default(60),
    muted: boolean("muted").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    /** "auto" or "manual". */
    source: text("source").notNull().default("manual"),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    /** A preview environment's hostname. */
    environmentId: text("environment_id").references(() => environments.id, { onDelete: "cascade" }),
    preview: boolean("preview").notNull().default(false),
    /** Windows that mute alerts. Downtime inside them still counts. */
    maintenance: jsonb("maintenance").$type<MaintenanceWindow[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("uptime_monitor_org_idx").on(t.organizationId),
    index("uptime_monitor_app_idx").on(t.appId),
    uniqueIndex("uptime_monitor_domain_uniq").on(t.domainId).where(sql`${t.domainId} is not null`),
    uniqueIndex("uptime_monitor_env_uniq").on(t.environmentId).where(sql`${t.environmentId} is not null`),
  ],
);

/** Raw results, kept 14 days. */
export const uptimeResults = pgTable(
  "uptime_result",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => uptimeMonitors.id, { onDelete: "cascade" }),
    vantageId: text("vantage_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: integer("status"),
    /** An ErrorKind. */
    error: text("error"),
    certDaysLeft: integer("cert_days_left"),
  },
  (t) => [
    index("uptime_result_monitor_at_idx").on(t.monitorId, t.at),
    index("uptime_result_at_idx").on(t.at),
  ],
);

const bucketColumns = {
  monitorId: text("monitor_id")
    .notNull()
    .references(() => uptimeMonitors.id, { onDelete: "cascade" }),
  start: timestamp("start", { withTimezone: true }).notNull(),
  minutesUp: integer("minutes_up").notNull(),
  minutesDown: integer("minutes_down").notNull(),
  minutesUnknown: integer("minutes_unknown").notNull(),
  medianLatencyMs: integer("median_latency_ms"),
};

/** Hourly rollups, kept a year. The local vantage point signs each one. */
export const uptimeHourly = pgTable(
  "uptime_hourly",
  {
    ...bucketColumns,
    /** The signed record (payload JSON) and its signature. */
    record: text("record"),
    sig: text("sig"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.start] })],
);

/** Daily rollups, kept indefinitely. */
export const uptimeDaily = pgTable("uptime_daily", bucketColumns, (t) => [primaryKey({ columns: [t.monitorId, t.start] })]);

/** A place checks run from. This instance's own row holds its Ed25519 keypair. */
export const uptimeVantages = pgTable("uptime_vantage", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** "local" or "external". */
  kind: text("kind").notNull(),
  location: text("location"),
  publicKey: text("public_key").notNull(),
  /** Encrypted with the system key. Null on external vantage points. */
  privateKeyEncrypted: text("private_key_encrypted"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UptimeMonitorRow = typeof uptimeMonitors.$inferSelect;
export type UptimeVantageRow = typeof uptimeVantages.$inferSelect;
