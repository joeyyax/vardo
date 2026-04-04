import { relations } from "drizzle-orm";
import { projects } from "./projects";
import { organizations } from "./organizations";
import { apps } from "./apps";
import { groupEnvironments } from "./environments";
import { projectInstances } from "./mesh";

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  apps: many(apps),
  groupEnvironments: many(groupEnvironments),
  instances: many(projectInstances),
}));
