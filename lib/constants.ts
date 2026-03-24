import { readVardoConfig } from "@/lib/config/vardo-config";

/** Default app name used across the UI, emails, and metadata when not configured. */
export const DEFAULT_APP_NAME = "Vardo";

/** Stable identity for this instance. Generated at install time, never changes. */
export async function getInstanceId(): Promise<string> {
  // Config file takes priority
  const fileConfig = await readVardoConfig();
  if (fileConfig?.instance?.id) {
    return fileConfig.instance.id;
  }

  // Env var fallback — infrastructure-level, kept for install compatibility
  const id = process.env.VARDO_INSTANCE_ID;
  if (!id) {
    throw new Error(
      "Instance ID not set. Add instance.id to vardo.yml or set VARDO_INSTANCE_ID."
    );
  }
  return id;
}
