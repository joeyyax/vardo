import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { UpsState } from "@/lib/ups/status";

/** A NUT server and UPS this instance watches. Instance-level: no organization. */
export const upsServers = pgTable(
  "ups_servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(3493),
    upsName: text("ups_name").notNull(),
    username: text("username"),
    /** Encrypted with the system key. */
    password: text("password"),
    tls: boolean("tls").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    /** Seconds on battery before the on-battery alert. 0 alerts at once. */
    onBatteryGraceSec: integer("on_battery_grace_sec").notNull().default(60),
    /** The poller's latest state for this UPS. */
    state: jsonb("state").$type<UpsState>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ups_servers_target_idx").on(t.host, t.port, t.upsName)],
);

export type UpsServerRow = typeof upsServers.$inferSelect;
