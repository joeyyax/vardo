import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { apps } from "./apps";

// ---------------------------------------------------------------------------
// Platform Integrations
//
// Infrastructure tools deployed as regular apps and wired back into Vardo.
// Each integration type can have at most one active connection.
// ---------------------------------------------------------------------------

export const integrationTypeEnum = pgEnum("integration_type", [
  "metrics",        // cAdvisor, Prometheus
  "error_tracking", // GlitchTip, Sentry
  "uptime",         // Uptime Kuma
  "logging",        // Grafana + Loki
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "connected",      // healthy and active
  "disconnected",   // removed or not yet configured
  "degraded",       // backing app stopped or unresponsive
]);

export const integrations = pgTable(
  "integration",
  {
    id: text("id").primaryKey(),
    type: integrationTypeEnum("type").notNull(),
    status: integrationStatusEnum("status").notNull().default("disconnected"),

    // Vardo-deployed: reference the app by ID (preferred — connection is stable)
    appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),

    // External: URL + credentials for instances not managed by Vardo
    externalUrl: text("external_url"),
    credentials: text("credentials"), // AES-256-GCM encrypted (API token, etc.)

    // Provider-specific config (e.g. cAdvisor port, GlitchTip org/team)
    config: jsonb("config").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("integration_type_idx").on(t.type),
    index("integration_app_id_idx").on(t.appId),
  ],
);
