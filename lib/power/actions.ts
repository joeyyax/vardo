// What the power policies did: one row per action, with a notice to every org.

import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { powerActions, type PowerActionDetail, type PowerActionKind, type PowerActionRow } from "@/lib/db/schema";
import { emit } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

const log = logger.child("power");

/** A repeating action in one outage sends at most one notice in this window. */
export const NOTICE_THROTTLE_MS = 30 * 60_000;

export type PowerActionInput = {
  kind: PowerActionKind;
  title: string;
  message: string;
  outage: string | null;
  count: number;
  detail?: PowerActionDetail;
  /** "throttled" folds repeats in the same outage into the last notice. */
  notify: "always" | "throttled" | "never";
};

async function notifiedRecently(kind: PowerActionKind, outage: string | null, now: Date): Promise<boolean> {
  const recent = await db.query.powerActions.findFirst({
    where: and(
      eq(powerActions.kind, kind),
      outage ? eq(powerActions.outageStartedAt, new Date(outage)) : undefined,
      isNotNull(powerActions.notifiedAt),
      gt(powerActions.notifiedAt, new Date(now.getTime() - NOTICE_THROTTLE_MS)),
    ),
    columns: { id: true },
  });
  return !!recent;
}

/** Records the action and sends its notice. Never throws. */
export async function recordPowerAction(input: PowerActionInput, now = new Date()): Promise<void> {
  try {
    const notify = input.notify === "always" || (input.notify === "throttled" && !(await notifiedRecently(input.kind, input.outage, now)));
    await db.insert(powerActions).values({
      id: nanoid(),
      kind: input.kind,
      title: input.title,
      message: input.message,
      outageStartedAt: input.outage ? new Date(input.outage) : null,
      notifiedAt: notify ? now : null,
      detail: input.detail ?? null,
      createdAt: now,
    });
    log.info(`${input.title}: ${input.message}`);
    if (!notify) return;
    const orgs = await db.query.organizations.findMany({ columns: { id: true } });
    for (const org of orgs) {
      emit(org.id, {
        type: "system.power-action",
        title: input.title,
        message: input.message,
        action: input.kind,
        count: input.count,
        ...(input.detail?.names?.length ? { names: input.detail.names } : {}),
      });
    }
  } catch (err) {
    log.error(`Couldn't record the power action "${input.title}":`, err);
  }
}

/** The newest actions first. */
export async function listPowerActions(limit = 20): Promise<PowerActionRow[]> {
  return db.select().from(powerActions).orderBy(desc(powerActions.createdAt)).limit(limit);
}

/** Whether the stop pass already ran in this outage. */
export async function stopPassRan(outage: string): Promise<boolean> {
  const row = await db.query.powerActions.findFirst({
    where: and(eq(powerActions.kind, "apps-stopped"), eq(powerActions.outageStartedAt, new Date(outage))),
    columns: { id: true },
  });
  return !!row;
}
