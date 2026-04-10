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

// Mount values are written directly into .env. Empty string clears the
// mount. Non-empty values must be source:destination pairs with no newline
// characters (newlines would inject additional lines into the .env file).
// Source must be an absolute path. Destination must be an absolute path.
export const mountPairField = z
  .string()
  .refine(
    (v) => {
      if (v === "") return true;
      if (/[\n\r]/.test(v)) return false;
      const parts = v.split(":");
      if (parts.length !== 2) return false;
      const [source, destination] = parts;
      return source.startsWith("/") && destination.startsWith("/");
    },
    "must be a source:destination pair where both are absolute paths, or empty to clear",
  )
  .optional();

export const mountsSchema = z.object({
  vardoData: mountPairField,
  vardoProjects: mountPairField,
  vardoMount1: mountPairField,
  vardoMount2: mountPairField,
});
