import { and, eq, isNull, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { digestSettings } from "@/lib/db/schema";
import { emit } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { logger } from "@/lib/logger";
import { collectDigestData, digestEvent, hasActivity } from "./collector";
import { digestWindow, isDigestDue, scheduleFor } from "./window";
import { getInstanceTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";

const log = logger.child("digest");

/** Claims the window for the org. False when it already went out. */
async function claimWindow(organizationId: string, windowKey: string, now: Date): Promise<boolean> {
  await db.insert(digestSettings).values({ id: nanoid(), organizationId }).onConflictDoNothing();
  const claimed = await db
    .update(digestSettings)
    .set({ lastWindowKey: windowKey, lastSentAt: now, updatedAt: now })
    .where(
      and(
        eq(digestSettings.organizationId, organizationId),
        or(isNull(digestSettings.lastWindowKey), ne(digestSettings.lastWindowKey, windowKey)),
      ),
    )
    .returning({ id: digestSettings.id });
  return claimed.length > 0;
}

/** Sends each org's digest once per window, during its hour. Runs every minute. */
export async function tickDigestJobs(now = new Date()): Promise<void> {
  const [orgs, rows] = await Promise.all([
    db.query.organizations.findMany({ columns: { id: true, name: true, timeZone: true } }),
    db.query.digestSettings.findMany(),
  ]);
  const instanceTimeZone = await getInstanceTimeZone();
  const byOrg = new Map(rows.map((r) => [r.organizationId, r]));
  let hostOrgs: Set<string> | null = null;

  for (const org of orgs) {
    const row = byOrg.get(org.id);
    const schedule = scheduleFor(row);
    const tz = resolveTimeZone(org.timeZone, instanceTimeZone);
    if (!isDigestDue(schedule, now, tz)) continue;
    const window = digestWindow(schedule.cadence, now, tz);
    if (row?.lastWindowKey === window.windowKey) continue;

    try {
      if (!(await claimWindow(org.id, window.windowKey, now))) continue;
      hostOrgs ??= new Set(await adminOrgIds());
      const data = await collectDigestData(org.id, org.name, window, { withHost: hostOrgs.has(org.id), now });
      if (!hasActivity(data)) {
        log.info(`${window.windowKey} digest for "${org.name}": nothing happened, skipping`);
        continue;
      }
      emit(org.id, digestEvent(data));
      log.info(`Sent ${window.windowKey} digest to "${org.name}"`);
    } catch (err) {
      log.error(`Digest for org ${org.id} failed:`, err);
    }
  }
}
