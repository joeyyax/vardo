import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { meshPeers } from "./mesh";

// Probe guard records. Only addresses, paths, marker ids and times; never what a client sent.

// Text columns: adding a value needs no migration.
export const PROBE_BAN_REASONS = ["threshold", "trap", "canary", "mesh", "blocklist"] as const;
export type ProbeBanReason = (typeof PROBE_BAN_REASONS)[number];

/** Instance-wide bans, rendered into Traefik's guard file while active. */
export const probeBans = pgTable(
  "probe_ban",
  {
    id: text("id").primaryKey(),
    ip: text("ip").notNull(),
    reason: text("reason", { enum: PROBE_BAN_REASONS }).notNull(),
    /** The app whose traffic tripped the ban. Null for bans from a linked instance. */
    appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
    /** Probe hits; for blocklist bans, the source's confidence score. */
    hits: integer("hits").notNull().default(0),
    /** Requests the guard turned away under this ban. */
    blockedCount: integer("blocked_count").notNull().default(0),
    lastBlockedAt: timestamp("last_blocked_at", { withTimezone: true }),
    /** The linked instance that sent this ban. Received bans are never sent on. */
    originPeerId: text("origin_peer_id").references(() => meshPeers.id, { onDelete: "set null" }),
    originName: text("origin_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: text("lifted_by"),
  },
  (t) => [
    index("probe_ban_ip_idx").on(t.ip),
    index("probe_ban_expires_at_idx").on(t.expiresAt),
    index("probe_ban_app_created_idx").on(t.appId, t.createdAt),
  ],
);

/** One decoy marker per fetching address. */
export const probeCanaries = pgTable(
  "probe_canary",
  {
    id: text("id").primaryKey(),
    marker: text("marker").notNull().unique(),
    ip: text("ip").notNull(),
    appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }).defaultNow().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("probe_canary_ip_idx").on(t.ip)],
);

export const PROBE_EVENT_KINDS = ["trap", "canary_fetch", "canary_used", "probe", "reported"] as const;
export type ProbeEventKind = (typeof PROBE_EVENT_KINDS)[number];

/** Trap hits, canary use and capped probe hits, kept for 30 days. */
export const probeEvents = pgTable(
  "probe_event",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: PROBE_EVENT_KINDS }).notNull(),
    ip: text("ip").notNull(),
    /** The request path; for reported events, the reporter id. */
    path: text("path"),
    canaryId: text("canary_id").references(() => probeCanaries.id, { onDelete: "set null" }),
    appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("probe_event_created_at_idx").on(t.createdAt),
    index("probe_event_app_created_idx").on(t.appId, t.createdAt),
  ],
);
