import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

/**
 * One row per app per UTC hour, rolled up from the time-series store and domain checks. Kept 13 months.
 * Counts the app's default environment only.
 * Rows are disjoint: a stack child owns its service's containers and the parent keeps only the rest.
 */
export const appMetricHours = pgTable(
  "app_metric_hour",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Start of the UTC hour. */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    /** Minutes of the hour with container samples, in 5-minute steps. */
    metricMinutes: smallint("metric_minutes").notNull().default(0),
    /** Raw CPU samples across the app's containers. */
    sampleCount: integer("sample_count").notNull().default(0),
    /** Percent of one core, summed across containers. Peaks are the busiest 5-minute average. */
    cpuAvg: real("cpu_avg"),
    cpuPeak: real("cpu_peak"),
    memoryAvg: bigint("memory_avg", { mode: "number" }),
    memoryPeak: bigint("memory_peak", { mode: "number" }),
    /** Summed container limits at the hour's last sample. Null when any container is unlimited. */
    memoryLimit: bigint("memory_limit", { mode: "number" }),
    networkRxBytes: bigint("network_rx_bytes", { mode: "number" }),
    networkTxBytes: bigint("network_tx_bytes", { mode: "number" }),
    checksTotal: integer("checks_total").notNull().default(0),
    checksUp: integer("checks_up").notNull().default(0),
    /** Response times of reachable checks: count, sum and counts per RESPONSE_BUCKETS_MS bucket. */
    responseCount: integer("response_count").notNull().default(0),
    responseMsSum: bigint("response_ms_sum", { mode: "number" }).notNull().default(0),
    responseHistogram: integer("response_histogram").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.hour] }),
    index("app_metric_hour_org_hour_idx").on(t.organizationId, t.hour),
    index("app_metric_hour_hour_idx").on(t.hour),
  ]
);

export type AppMetricHourRow = typeof appMetricHours.$inferSelect;
export type NewAppMetricHourRow = typeof appMetricHours.$inferInsert;
