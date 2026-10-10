// Removes a decomposed compose child record. Containers, volumes and the parent's directory stay on disk.

import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { deleteEmptyAutoJobs } from "@/lib/backups/auto-backup";
import { deleteAppSeries } from "@/lib/metrics/series-cleanup";
import { logger } from "@/lib/logger";

const log = logger.child("compose-child-remove");

export type RemovableChild = { id: string; name: string; composeService: string | null };

/** Delete the child's app row; its volume rows go too unless shared or still mounted, which move to the parent. */
export async function removeComposeChild(opts: {
  child: RemovableChild;
  service: string;
  parentAppId: string;
  organizationId: string;
  /** Named volumes still mounted by the services left in the compose file. */
  mountedVolumes: Set<string>;
}): Promise<void> {
  const { child, service, parentAppId, organizationId, mountedVolumes } = opts;

  const rows = await db.query.volumes.findMany({ where: eq(volumes.appId, child.id) });
  const retained = rows.filter(
    (v) => v.shared || mountedVolumes.has(v.name) || (v.source != null && mountedVolumes.has(v.source)),
  );
  if (retained.length > 0) {
    const parentRows = await db.query.volumes.findMany({
      where: eq(volumes.appId, parentAppId),
      columns: { name: true, mountPath: true },
    });
    const taken = new Set(parentRows.flatMap((v) => [`n:${v.name}`, `m:${v.mountPath}`]));
    for (const v of retained) {
      // The parent already tracks it; the duplicate goes with the child.
      if (taken.has(`n:${v.name}`) || taken.has(`m:${v.mountPath}`)) continue;
      await db.update(volumes).set({ appId: parentAppId }).where(eq(volumes.id, v.id));
    }
  }

  await db.delete(apps).where(and(eq(apps.id, child.id), eq(apps.organizationId, organizationId)));

  try {
    await deleteEmptyAutoJobs(organizationId, [child.name]);
    await deleteAppSeries({ projects: [], appIds: [child.id] });
  } catch (err) {
    log.warn(`Could not clean up after removing ${child.name}:`, err);
  }

  try {
    await recordActivity({
      organizationId,
      action: "app.deleted",
      metadata: {
        name: child.name,
        source: "system",
        reason: "service no longer in compose",
        composeService: service,
        parentAppId,
        deleteVolumes: false,
        removedVolumes: [],
        keptVolumes: [],
      },
    });
  } catch (err) {
    log.warn(`Could not record the removal of ${child.name}:`, err);
  }
}
