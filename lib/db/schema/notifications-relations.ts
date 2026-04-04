import { relations } from "drizzle-orm";
import {
  notificationChannels,
  digestSettings,
  userNotificationPreferences,
  userDigestPreferences,
} from "./notifications";
import { organizations } from "./organizations";
import { user } from "./auth";

export const notificationChannelsRelations = relations(
  notificationChannels,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [notificationChannels.organizationId],
      references: [organizations.id],
    }),
    userPreferences: many(userNotificationPreferences),
  })
);

export const userNotificationPreferencesRelations = relations(
  userNotificationPreferences,
  ({ one }) => ({
    user: one(user, {
      fields: [userNotificationPreferences.userId],
      references: [user.id],
    }),
    organization: one(organizations, {
      fields: [userNotificationPreferences.organizationId],
      references: [organizations.id],
    }),
    channel: one(notificationChannels, {
      fields: [userNotificationPreferences.channelId],
      references: [notificationChannels.id],
    }),
  })
);

export const userDigestPreferencesRelations = relations(
  userDigestPreferences,
  ({ one }) => ({
    user: one(user, {
      fields: [userDigestPreferences.userId],
      references: [user.id],
    }),
    organization: one(organizations, {
      fields: [userDigestPreferences.organizationId],
      references: [organizations.id],
    }),
  })
);

export const digestSettingsRelations = relations(digestSettings, ({ one }) => ({
  organization: one(organizations, {
    fields: [digestSettings.organizationId],
    references: [organizations.id],
  }),
}));
