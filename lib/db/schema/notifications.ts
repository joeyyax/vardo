import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { notificationChannelTypeEnum } from "./enums";
import { organizations } from "./organizations";
import { user } from "./auth";

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
// User Notification Preferences (per-user, per-org, per-channel, per-event)
// ---------------------------------------------------------------------------

export const userNotificationPreferences = pgTable(
  "user_notification_preference",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    eventType: text("event_type").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "user_notif_pref_channel_fk",
      columns: [t.channelId],
      foreignColumns: [notificationChannels.id],
    }).onDelete("cascade"),
    unique("unq_user_notification_pref").on(
      t.userId,
      t.organizationId,
      t.channelId,
      t.eventType,
    ),
    index("user_notification_pref_user_idx").on(t.userId),
    index("user_notification_pref_channel_idx").on(t.channelId),
  ]
);

// ---------------------------------------------------------------------------
// User Digest Preferences (per-user, per-org)
// Weekly digest opt-in — additive to real-time notifications.
// ---------------------------------------------------------------------------

export const userDigestPreferences = pgTable(
  "user_digest_preference",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("unq_user_digest_pref").on(t.userId, t.organizationId),
    index("user_digest_pref_user_idx").on(t.userId),
    index("user_digest_pref_org_idx").on(t.organizationId),
  ]
);

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
