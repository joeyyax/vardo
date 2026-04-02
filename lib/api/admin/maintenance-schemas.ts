import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared validation schemas for the maintenance API
//
// Exported here so both the route handlers and tests import from the same
// source — changes to these schemas are immediately reflected in tests.
// ---------------------------------------------------------------------------

/**
 * Parse a mount pair string into source and destination paths.
 * Supports both new "source:destination:ro" format and legacy single-path format.
 * Returns null for empty or "/dev/null" values.
 */
export function parseMountPair(
  value: string | undefined,
): { source: string; destination: string } | null {
  if (!value || value === "/dev/null") return null;

  // Strip :ro suffix if present (new format)
  const mountValue = value.endsWith(":ro") ? value.slice(0, -3) : value;

  const colonIndex = mountValue.indexOf(":");
  if (colonIndex === -1) {
    // Legacy single-path format — assume source = destination
    return { source: mountValue, destination: mountValue };
  }

  const source = mountValue.slice(0, colonIndex);
  const destination = mountValue.slice(colonIndex + 1);
  if (!source || !destination) return null;
  return { source, destination };
}

// Service names must match the vardo- prefix used in docker-compose.yml and
// satisfy docker compose naming rules (lowercase alphanumeric + hyphens).
export const SERVICE_NAME_RE = /^vardo-[a-z][a-z0-9-]*$/;

export const restartSchema = z.object({
  service: z
    .string()
    .regex(SERVICE_NAME_RE, "service must match vardo-<name> (lowercase alphanumeric with hyphens)")
    .optional(),
});

// Mount path values are written directly into .env. Empty string clears the
// mount. Non-empty values must be absolute paths with no newline characters
// (newlines would inject additional lines into the .env file).
export const mountPathField = z
  .string()
  .refine(
    (v) => v === "" || (v.startsWith("/") && !/[\n\r]/.test(v)),
    "path must be an absolute path without newline characters, or empty to clear",
  )
  .optional();

export const mountsSchema = z.object({
  vardoData: mountPathField,
  vardoProjects: mountPathField,
  vardoMount1: mountPathField,
  vardoMount2: mountPathField,
});
