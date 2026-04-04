import { relations } from "drizzle-orm";
import {
  backupTargets,
  backupJobs,
  backupJobApps,
  backupJobVolumes,
  backups,
} from "./backups";
import { organizations } from "./organizations";
import { apps } from "./apps";
import { volumes } from "./volumes";

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
