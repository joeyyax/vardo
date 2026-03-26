// Re-export for server-side consumers that already import from here.
// Client components should import from "@/lib/app-name" directly.
export { DEFAULT_APP_NAME } from "@/lib/app-name";

// Module-level promise cache so concurrent calls share one generation.
let instanceIdPromise: Promise<string> | null = null;

/** Stable identity for this instance. Auto-generated and persisted on first use. */
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

  const id = crypto.randomUUID();
  await setSystemSetting("instance_id", id);
  return id;
}
