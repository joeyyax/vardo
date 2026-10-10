// Cron failure alerts: once when a job starts failing, again when it recovers.

import type { AlertItem, CronFailedEvent } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { claimAlert, resolveAlert } from "@/lib/notifications/observations";
import { readOrgNotificationSettings } from "@/lib/notifications/preferences";
import { logger } from "@/lib/logger";

const log = logger.child("cron");

export const CRON_ALERT = "cron.failure" as const;

export type CronAlertJob = {
  id: string;
  name: string;
  organizationId: string;
  app: { id: string; name: string; displayName: string | null } | null;
};

/** The alert a failing job holds open, keyed on the job. */
export function cronFailureItem(job: CronAlertJob, detail: string, now: Date): AlertItem {
  const appName = job.app ? job.app.displayName || job.app.name : undefined;
  return {
    type: CRON_ALERT,
    about: job.id,
    severity: "critical",
    title: appName ? `${job.name} is failing on ${appName}` : `Cron job ${job.name} is failing`,
    detail,
    appId: job.app?.id,
    appName,
    facts: [{ label: "Job", value: job.name }, ...(appName ? [{ label: "App", value: appName }] : [])],
    since: now.toISOString(),
  };
}

/** Sends the failure once per failing streak. Returns whether it sent. */
export async function noteCronFailure(
  job: CronAlertJob,
  event: Omit<CronFailedEvent, "type">,
  now: Date,
): Promise<boolean> {
  try {
    const settings = await readOrgNotificationSettings(job.organizationId);
    if (!settings.categories.cron) return false;
    const item = cronFailureItem(job, event.message.split("\n")[0] || "The last run failed.", now);
    if (!(await claimAlert(job.organizationId, CRON_ALERT, item, now))) return false;
    emit(job.organizationId, { type: "cron.failed", ...event });
    return true;
  } catch (err) {
    log.error(`Failed to send notification for ${job.name}:`, err);
    return false;
  }
}

/** Clears a failing streak and sends the recovery notice. Returns whether one was open. */
export async function noteCronSuccess(job: CronAlertJob, now: Date): Promise<boolean> {
  try {
    const settings = await readOrgNotificationSettings(job.organizationId);
    return await resolveAlert(job.organizationId, CRON_ALERT, job.id, now, settings.categories.cron);
  } catch (err) {
    log.error(`Failed to clear the alert for ${job.name}:`, err);
    return false;
  }
}
