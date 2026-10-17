import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AutoOverrides, Check, MaintenanceWindow, ReviewAnswer } from "@/lib/uptime/core/types";
import { apps } from "./apps";
import { domains } from "./domains";
import { environments } from "./environments";
import { meshPeers } from "./mesh";
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
    /** The linked instance an automatic instance monitor watches. */
    meshPeerId: text("mesh_peer_id").references(() => meshPeers.id, { onDelete: "cascade" }),
    /** "link" for the tunnel, "public" for the peer's public URL. */
    peerRole: text("peer_role"),
    /** Windows that mute alerts. Downtime inside them still counts. */
    maintenance: jsonb("maintenance").$type<MaintenanceWindow[]>().notNull().default([]),
    /** The path an automatic monitor checks, such as `/healthz`. Null checks the homepage. */
    healthPath: text("health_path"),
    /** "healthcheck", "probe" or "homepage". Null before detection has run. */
    healthSource: text("health_source"),
    /** When detection runs next. Null runs it on the next pass. */
    healthDueAt: timestamp("health_due_at", { withTimezone: true }),
    /** Set while the best answer is a non-2xx below 500 and the operator hasn't said what counts as up. */
    reviewStatus: integer("review_status"),
    /** "status" or "login". */
    reviewReason: text("review_reason"),
    /** What the operator said counts as up. Detection and sync leave it alone. */
    reviewAnswer: jsonb("review_answer").$type<ReviewAnswer>(),
    /** What the operator changed on an automatic monitor. Null when it runs as detected. */
    overrides: jsonb("overrides").$type<AutoOverrides>(),
    /** A manual check linked to an app's domain. Not a foreign key: removing the domain leaves the check, flagged. */
    linkDomainId: text("link_domain_id"),
    /** The domain's host when the check was linked. */
    linkDomain: text("link_domain"),
    /** Request headers as encrypted JSON. Never returned. */
    headersEncrypted: text("headers_encrypted"),
    /** Names of the encrypted headers, for display. */
    headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
    /** Linked instances get the headers and check this monitor too. */
    shareHeaders: boolean("share_headers").notNull().default(false),
    /** The operator dismissed the notice that the check loads a heavy or slow page. */
    heavyNoticeDismissed: boolean("heavy_notice_dismissed").notNull().default(false),
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

/** A place checks run from. This instance's own row holds its Ed25519 keypair. */
export const uptimeVantages = pgTable(
  "uptime_vantage",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** "local" or "external". */
    kind: text("kind").notNull(),
    location: text("location"),
    publicKey: text("public_key").notNull(),
    /** Encrypted with the system key. Null on external vantage points. */
    privateKeyEncrypted: text("private_key_encrypted"),
    /** The linked instance an external vantage point is. */
    meshPeerId: text("mesh_peer_id").references(() => meshPeers.id, { onDelete: "cascade" }),
    /** The id the vantage point signs with on its own instance. */
    remoteId: text("remote_id"),
    /** Monitor ids it may report on: the watch list last served to it. */
    watching: jsonb("watching").$type<string[]>().notNull().default([]),
    /** Unused since mesh checks were retired; kept so a rolled-back release can still read this table. */
    meshWatching: jsonb("mesh_watching").$type<string[]>().notNull().default([]),
    /** Monitor ids in the last report it accepted from us. */
    reporting: jsonb("reporting").$type<string[]>().notNull().default([]),
    /** When it last accepted our report. Null while it doesn't take them. */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uptime_vantage_peer_uniq").on(t.meshPeerId).where(sql`${t.meshPeerId} is not null`)],
);

/** Signed records exactly as an external vantage point sent them. Rows are inserted and never updated. */
export const uptimeRecords = pgTable(
  "uptime_record",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vantageId: text("vantage_id")
      .notNull()
      .references(() => uptimeVantages.id, { onDelete: "cascade" }),
    /** "results" or "hourly". */
    kind: text("kind").notNull(),
    /** The monitor an hourly summary covers. */
    monitorId: text("monitor_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    payload: text("payload").notNull(),
    sig: text("sig").notNull(),
  },
  (t) => [index("uptime_record_vantage_idx").on(t.vantageId, t.kind, t.monitorId, t.issuedAt)],
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
    /** "public", "mesh" or "local". */
    path: text("path").notNull().default("public"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: integer("status"),
    /** An ErrorKind. */
    error: text("error"),
    certDaysLeft: integer("cert_days_left"),
    /** The cache that answered an HTTP check, such as "cloudflare". Null when the origin did. */
    cache: text("cache"),
    /** Body size of an HTTP check, capped where the response sends no Content-Length. */
    bytes: integer("bytes"),
    /** The signed record an external result arrived in. Null on local results. */
    recordId: bigint("record_id", { mode: "number" }).references(() => uptimeRecords.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("uptime_result_monitor_at_idx").on(t.monitorId, t.at),
    index("uptime_result_at_idx").on(t.at),
    uniqueIndex("uptime_result_external_uniq")
      .on(t.monitorId, t.vantageId, t.at)
      .where(sql`${t.recordId} is not null`),
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

/** Checks this instance runs for a linked peer, from the watch list the peer last served. */
export const uptimeWatchEntries = pgTable(
  "uptime_watch_entry",
  {
    peerId: text("peer_id")
      .notNull()
      .references(() => meshPeers.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id").notNull(),
    check: jsonb("check").$type<Check>().notNull(),
    intervalSec: integer("interval_sec").notNull(),
    /** "public" or "mesh". */
    path: text("path").notNull().default("public"),
    /** How often to run it and the offset into that period. Null before the peer sent a schedule. */
    periodSec: integer("period_sec"),
    offsetMs: bigint("offset_ms", { mode: "number" }),
    /** Headers the owner shares, encrypted with the system key. */
    headersEncrypted: text("headers_encrypted"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.peerId, t.monitorId] })],
);

/** What this instance measured for a peer's monitors, kept 14 days as the witness copy. */
export const uptimeProbeResults = pgTable(
  "uptime_probe_result",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    peerId: text("peer_id")
      .notNull()
      .references(() => meshPeers.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id").notNull(),
    path: text("path").notNull().default("public"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: integer("status"),
    error: text("error"),
    certDaysLeft: integer("cert_days_left"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("uptime_probe_result_pending_idx").on(t.peerId, t.deliveredAt), index("uptime_probe_result_at_idx").on(t.at)],
);

/** Hourly summaries this instance signed for a peer's monitors, kept a year. */
export const uptimeProbeSummaries = pgTable(
  "uptime_probe_summary",
  {
    peerId: text("peer_id")
      .notNull()
      .references(() => meshPeers.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id").notNull(),
    start: timestamp("start", { withTimezone: true }).notNull(),
    record: text("record").notNull(),
    sig: text("sig").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.peerId, t.monitorId, t.start] })],
);

/** The latest signed report from a linked peer on the monitors this instance doesn't check, stored as received. */
export const uptimePeerReports = pgTable("uptime_peer_report", {
  peerId: text("peer_id")
    .primaryKey()
    .references(() => meshPeers.id, { onDelete: "cascade" }),
  /** The id the peer signs with. */
  remoteId: text("remote_id").notNull(),
  publicKey: text("public_key").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  payload: text("payload").notNull(),
  sig: text("sig").notNull(),
});

export type UptimeMonitorRow = typeof uptimeMonitors.$inferSelect;
export type UptimeVantageRow = typeof uptimeVantages.$inferSelect;
