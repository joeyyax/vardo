// The until_clear throttle: one row per org, alert type and subject in `notification_send`.

import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationSends } from "@/lib/db/schema";
import { severityRank, type AlertSeverity } from "./registry";

const HOUR_MS = 60 * 60 * 1000;

export type SendState = { sentAt: Date; clearedAt: Date | null; severity: string };

export type ClaimRequest = { about: string; severity: AlertSeverity; detail: unknown };

export type Claim = {
  about: string;
  /** The row before the claim, null when there was none. */
  previous: SendState | null;
};

export type Cleared = { about: string; severity: string; sentAt: Date; detail: unknown };

/** Due when never sent, worse than what was sent and still holding, or cleared and `minHours` past the last send. */
export function claimable(existing: SendState | null, severity: AlertSeverity, now: Date, minHours: number): boolean {
  if (!existing) return true;
  if (existing.clearedAt === null) return severityRank(severity) > severityRank(existing.severity);
  return now.getTime() - existing.sentAt.getTime() >= minHours * HOUR_MS;
}

function key(organizationId: string, type: string, about: string) {
  return and(
    eq(notificationSends.organizationId, organizationId),
    eq(notificationSends.type, type),
    eq(notificationSends.about, about),
  );
}

/** Claims each subject that's due. A concurrent claim on the same row loses. */
export async function claimNotifications(
  organizationId: string,
  type: string,
  requests: ClaimRequest[],
  minHours: number,
  now: Date,
): Promise<Claim[]> {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.about)) continue;
    seen.add(request.about);

    const [existing] = await db
      .select({ sentAt: notificationSends.sentAt, clearedAt: notificationSends.clearedAt, severity: notificationSends.severity })
      .from(notificationSends)
      .where(key(organizationId, type, request.about))
      .limit(1);

    if (!claimable(existing ?? null, request.severity, now, minHours)) continue;

    if (!existing) {
      const inserted = await db
        .insert(notificationSends)
        .values({ organizationId, type, about: request.about, severity: request.severity, sentAt: now, detail: request.detail })
        .onConflictDoNothing()
        .returning({ about: notificationSends.about });
      if (inserted.length > 0) claims.push({ about: request.about, previous: null });
      continue;
    }

    const updated = await db
      .update(notificationSends)
      .set({ sentAt: now, clearedAt: null, severity: request.severity, detail: request.detail })
      .where(and(key(organizationId, type, request.about), eq(notificationSends.sentAt, existing.sentAt)))
      .returning({ about: notificationSends.about });
    if (updated.length > 0) claims.push({ about: request.about, previous: existing });
  }
  return claims;
}

/** Clears every subject of the type that no longer holds, so it can send again. Returns what cleared. */
export async function clearNotifications(
  organizationId: string,
  type: string,
  holding: string[],
  now: Date,
): Promise<Cleared[]> {
  return db
    .update(notificationSends)
    .set({ clearedAt: now })
    .where(
      and(
        eq(notificationSends.organizationId, organizationId),
        eq(notificationSends.type, type),
        isNull(notificationSends.clearedAt),
        holding.length > 0 ? notInArray(notificationSends.about, holding) : undefined,
      ),
    )
    .returning({
      about: notificationSends.about,
      severity: notificationSends.severity,
      sentAt: notificationSends.sentAt,
      detail: notificationSends.detail,
    });
}
