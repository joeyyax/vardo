// Restart counts the status reconciler stores on the app row. Every surface reads them from here.

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import type { RestartReading } from "@/lib/ui/stability";

/** The reconciler's restart columns as a reading, or null when there was no counter. */
export function restartReading(row: {
  containerRestartCount: number | null;
  containerRestartSince: Date | null;
}): RestartReading | null {
  if (row.containerRestartCount === null) return null;
  return {
    count: row.containerRestartCount,
    since: row.containerRestartSince?.toISOString() ?? null,
  };
}

/** Last restart count per app id. Apps without a counter are absent, not zero. Ids must be org-scoped. */
export async function restartCountsByApp(appIds: string[]): Promise<Map<string, number>> {
  if (appIds.length === 0) return new Map();

  const rows = await db.query.apps.findMany({
    where: inArray(apps.id, appIds),
    columns: { id: true, containerRestartCount: true },
  });

  return new Map(
    rows.flatMap(({ id, containerRestartCount }) =>
      containerRestartCount === null ? [] : [[id, containerRestartCount] as const],
    ),
  );
}
