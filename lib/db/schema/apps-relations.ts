import { relations } from "drizzle-orm";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { deployKeys } from "./config";
import { projects } from "./projects";
import { deployments } from "./deployments";
import { envVars } from "./env-vars";
import { domains, domainChecks } from "./domains";
import { environments, groupEnvironments } from "./environments";
import { activities } from "./monitoring";
import { tags, appTags } from "./tags";
import { backupJobApps, backups } from "./backups";
import { volumes, volumeLimits } from "./volumes";
import { cronJobs } from "./cron";
import { appTransfers } from "./app-transfers";
import { appSecurityScans } from "./security";
import { integrations } from "./integrations";
import { user } from "./auth";

export const appsRelations = relations(apps, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [apps.organizationId],
    references: [organizations.id],
  }),
  deployKey: one(deployKeys, {
    fields: [apps.gitKeyId],
    references: [deployKeys.id],
  }),
  project: one(projects, {
    fields: [apps.projectId],
    references: [projects.id],
  }),
  parentApp: one(apps, {
    fields: [apps.parentAppId],
    references: [apps.id],
    relationName: "parentChild",
  }),
  childApps: many(apps, { relationName: "parentChild" }),
  deployments: many(deployments),
  envVars: many(envVars),
  domains: many(domains),
  environments: many(environments),
  activities: many(activities),
  appTags: many(appTags),
  backupJobApps: many(backupJobApps),
  backups: many(backups),
  volumes: many(volumes),
  volumeLimit: many(volumeLimits),
  cronJobs: many(cronJobs),
  transfers: many(appTransfers),
  securityScans: many(appSecurityScans),
  integrations: many(integrations),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  app: one(apps, {
    fields: [deployments.appId],
    references: [apps.id],
  }),
  environment: one(environments, {
    fields: [deployments.environmentId],
    references: [environments.id],
  }),
  groupEnvironment: one(groupEnvironments, {
    fields: [deployments.groupEnvironmentId],
    references: [groupEnvironments.id],
  }),
  triggeredByUser: one(user, {
    fields: [deployments.triggeredBy],
    references: [user.id],
  }),
}));

export const envVarsRelations = relations(envVars, ({ one }) => ({
  app: one(apps, {
    fields: [envVars.appId],
    references: [apps.id],
  }),
  environment: one(environments, {
    fields: [envVars.environmentId],
    references: [environments.id],
  }),
}));

export const domainsRelations = relations(domains, ({ one, many }) => ({
  app: one(apps, {
    fields: [domains.appId],
    references: [apps.id],
  }),
  domainChecks: many(domainChecks),
}));

export const domainChecksRelations = relations(domainChecks, ({ one }) => ({
  domain: one(domains, {
    fields: [domainChecks.domainId],
    references: [domains.id],
  }),
}));

export const environmentsRelations = relations(
  environments,
  ({ one, many }) => ({
    app: one(apps, {
      fields: [environments.appId],
      references: [apps.id],
    }),
    groupEnvironment: one(groupEnvironments, {
      fields: [environments.groupEnvironmentId],
      references: [groupEnvironments.id],
    }),
    envVars: many(envVars),
    deployments: many(deployments),
  })
);

export const groupEnvironmentsRelations = relations(
  groupEnvironments,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [groupEnvironments.projectId],
      references: [projects.id],
    }),
    createdByUser: one(user, {
      fields: [groupEnvironments.createdBy],
      references: [user.id],
    }),
    environments: many(environments),
    deployments: many(deployments),
  })
);

export const tagsRelations = relations(tags, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [tags.organizationId],
    references: [organizations.id],
  }),
  appTags: many(appTags),
}));

export const appTagsRelations = relations(appTags, ({ one }) => ({
  app: one(apps, {
    fields: [appTags.appId],
    references: [apps.id],
  }),
  tag: one(tags, {
    fields: [appTags.tagId],
    references: [tags.id],
  }),
}));

export const volumesRelations = relations(volumes, ({ one }) => ({
  app: one(apps, {
    fields: [volumes.appId],
    references: [apps.id],
  }),
  organization: one(organizations, {
    fields: [volumes.organizationId],
    references: [organizations.id],
  }),
}));

export const volumeLimitsRelations = relations(volumeLimits, ({ one }) => ({
  app: one(apps, {
    fields: [volumeLimits.appId],
    references: [apps.id],
  }),
}));

export const appTransfersRelations = relations(
  appTransfers,
  ({ one }) => ({
    app: one(apps, {
      fields: [appTransfers.appId],
      references: [apps.id],
    }),
    sourceOrg: one(organizations, {
      fields: [appTransfers.sourceOrgId],
      references: [organizations.id],
      relationName: "sourceOrg",
    }),
    destinationOrg: one(organizations, {
      fields: [appTransfers.destinationOrgId],
      references: [organizations.id],
      relationName: "destinationOrg",
    }),
    initiatedByUser: one(user, {
      fields: [appTransfers.initiatedBy],
      references: [user.id],
      relationName: "initiatedByUser",
    }),
    respondedByUser: one(user, {
      fields: [appTransfers.respondedBy],
      references: [user.id],
      relationName: "respondedByUser",
    }),
  })
);
