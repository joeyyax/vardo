import { relations } from "drizzle-orm";
import { user, session, account } from "./auth";
import {
  organizations,
  memberships,
  orgEnvVars,
  orgDomains,
  invitations,
} from "./organizations";
import { projects } from "./projects";
import {
  apps,
  deployments,
  envVars,
  domains,
  domainChecks,
  groupEnvironments,
  environments,
  tags,
  appTags,
  volumes,
  volumeLimits,
  appTransfers,
} from "./apps";
import { deployKeys, githubAppInstallations, apiTokens } from "./config";
import {
  backupTargets,
  backupJobs,
  backupJobApps,
  backupJobVolumes,
  backups,
} from "./backups";
import {
  notificationChannels,
  digestSettings,
  userNotificationPreferences,
  userDigestPreferences,
} from "./notifications";
import { cronJobs, cronJobRuns } from "./cron";
import { meshPeers, projectInstances } from "./mesh";
import { activities } from "./monitoring";

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

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

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  apps: many(apps),
  groupEnvironments: many(groupEnvironments),
  instances: many(projectInstances),
}));

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

export const backupTargetsRelations = relations(
  backupTargets,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [backupTargets.organizationId],
      references: [organizations.id],
    }),
    backupJobs: many(backupJobs),
    backups: many(backups),
  })
);

export const backupJobsRelations = relations(backupJobs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [backupJobs.organizationId],
    references: [organizations.id],
  }),
  target: one(backupTargets, {
    fields: [backupJobs.targetId],
    references: [backupTargets.id],
  }),
  backupJobApps: many(backupJobApps),
  backupJobVolumes: many(backupJobVolumes),
  backups: many(backups),
}));

export const backupJobAppsRelations = relations(
  backupJobApps,
  ({ one }) => ({
    backupJob: one(backupJobs, {
      fields: [backupJobApps.backupJobId],
      references: [backupJobs.id],
    }),
    app: one(apps, {
      fields: [backupJobApps.appId],
      references: [apps.id],
    }),
  })
);

export const backupJobVolumesRelations = relations(
  backupJobVolumes,
  ({ one }) => ({
    backupJob: one(backupJobs, {
      fields: [backupJobVolumes.backupJobId],
      references: [backupJobs.id],
    }),
    volume: one(volumes, {
      fields: [backupJobVolumes.volumeId],
      references: [volumes.id],
    }),
  })
);

export const backupsRelations = relations(backups, ({ one }) => ({
  job: one(backupJobs, {
    fields: [backups.jobId],
    references: [backupJobs.id],
  }),
  app: one(apps, {
    fields: [backups.appId],
    references: [apps.id],
  }),
  target: one(backupTargets, {
    fields: [backups.targetId],
    references: [backupTargets.id],
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

export const cronJobsRelations = relations(cronJobs, ({ one, many }) => ({
  app: one(apps, {
    fields: [cronJobs.appId],
    references: [apps.id],
  }),
  runs: many(cronJobRuns),
}));

export const cronJobRunsRelations = relations(cronJobRuns, ({ one }) => ({
  cronJob: one(cronJobs, {
    fields: [cronJobRuns.cronJobId],
    references: [cronJobs.id],
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

export const invitationsRelations = relations(invitations, ({ one }) => ({
  inviter: one(user, {
    fields: [invitations.invitedBy],
    references: [user.id],
  }),
}));

export const meshPeersRelations = relations(meshPeers, ({ many }) => ({
  projectInstances: many(projectInstances),
}));

export const projectInstancesRelations = relations(
  projectInstances,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectInstances.projectId],
      references: [projects.id],
    }),
    meshPeer: one(meshPeers, {
      fields: [projectInstances.meshPeerId],
      references: [meshPeers.id],
    }),
  })
);
