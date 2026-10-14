import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { notificationChannelTypeEnum } from "./enums";
import { organizations } from "./organizations";
import { user } from "./auth";
import { projects } from "./projects";

export const notificationChannels = pgTable(
  "notification_channel",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: notificationChannelTypeEnum("type").notNull(),
    config: jsonb("config").notNull().$type<Record<string, unknown>>(),
    enabled: boolean("enabled").default(true).notNull(),
    subscribedEvents: text("subscribed_events").array().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("notification_channel_org_idx").on(t.organizationId)]
);

// When an org's digests go out. No row means the defaults.

export const digestSettings = pgTable("digest_setting", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(true).notNull(),
  // 0 = Sunday ... 6 = Saturday. Weekly digests; monthly ones go out on the 1st.
  dayOfWeek: integer("day_of_week").default(1).notNull(),
  // Hour in the org's time zone.
  hourOfDay: integer("hour_of_day").default(8).notNull(),
  lastSentAt: timestamp("last_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notification preferences per user, org, channel and event.

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

// Digest frequency per user and org. No row means weekly.

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
    frequency: text("frequency", { enum: ["weekly", "monthly", "off"] }).default("weekly").notNull(),
    // The window last sent to this user, so each sends once.
    lastWindowKey: text("last_window_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("unq_user_digest_pref").on(t.userId, t.organizationId),
    index("user_digest_pref_user_idx").on(t.userId),
    index("user_digest_pref_org_idx").on(t.organizationId),
  ]
);

// Projects a user watches. Each adds its detail to that user's digest.

export const projectWatches = pgTable(
  "project_watch",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] }), index("project_watch_project_idx").on(t.projectId)]
);

// Every delivery attempt and its result.

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
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    // Email provider message ids, one per recipient.
    providerMessageIds: text("provider_message_ids").array(),
    // delivered, bounced or complained, from provider webhooks.
    deliveryStatus: text("delivery_status"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("notification_log_org_idx").on(t.organizationId),
    index("notification_log_created_idx").on(t.createdAt),
    index("notification_log_provider_message_ids_idx").using("gin", t.providerMessageIds),
  ]
);

// The until_clear throttle: one row per org, alert type and subject.

export const notificationSends = pgTable(
  "notification_send",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    about: text("about").notNull(),
    // Worst severity sent since the last clear.
    severity: text("severity").notNull(),
    sentAt: timestamp("sent_at").notNull(),
    clearedAt: timestamp("cleared_at"),
    // The alert as sent, for its resolved notice.
    detail: jsonb("detail"),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.type, t.about] })]
);

export type NotificationSendRow = typeof notificationSends.$inferSelect;

// Every alert that fired and when it cleared, for the health digest.

export const alertHistory = pgTable(
  "alert_history",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    about: text("about").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    firedAt: timestamp("fired_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [
    index("alert_history_org_fired_idx").on(t.organizationId, t.firedAt),
    index("alert_history_open_idx").on(t.organizationId, t.type, t.about),
  ]
);

// Per-org notification switches.

export const notificationSettings = pgTable("notification_setting", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // Category on/off. A missing key is the category's default.
  categories: jsonb("categories").$type<Record<string, boolean>>().default({}).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
