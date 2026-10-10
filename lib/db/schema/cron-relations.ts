import { relations } from "drizzle-orm";
import { cronJobs, cronJobRuns } from "./cron";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const cronJobsRelations = relations(cronJobs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [cronJobs.organizationId],
    references: [organizations.id],
  }),
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
