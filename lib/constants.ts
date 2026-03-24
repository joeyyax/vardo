// Re-export for server-side consumers that already import from here.
// Client components should import from "@/lib/app-name" directly.
export { DEFAULT_APP_NAME } from "@/lib/app-name";

/** Stable identity for this instance. Generated at install time, never changes. */
export async function getInstanceId(): Promise<string> {
  const { readVardoConfig } = await import("@/lib/config/vardo-config");

  const fileConfig = await readVardoConfig();
  if (fileConfig?.instance?.id) {
    return fileConfig.instance.id;
  }

  const id = process.env.VARDO_INSTANCE_ID;
  if (!id) {
    throw new Error(
      "Instance ID not set. Add instance.id to vardo.yml or set VARDO_INSTANCE_ID."
    );
  }
  return id;
}
