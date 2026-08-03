// ---------------------------------------------------------------------------
// Persisted restart counts
//
// Docker's RestartCount costs an inspect per container, which a list page
// cannot pay once per row. The status reconciler stores it on the app row and
// list pages read it from here.
// ---------------------------------------------------------------------------

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";

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
