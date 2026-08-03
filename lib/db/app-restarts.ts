// ---------------------------------------------------------------------------
// Persisted restart counts
//
// Docker's RestartCount costs an inspect per container, which a list page
// cannot pay once per row. The status reconciler stores it on the app row and
// every surface — list rows, the stability route — reads it from here, so no
// two of them can disagree about what an app's counter says.
// ---------------------------------------------------------------------------

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import type { RestartReading } from "@/lib/ui/stability";

/**
 * The two columns the reconciler writes as a reading, or null when there was no
 * counter to read. Zero is a reading like any other and never stands in for the
 * absence of one.
 */
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

/**
 * Last restart count read for each app, keyed by app id. An app Docker had no
 * counter for is absent rather than zero, so a caller that renders a missing
 * key shows nothing instead of a clean bill of health.
 *
 * Takes ids the caller has already scoped to its organization.
 */
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
