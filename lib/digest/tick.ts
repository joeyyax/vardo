import { db } from "@/lib/db";
import { digestSettings } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { emit } from "@/lib/notifications/dispatch";
import { collectDigestData } from "./collector";
import { logger } from "@/lib/logger";

const log = logger.child("digest");

/**
 * Check all orgs with digest settings and fire the digest for any that are due.
 * Called every minute by the digest scheduler.
 */
export async function tickDigestJobs(): Promise<void> {
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0 = Sunday
  const currentHour = now.getUTCHours();
  // Only fire once per hour — check minute is 0-4 to avoid drift issues
  const currentMinute = now.getUTCMinutes();
  if (currentMinute >= 5) return;

  const settings = await db.query.digestSettings.findMany({
    where: eq(digestSettings.enabled, true),
    with: { organization: true },
  });

  // Process all orgs concurrently — one failure won't block others
  await Promise.allSettled(
    settings.map(async (setting) => {
      try {
        if (setting.dayOfWeek !== currentDay) return;
        if (setting.hourOfDay !== currentHour) return;

        // Atomic claim: update lastSentAt only if it hasn't been set in the past
        // 50 minutes. If 0 rows are returned, another process already claimed this
        // tick — skip to prevent duplicate emails in multi-instance deployments.
        const claimed = await db
          .update(digestSettings)
          .set({ lastSentAt: now, updatedAt: now })
          .where(
            sql`${digestSettings.id} = ${setting.id} AND (${digestSettings.lastSentAt} IS NULL OR ${digestSettings.lastSentAt} < NOW() - INTERVAL '50 minutes')`,
          )
          .returning({ id: digestSettings.id });

        if (claimed.length === 0) {
          log.info(
            `Skipping org ${setting.organizationId} — already claimed by another process`,
          );
          return;
        }

        const org = setting.organization;

        log.info(`Sending weekly digest to org "${org.name}" (${org.id})`);

        const data = await collectDigestData(org.id, org.name);

        emit(org.id, {
          type: "digest.weekly",
          title: `Weekly Digest — ${org.name}`,
          message: `Weekly health summary for ${org.name}: ${data.deploys.total} deploys, ${data.deploys.failed} failures.`,
          orgName: org.name,
          weekLabel: data.weekLabel,
          deploysTotal: data.deploys.total,
          deploysSucceeded: data.deploys.succeeded,
          deploysFailed: data.deploys.failed,
          backupsTotal: data.backups.total,
          backupsFailed: data.backups.failed,
          cronTotal: data.cron.totalFailures,
          cronFailed: data.cron.totalFailures,
        });

        log.info(`Digest sent for org "${org.name}"`);
      } catch (err) {
        log.error(
          `Error sending digest for org ${setting.organizationId}:`,
          err,
        );
      }
    }),
  );
}
