import { relations } from "drizzle-orm";
import { appSecurityScans } from "./security";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const appSecurityScansRelations = relations(appSecurityScans, ({ one }) => ({
  app: one(apps, {
    fields: [appSecurityScans.appId],
    references: [apps.id],
  }),
  organization: one(organizations, {
    fields: [appSecurityScans.organizationId],
    references: [organizations.id],
  }),
}));
