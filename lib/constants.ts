/** Default app name used across the UI, emails, and metadata when not configured. */
export const DEFAULT_APP_NAME = "Vardo";

/** Stable identity for this instance. Generated at install time, never changes. */
export function getInstanceId(): string {
  const id = process.env.VARDO_INSTANCE_ID;
  if (!id) {
    throw new Error(
      "VARDO_INSTANCE_ID is not set. Run install.sh or set it manually: uuidgen | tr '[:upper:]' '[:lower:]'"
    );
  }
  return id;
}
