import { relations } from "drizzle-orm";
import { cronJobs, cronJobRuns } from "./cron";
import { apps } from "./apps";

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
