import { relations } from "drizzle-orm";
import { user, session, account } from "./auth";
import { memberships } from "./organizations";
import { deployments } from "./deployments";
import { apiTokens, githubAppInstallations } from "./config";
import { activities } from "./monitoring";
import { appTransfers } from "./app-transfers";
import {
  userNotificationPreferences,
  userDigestPreferences,
} from "./notifications";

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(memberships),
  deployments: many(deployments),
  apiTokens: many(apiTokens),
  activities: many(activities),
  githubAppInstallations: many(githubAppInstallations),
  initiatedTransfers: many(appTransfers, { relationName: "initiatedByUser" }),
  respondedTransfers: many(appTransfers, { relationName: "respondedByUser" }),
  notificationPreferences: many(userNotificationPreferences),
  digestPreferences: many(userDigestPreferences),
}));
