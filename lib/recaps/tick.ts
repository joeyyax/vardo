// Arms a new app's recaps on its first production deploy, and sends the due ones, one email per org per pass.

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appRecaps, apps, environments, organizations } from "@/lib/db/schema";
import type { AppRecap } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { getInstanceTimeZone, getOrgTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";
import { logger } from "@/lib/logger";
import { collectRecap, volumeSizes } from "./collect";
import { RECAP_KINDS, recapDueAt, recapEligible, recapStillWanted, type RecapKind } from "./schedule";

const log = logger.child("recaps");

/**
 * Schedules both recaps after an app's first successful production deploy. Returns when the 72-hour one
 * sends, or undefined when the app gets none or it already went out.
 */
export async function scheduleRecaps(
  appId: string,
  deploy: { environmentId: string | null; groupEnvironmentId: string | null },
  deployedAt = new Date(),
): Promise<Date | undefined> {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { id: true, organizationId: true, parentAppId: true, isSystemManaged: true },
    with: { organization: { columns: { isSystemManaged: true } } },
  });
  if (!app) return undefined;
  const env = deploy.environmentId
    ? await db.query.environments.findFirst({ where: eq(environments.id, deploy.environmentId), columns: { type: true } })
    : null;
  const eligible = recapEligible({
    parentAppId: app.parentAppId,
    isSystemManaged: app.isSystemManaged,
    orgIsSystemManaged: app.organization?.isSystemManaged ?? false,
    environmentType: env?.type ?? null,
    groupEnvironmentId: deploy.groupEnvironmentId,
  });
  if (!eligible) return undefined;

  const tz = await getOrgTimeZone(app.organizationId);
  await db
    .insert(appRecaps)
    .values(RECAP_KINDS.map((kind) => ({ appId, organizationId: app.organizationId, kind, deployedAt, dueAt: recapDueAt(deployedAt, kind, tz) })))
    .onConflictDoNothing();
  const first = await db.query.appRecaps.findFirst({ where: and(eq(appRecaps.appId, appId), eq(appRecaps.kind, "72h")) });
  return first && !first.outcome ? first.dueAt : undefined;
}

type DueRow = { appId: string; organizationId: string; kind: RecapKind; deployedAt: Date; status: string; parked: boolean };

export type RecapPlan = {
  /** Apps stopped or gone before their recap. */
  stop: DueRow[];
  /** A 72-hour recap overdue past its app's 30-day one: the 30-day one stands in. */
  skip: DueRow[];
  send: Map<string, DueRow[]>;
};

/** What each due row does, grouped by org. */
export function planRecaps(rows: DueRow[]): RecapPlan {
  const plan: RecapPlan = { stop: [], skip: [], send: new Map() };
  const monthDue = new Set(rows.filter((r) => r.kind === "30d").map((r) => r.appId));
  for (const row of rows) {
    if (!recapStillWanted(row.status, row.parked)) plan.stop.push(row);
    else if (row.kind === "72h" && monthDue.has(row.appId)) plan.skip.push(row);
    else plan.send.set(row.organizationId, [...(plan.send.get(row.organizationId) ?? []), row]);
  }
  return plan;
}

const rowKey = (r: { appId: string; kind: string }) => sql`(${appRecaps.appId}, ${appRecaps.kind}) = (${r.appId}, ${r.kind})`;

/** Finishes pending rows. Returns the ones this call finished, so a second pass never repeats them. */
export async function finishRecaps(rows: { appId: string; kind: RecapKind }[], outcome: "sent" | "stopped" | "skipped", now: Date): Promise<{ appId: string; kind: RecapKind }[]> {
  if (!rows.length) return [];
  return db
    .update(appRecaps)
    .set({ outcome, finishedAt: now })
    .where(and(isNull(appRecaps.outcome), or(...rows.map(rowKey))))
    .returning({ appId: appRecaps.appId, kind: appRecaps.kind });
}

/** Sends every due recap. Rows are claimed before the email goes out, so a restart never sends one twice. */
export async function tickRecaps(now = new Date()): Promise<void> {
  const rows = await db
    .select({
      appId: appRecaps.appId,
      organizationId: appRecaps.organizationId,
      kind: appRecaps.kind,
      deployedAt: appRecaps.deployedAt,
      status: apps.status,
      parked: apps.parked,
    })
    .from(appRecaps)
    .innerJoin(apps, eq(apps.id, appRecaps.appId))
    .where(and(isNull(appRecaps.outcome), lte(appRecaps.dueAt, now)));
  if (!rows.length) return;

  const plan = planRecaps(rows);
  await finishRecaps(plan.stop, "stopped", now);
  await finishRecaps(plan.skip, "skipped", now);
  if (!plan.send.size) return;

  const orgIds = [...plan.send.keys()];
  const [orgs, instanceTz, sizes] = await Promise.all([
    db.query.organizations.findMany({ where: inArray(organizations.id, orgIds), columns: { id: true, name: true, timeZone: true } }),
    getInstanceTimeZone(),
    volumeSizes(),
  ]);

  for (const org of orgs) {
    const due = plan.send.get(org.id) ?? [];
    const tz = resolveTimeZone(org.timeZone, instanceTz);
    try {
      const recaps: AppRecap[] = [];
      for (const row of due) {
        const recap = await collectRecap(row, now, tz, sizes);
        if (recap) recaps.push(recap);
      }
      const claimed = await finishRecaps(due, "sent", now);
      const keys = new Set(claimed.map((c) => `${c.appId}:${c.kind}`));
      const sending = recaps.filter((r) => keys.has(`${r.appId}:${r.kind}`));
      if (!sending.length) continue;
      emit(org.id, {
        type: "digest.app-recap",
        title: sending.length === 1 ? `Recap: ${sending[0]!.appName}` : `Recaps: ${sending.length} apps`,
        message: `${sending.length === 1 ? sending[0]!.appName : `${sending.length} new apps`} reached a recap.`,
        orgName: org.name,
        recaps: sending,
      });
      log.info(`Sent ${sending.length} recap(s) to "${org.name}"`);
    } catch (err) {
      log.error(`Recaps for org ${org.id} failed:`, err);
    }
  }
}
