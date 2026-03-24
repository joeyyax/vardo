/**
 * Default app name used across the UI, emails, and metadata when not configured.
 *
 * This lives in its own file because client components import it.
 * Turbopack follows all exports in a module — if this constant shared a file
 * with server-only code (db, fs), the entire server dependency graph would
 * get pulled into client bundles.
 */
export const DEFAULT_APP_NAME = "Vardo";
