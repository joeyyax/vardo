import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { notificationChannelTypeEnum } from "./enums";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// Notification Channels
// ---------------------------------------------------------------------------

export const notificationChannels = pgTable(
  "notification_channel",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: notificationChannelTypeEnum("type").notNull(),
    config: jsonb("config").notNull().$type<{ recipients: string[] } | { url: string; secret?: string } | { webhookUrl: string }>(),
    enabled: boolean("enabled").default(true).notNull(),
    subscribedEvents: text("subscribed_events").array().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("notification_channel_org_idx").on(t.organizationId)]
);

// ---------------------------------------------------------------------------
// Weekly Digest Settings (per-org)
// ---------------------------------------------------------------------------

export const digestSettings = pgTable("digest_setting", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(true).notNull(),
  // 0 = Sunday ... 6 = Saturday
  dayOfWeek: integer("day_of_week").default(1).notNull(),
  // 0-23 UTC
  hourOfDay: integer("hour_of_day").default(8).notNull(),
  lastSentAt: timestamp("last_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Notification log — records every delivery attempt + result
// ---------------------------------------------------------------------------

export const notificationLogs = pgTable(
  "notification_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => notificationChannels.id, {
      onDelete: "set null",
    }),
    channelName: text("channel_name").notNull(),
    channelType: text("channel_type").notNull(), // email, webhook, push
    eventType: text("event_type").notNull(), // deploy.success, backup.failed, etc.
    eventTitle: text("event_title").notNull(),
    status: text("status").notNull(), // success, failed
    error: text("error"), // error message if failed
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("notification_log_org_idx").on(t.organizationId),
    index("notification_log_created_idx").on(t.createdAt),
  ]
);
