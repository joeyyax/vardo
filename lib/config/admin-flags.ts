/**
 * Feature flags exposed in the admin settings UI.
 * Separated from features.ts to avoid pulling server-only modules
 * into client components via Turbopack's module graph tracing.
 *
 * Keep in sync: when you add a flag to FLAG_CONFIG in features.ts,
 * add it here too (unless it's "ui", which is a hard kill switch).
 */
export const ADMIN_FLAGS = [
  "terminal",
  "environments",
  "backups",
  "cron",
  "passwordAuth",
  "mesh",
  "bindMounts",
  "selfManagement",
] as const;
