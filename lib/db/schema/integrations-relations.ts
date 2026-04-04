import { relations } from "drizzle-orm";
import { integrations } from "./integrations";
import { apps } from "./apps";

export const integrationsRelations = relations(integrations, ({ one }) => ({
  app: one(apps, {
    fields: [integrations.appId],
    references: [apps.id],
  }),
}));
