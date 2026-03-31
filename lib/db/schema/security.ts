import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Security scan findings type (stored as JSONB)
// ---------------------------------------------------------------------------

export type SecurityFinding = {
  type: "file-exposure" | "missing-header" | "exposed-port" | "tls";
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  detail?: string;
};

// ---------------------------------------------------------------------------
// App Security Scans
// ---------------------------------------------------------------------------

export const appSecurityScans = pgTable(
  "app_security_scan",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["deploy", "scheduled", "manual"] }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    findings: jsonb("findings").$type<SecurityFinding[]>().default([]),
    criticalCount: integer("critical_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("app_security_scan_app_id_idx").on(t.appId),
    index("app_security_scan_org_id_idx").on(t.organizationId),
    index("app_security_scan_app_started_at_idx").on(t.appId, t.startedAt),
  ],
);
