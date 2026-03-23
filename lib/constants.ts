/** Default app name used across the UI, emails, and metadata when not configured. */
export const DEFAULT_APP_NAME = "Vardo";

/** Stable identity for this instance. Generated at install time, never changes. */
export const INSTANCE_ID = process.env.VARDO_INSTANCE_ID ?? "";
