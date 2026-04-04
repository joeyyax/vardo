import { relations } from "drizzle-orm";
import { deployKeys, githubAppInstallations, apiTokens } from "./config";
import { organizations } from "./organizations";
import { user } from "./auth";

export const deployKeysRelations = relations(deployKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [deployKeys.organizationId],
    references: [organizations.id],
  }),
}));

export const githubAppInstallationsRelations = relations(
  githubAppInstallations,
  ({ one }) => ({
    user: one(user, {
      fields: [githubAppInstallations.userId],
      references: [user.id],
    }),
  })
);

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(user, {
    fields: [apiTokens.userId],
    references: [user.id],
  }),
  organization: one(organizations, {
    fields: [apiTokens.organizationId],
    references: [organizations.id],
  }),
}));
