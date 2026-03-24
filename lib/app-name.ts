/**
 * Default app name used across the UI, emails, and metadata when not configured.
 *
 * This lives in its own file because client components import it. If it
 * shared a file with server-only code (db, fs), Turbopack would pull the
 * entire server dependency graph into client bundles and the app crashes
 * with "Module not found: Can't resolve 'fs'".
 */
export const DEFAULT_APP_NAME = "Vardo";
