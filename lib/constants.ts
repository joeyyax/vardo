// Client components import from "@/lib/app-name" directly.
export { DEFAULT_APP_NAME } from "@/lib/app-name";

import { logger } from "@/lib/logger";

const log = logger.child("instance-id");

// Shared per process. Cold multi-worker starts can cache different IDs; pin one in multi-worker setups.
let instanceIdPromise: Promise<string> | null = null;

/** Stable identity for this instance. Generates and persists a UUID on first use when none is configured. */
export async function getInstanceId(): Promise<string> {
  if (!instanceIdPromise) {
    instanceIdPromise = resolveInstanceId();
  }
  return instanceIdPromise;
}

async function resolveInstanceId(): Promise<string> {
  const { readVardoConfig } = await import("@/lib/config/vardo-config");

  const fileConfig = await readVardoConfig();
  if (fileConfig?.instance?.id) {
    return fileConfig.instance.id;
  }

  const envId = process.env.VARDO_INSTANCE_ID;
  if (envId) {
    return envId;
  }

  // Dynamic import avoids a cycle with system-settings.
  const { getSystemSettingRaw, setSystemSetting } = await import(
    "@/lib/system-settings"
  );

  const dbId = await getSystemSettingRaw("instance_id");
  if (dbId) {
    return dbId;
  }

  // Also fires after a DB reset, rotating the identity; warn so operators notice.
  const id = crypto.randomUUID();
  await setSystemSetting("instance_id", id);
  log.warn(
    `No instance ID configured — generated and persisted: ${id}. ` +
      "To pin a stable ID, set instance.id in vardo.yml or VARDO_INSTANCE_ID."
  );
  return id;
}
