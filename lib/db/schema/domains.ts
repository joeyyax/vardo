import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";

export const domains = pgTable("domain", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  /** Routes only requests under this path, e.g. "/docs". Null routes the whole host. */
  pathPrefix: text("path_prefix"),
  /** Removes pathPrefix before the request reaches the app. */
  stripPathPrefix: boolean("strip_path_prefix").default(false).notNull(),
  serviceName: text("service_name"),
  port: integer("port"),
  middlewares: text("middlewares"),
  certResolver: text("cert_resolver").default("le-dns"),
  isPrimary: boolean("is_primary").default(false),
  sslEnabled: boolean("ssl_enabled").default(true),
  redirectTo: text("redirect_to"),
  redirectCode: integer("redirect_code").default(301),
  // DNS TXT challenge at _vardo-challenge.<domain>.
  verificationToken: text("verification_token"),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
  (t) => [
    index("domain_app_id_idx").on(t.appId),
    uniqueIndex("domain_host_path_uniq").on(t.domain, sql`coalesce(${t.pathPrefix}, '')`),
  ]
);

// Domain health check history.

export const domainChecks = pgTable(
  "domain_check",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    reachable: boolean("reachable").notNull(),
    statusCode: integer("status_code"),
    responseTimeMs: integer("response_time_ms"),
    error: text("error"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (t) => [
    index("domain_check_domain_checked_at_idx").on(t.domainId, t.checkedAt),
  ]
);

// Latest TLS certificate seen per domain, overwritten by each probe.
export const domainCertChecks = pgTable("domain_cert_check", {
  domainId: text("domain_id")
    .primaryKey()
    .references(() => domains.id, { onDelete: "cascade" }),
  /** Certificate notAfter. Null when the probe read no usable certificate. */
  expiresAt: timestamp("expires_at"),
  /** SHA-256 of the peer certificate. */
  fingerprint: text("fingerprint"),
  /** Verdict kind: ok, expiring, expired, not-issued or unknown. */
  status: text("status").notNull(),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});
