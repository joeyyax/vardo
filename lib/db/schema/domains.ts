import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const domains = pgTable("domain", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  domain: text("domain").notNull().unique(),
  serviceName: text("service_name"),
  port: integer("port"),
  middlewares: text("middlewares"),
  certResolver: text("cert_resolver").default("le"),
  isPrimary: boolean("is_primary").default(false),
  sslEnabled: boolean("ssl_enabled").default(true),
  redirectTo: text("redirect_to"),
  redirectCode: integer("redirect_code").default(301),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
  (t) => [
    index("domain_app_id_idx").on(t.appId),
  ]
);

// ---------------------------------------------------------------------------
// Domain Checks (health monitoring history)
// ---------------------------------------------------------------------------

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
