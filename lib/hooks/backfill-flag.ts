// ---------------------------------------------------------------------------
// Hooks flag backfill
//
// The hooks feature ships off. An install that already has registrations was
// running them, so turn it on there once rather than stopping them silently.
// system_settings values are encrypted at rest, so this can't be a SQL migration.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  getFeatureFlagLayers,
  getSystemSettingRaw,
  setSystemSetting,
  invalidateSettingsCache,
} from "@/lib/system-settings";
import { invalidateFlagCache } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("hooks");

/** Marker setting recording that the backfill has run. */
const MARKER_KEY = "hooks_flag_backfilled";

/** Enable hooks where registrations already exist. Runs once per install. */
export async function backfillHooksFlag(): Promise<void> {
  if (await getSystemSettingRaw(MARKER_KEY)) return;

  const registration = await db.query.hookRegistrations.findFirst({
    columns: { id: true },
  });

  if (registration) {
    const { database } = await getFeatureFlagLayers();
    if (!("hooks" in database)) {
      await setSystemSetting("feature_flags", JSON.stringify({ ...database, hooks: true }));
      invalidateSettingsCache("feature_flags");
      await invalidateFlagCache();
      log.info("Enabled hooks — this install already has hook registrations");
    }
  }

  await setSystemSetting(MARKER_KEY, new Date().toISOString());
}
