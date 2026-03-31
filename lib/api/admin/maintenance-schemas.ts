import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared validation schemas for the maintenance API
//
// Exported here so both the route handlers and tests import from the same
// source — changes to these schemas are immediately reflected in tests.
// ---------------------------------------------------------------------------

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
