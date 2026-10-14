import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { digestSettings, memberships, user, userDigestPreferences } from "@/lib/db/schema";
import type { DigestWatchedProject } from "@/lib/bus/events";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { mailContext } from "@/lib/notifications/mail-context";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import { sendEmail } from "@/lib/email/send";
import { volumeSizes } from "@/lib/recaps/collect";
import { logger } from "@/lib/logger";
import { collectDigestData, digestEvent, hasActivity, type DigestData } from "./collector";
import { collectWatchedProject, watchesByUser } from "./watch";
import { digestWindow, frequencyFor, isDigestDue, scheduleFor, type DigestCadence, type DigestWindow } from "./window";
import { getInstanceTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";

const log = logger.child("digest");

const CADENCES: DigestCadence[] = ["weekly", "monthly"];

type Member = { userId: string; email: string };

/** Members whose frequency is `cadence` and who haven't had this window. */
export function dueMembers(
  members: Member[],
  prefs: Map<string, { frequency: string; lastWindowKey: string | null }>,
  window: Pick<DigestWindow, "cadence" | "windowKey">,
): Member[] {
  return members.filter((m) => {
    const pref = prefs.get(m.userId);
    return frequencyFor(pref) === window.cadence && pref?.lastWindowKey !== window.windowKey;
  });
}

/** Claims the window for each member before anything sends, so a restart never sends one twice. Returns who it claimed. */
async function claimWindow(organizationId: string, userIds: string[], window: DigestWindow, now: Date): Promise<Set<string>> {
  await db
    .insert(userDigestPreferences)
    .values(userIds.map((userId) => ({ id: nanoid(), userId, organizationId })))
    .onConflictDoNothing();
  const claimed = await db
    .update(userDigestPreferences)
    .set({ lastWindowKey: window.windowKey, updatedAt: now })
    .where(
      and(
        eq(userDigestPreferences.organizationId, organizationId),
        inArray(userDigestPreferences.userId, userIds),
        eq(userDigestPreferences.frequency, window.cadence),
        or(isNull(userDigestPreferences.lastWindowKey), ne(userDigestPreferences.lastWindowKey, window.windowKey)),
      ),
    )
    .returning({ userId: userDigestPreferences.userId });
  return new Set(claimed.map((c) => c.userId));
}

async function sendWindow(org: { id: string; name: string }, window: DigestWindow, due: Member[], withHost: boolean, now: Date): Promise<number> {
  const claimed = await claimWindow(org.id, due.map((m) => m.userId), window, now);
  const recipients = due.filter((m) => claimed.has(m.userId));
  if (!recipients.length) return 0;

  const data = await collectDigestData(org.id, org.name, window, { withHost, now });
  if (!hasActivity(data)) {
    log.info(`${window.windowKey} digest for "${org.name}": nothing happened, skipping`);
    return 0;
  }
  return deliverDigests(org.id, window, data, recipients);
}

/** Emails one window's digest to each recipient, with the projects they watch. Returns how many went out. */
export async function deliverDigests(orgId: string, window: DigestWindow, data: DigestData, recipients: Member[]): Promise<number> {
  const [ctx, watches] = await Promise.all([mailContext(orgId), watchesByUser(orgId, recipients.map((m) => m.userId))]);
  let sizes: Promise<Map<string, number>> | undefined;
  const projects = new Map<string, Promise<DigestWatchedProject | null>>();
  const watched = (projectId: string) => {
    let p = projects.get(projectId);
    if (!p) {
      sizes ??= volumeSizes();
      p = sizes.then((s) => collectWatchedProject(orgId, projectId, window, s)).catch((err) => {
        log.warn(`Watched project ${projectId} unread: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      projects.set(projectId, p);
    }
    return p;
  };

  let sent = 0;
  for (const m of recipients) {
    try {
      const mine = (await Promise.all((watches.get(m.userId) ?? []).map(watched))).filter((w) => w !== null);
      const email = await renderNotificationEmail({ ...digestEvent(data), watched: mine }, ctx);
      if (!email) continue;
      const result = await sendEmail({ to: m.email, subject: email.subject, html: email.html, text: email.text });
      if (result.success) sent += 1;
      else log.warn(`Digest to ${m.userId} rejected: ${result.error ?? "unknown"}`);
    } catch (err) {
      log.error(`Digest to ${m.userId} failed:`, err);
    }
  }
  return sent;
}

/** Sends each member their digest once per window, during the org's hour. Runs every minute. */
export async function tickDigestJobs(now = new Date()): Promise<void> {
  const [orgs, rows] = await Promise.all([
    db.query.organizations.findMany({ columns: { id: true, name: true, timeZone: true } }),
    db.query.digestSettings.findMany(),
  ]);
  const instanceTimeZone = await getInstanceTimeZone();
  const byOrg = new Map(rows.map((r) => [r.organizationId, r]));
  let hostOrgs: Set<string> | null = null;

  for (const org of orgs) {
    const schedule = scheduleFor(byOrg.get(org.id));
    const tz = resolveTimeZone(org.timeZone, instanceTimeZone);
    const windows = CADENCES.filter((c) => isDigestDue(schedule, c, now, tz)).map((c) => digestWindow(c, now, tz));
    if (!windows.length) continue;

    try {
      const [members, prefRows] = await Promise.all([
        db
          .select({ userId: memberships.userId, email: user.email })
          .from(memberships)
          .innerJoin(user, eq(user.id, memberships.userId))
          .where(eq(memberships.organizationId, org.id)),
        db.query.userDigestPreferences.findMany({
          where: eq(userDigestPreferences.organizationId, org.id),
          columns: { userId: true, frequency: true, lastWindowKey: true },
        }),
      ]);
      const prefs = new Map(prefRows.map((p) => [p.userId, p]));
      for (const window of windows) {
        const due = dueMembers(members, prefs, window);
        if (!due.length) continue;
        hostOrgs ??= new Set(await adminOrgIds());
        const sent = await sendWindow(org, window, due, hostOrgs.has(org.id), now);
        if (!sent) continue;
        await db
          .insert(digestSettings)
          .values({ id: nanoid(), organizationId: org.id, lastSentAt: now })
          .onConflictDoUpdate({ target: digestSettings.organizationId, set: { lastSentAt: now } });
        log.info(`Sent ${window.windowKey} digest to ${sent} in "${org.name}"`);
      }
    } catch (err) {
      log.error(`Digest for org ${org.id} failed:`, err);
    }
  }
}
