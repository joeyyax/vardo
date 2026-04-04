import { relations } from "drizzle-orm";
import {
  organizations,
  memberships,
  orgEnvVars,
  orgDomains,
  invitations,
} from "./organizations";
import { user } from "./auth";
import { projects } from "./projects";
import { apps } from "./apps";
import { deployKeys, apiTokens } from "./config";
import { activities } from "./monitoring";
import { tags } from "./tags";
import { backupTargets, backupJobs } from "./backups";
import { appTransfers } from "./app-transfers";
import {
  notificationChannels,
  digestSettings,
  userNotificationPreferences,
  userDigestPreferences,
} from "./notifications";

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  memberships: many(memberships),
  projects: many(projects),
  apps: many(apps),
  deployKeys: many(deployKeys),
  apiTokens: many(apiTokens),
  activities: many(activities),
  tags: many(tags),
  backupTargets: many(backupTargets),
  backupJobs: many(backupJobs),
  orgEnvVars: many(orgEnvVars),
  orgDomains: many(orgDomains),
  outgoingTransfers: many(appTransfers, { relationName: "sourceOrg" }),
  incomingTransfers: many(appTransfers, { relationName: "destinationOrg" }),
  notificationChannels: many(notificationChannels),
  invitations: many(invitations),
  digestSetting: one(digestSettings, {
    fields: [organizations.id],
    references: [digestSettings.organizationId],
  }),
  userNotificationPreferences: many(userNotificationPreferences),
  userDigestPreferences: many(userDigestPreferences),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(user, {
    fields: [memberships.userId],
    references: [user.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
}));

export const orgEnvVarsRelations = relations(orgEnvVars, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgEnvVars.organizationId],
    references: [organizations.id],
  }),
}));

export const orgDomainsRelations = relations(orgDomains, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgDomains.organizationId],
    references: [organizations.id],
  }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  inviter: one(user, {
    fields: [invitations.invitedBy],
    references: [user.id],
  }),
}));
