import { relations } from "drizzle-orm";
import { activities } from "./monitoring";
import { organizations } from "./organizations";
import { apps } from "./apps";
import { user } from "./auth";

export const activitiesRelations = relations(activities, ({ one }) => ({
  organization: one(organizations, {
    fields: [activities.organizationId],
    references: [organizations.id],
  }),
  app: one(apps, {
    fields: [activities.appId],
    references: [apps.id],
  }),
  user: one(user, {
    fields: [activities.userId],
    references: [user.id],
  }),
}));
