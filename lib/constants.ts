// Re-export for server-side consumers that already import from here.
// Client components should import from "@/lib/app-name" directly.
export { DEFAULT_APP_NAME } from "@/lib/app-name";

import { logger } from "@/lib/logger";

const log = logger.child("instance-id");

// Module-level promise cache so concurrent calls within a single process share
// one generation. Known limitation: in multi-worker deployments (cluster, PM2,
// multiple containers) two workers starting cold with an empty DB can race and
// each cache a different in-memory value until the next restart. The DB upsert
// ensures a single UUID wins on disk, but workers won't converge until
// restarted. Pin the ID via vardo.yml or VARDO_INSTANCE_ID in multi-worker
// setups to avoid this.
let instanceIdPromise: Promise<string> | null = null;

/**
 * Stable identity for this instance. Auto-generated and persisted on first use.
 *
 * This is a "get or create" operation, not a pure read — the first call when
 * no ID is configured writes a generated UUID to system_settings. This side
 * effect is intentional: operators who forget to configure an ID get a working
 * default rather than a broken startup. A warning is emitted so the generation
 * is visible in logs.
 */
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

  // Dynamic import avoids a circular dependency: system-settings imports
  // DEFAULT_APP_NAME from this module, so we cannot import it statically here.
  const { getSystemSettingRaw, setSystemSetting } = await import(
    "@/lib/system-settings"
  );

  const dbId = await getSystemSettingRaw("instance_id");
  if (dbId) {
    return dbId;
  }

  // No ID found in config, env, or DB — generate one now and persist it.
  // This also fires on DB reset (truncate, migration rollback, restore from
  // backup), silently rotating the instance identity. Log loudly so operators
  // notice and can take corrective action.
  const id = crypto.randomUUID();
  await setSystemSetting("instance_id", id);
  log.warn(
    `No instance ID configured — generated and persisted: ${id}. ` +
      "To pin a stable ID, set instance.id in vardo.yml or VARDO_INSTANCE_ID."
  );
  return id;
}
