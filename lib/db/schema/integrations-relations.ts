// DEPRECATED: This table will be dropped in a future migration. Use the plugin system instead.
import { relations } from "drizzle-orm";
import { integrations } from "./integrations";
import { apps } from "./apps";

export const integrationsRelations = relations(integrations, ({ one }) => ({
  app: one(apps, {
    fields: [integrations.appId],
    references: [apps.id],
  }),
}));
