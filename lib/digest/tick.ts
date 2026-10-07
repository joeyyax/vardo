import { db } from "@/lib/db";
import { digestSettings } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { emit } from "@/lib/notifications/dispatch";
import { collectDigestData } from "./collector";
import { logger } from "@/lib/logger";

const log = logger.child("digest");

/** Send the digest for every org that's due. Runs every minute. */
export async function tickDigestJobs(): Promise<void> {
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0 = Sunday
  const currentHour = now.getUTCHours();
  // Fire only in minutes 0-4 of the hour.
  const currentMinute = now.getUTCMinutes();
  if (currentMinute >= 5) return;

  const settings = await db.query.digestSettings.findMany({
    where: eq(digestSettings.enabled, true),
    with: { organization: true },
  });

  await Promise.allSettled(
    settings.map(async (setting) => {
      try {
        if (setting.dayOfWeek !== currentDay) return;
        if (setting.hourOfDay !== currentHour) return;

        // Atomic claim; zero rows means another instance already sent this digest.

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
