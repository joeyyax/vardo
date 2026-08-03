// ---------------------------------------------------------------------------
// GlitchTip retirement
//
// GlitchTip is no longer a core service. Its rows stay pinned as system-managed,
// which refuses delete — so unpin them once and hand the stack back. Containers
// and volumes are left alone.
// ---------------------------------------------------------------------------

import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/** Marker setting recording that the retirement has run. */
const MARKER_KEY = "glitchtip_retired";

/** Release the GlitchTip app rows Vardo used to manage. Runs once per install. */
export async function retireGlitchTip(): Promise<void> {
  if (await getSystemSettingRaw(MARKER_KEY)) return;

  const app = await db.query.apps.findFirst({
    where: and(eq(apps.name, "glitchtip"), isNull(apps.parentAppId)),
    columns: { id: true, projectId: true, isSystemManaged: true },
  });

  if (app?.isSystemManaged) {
    await db
      .update(apps)
      .set({ isSystemManaged: false, updatedAt: new Date() })
      .where(or(eq(apps.id, app.id), eq(apps.parentAppId, app.id)));
    await db
      .update(projects)
      .set({ isSystemManaged: false, updatedAt: new Date() })
      .where(eq(projects.id, app.projectId));
    log.info("Retired GlitchTip — stop and remove it whenever you like");
  }

  await setSystemSetting(MARKER_KEY, new Date().toISOString());
}
